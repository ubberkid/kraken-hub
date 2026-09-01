/**
 * The sending half of a LAN file transfer — the phone's side.
 *
 * It knows nothing about React, about the sync service or about the vocabulary:
 * it is handed a `sendCmd`, a tele subscription and four callbacks, which is
 * what lets the same code be driven by the remote screen, by a test, or by
 * whatever surface comes next. It is also what keeps this file out of the
 * configuration UI's chunk graph, so the display can import its sibling
 * `receive.ts` without dragging `src/ui` onto the LCD's critical path.
 *
 * ## The shape of the conversation
 *
 *   phone                                   display
 *   ─────                                   ───────
 *   createDataChannel + offer
 *   cmd  transferOffer {sid,name,size,sdp} →
 *                                            quota + size checked FIRST
 *                                          ← tele transferAnswer {sid,sdp}
 *                                            …or {sid,refused}
 *   cmd  transferIce {sid,candidates[]}   ↔  tele transferIce {sid,candidates[]}
 *   ── data channel opens ──────────────────────────────────────────────────
 *   header JSON, then 16 KB chunks        →  assembled, then ORDINARY ingest
 *                                          ← tele transferProgress {…,'stored'}
 *
 * Everything before the data channel opens is repeated on a slow beat and is
 * cumulative, because the signalling channel is a last-value slot rather than a
 * queue — see `protocol.ts`. Everything after it is ordinary SCTP: ordered,
 * reliable, and the only thing we have to get right is backpressure.
 */

import { createLogger } from '../lib/log';

import {
  TRANSFER_BUFFER_HIGH_BYTES,
  TRANSFER_BUFFER_LOW_BYTES,
  TRANSFER_CHANNEL_LABEL,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_ICE_MAX,
  TRANSFER_MAX_BYTES,
  TRANSFER_SIGNAL_INTERVAL_MS,
  TRANSFER_STORE_TIMEOUT_MS,
  TRANSFER_STUN_URLS,
  TRANSFER_TIMEOUT_MS,
  fitCandidates,
  parseTransferAnswer,
  parseTransferIce,
  parseTransferProgress,
  shouldPause,
  type TransferRefusal,
  type WireCandidate,
} from './protocol';

const log = createLogger('transfer/send');

/** What the UI needs to draw, at any moment. */
export type SendPhase = 'connecting' | 'sending' | 'storing' | 'done' | 'failed';

export interface SendStatus {
  phase: SendPhase;
  sentBytes: number;
  totalBytes: number;
  /** Set only on `failed`, and only ever a machine reason — the copy is the UI's. */
  refusal: TransferRefusal | 'unreachable' | 'interrupted' | null;
  /** A sentence the display supplied, when it had one worth passing on. */
  detail: string | null;
}

export interface TransferSendOptions {
  file: File;
  sendCmd: (op: string, arg?: unknown) => void;
  /** Every `tele` body, as it lands. The handshake cannot survive React batching. */
  subscribeTele: (cb: (body: Record<string, unknown>) => void) => () => void;
  onStatus: (status: SendStatus) => void;
}

export interface TransferSendHandle {
  readonly sid: string;
  cancel(): void;
}

/**
 * A short session id.
 *
 * Not a UUID: it is repeated inside every signalling message, several times a
 * second, inside an 8 KB envelope, and twelve hex characters is already far more
 * collision resistance than "two transfers in one room at the same moment"
 * needs. Its job is to let a peer tell one conversation from the next, not to be
 * unique on the internet.
 */
function newSid(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** The one message on the data channel that is not bytes: what is coming. */
export interface TransferHeader {
  name: string;
  size: number;
  mime: string;
}

export function startTransferSend(o: TransferSendOptions): TransferSendHandle {
  const sid = newSid();
  const total = o.file.size;

  let phase: SendPhase = 'connecting';
  let sent = 0;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let answered = false;
  let open = false;
  /*
   * Read through functions so TypeScript cannot narrow them across an `await` —
   * the same trick `ModuleHost` and `useSync` use for their teardown flags. A
   * plain boolean narrows after the first check and every guard inside the send
   * loop becomes dead code the linter is right to flag.
   */
  const isStopped = (): boolean => stopped;
  const isShut = (): boolean => channel.readyState !== 'open';
  const mine: WireCandidate[] = [];
  const theirs = new Set<string>();

  const report = (
    next: SendPhase,
    extra: { refusal?: SendStatus['refusal']; detail?: string | null } = {},
  ): void => {
    phase = next;
    o.onStatus({
      phase,
      sentBytes: sent,
      totalBytes: total,
      refusal: extra.refusal ?? null,
      detail: extra.detail ?? null,
    });
  };

  const pc = new RTCPeerConnection({ iceServers: [{ urls: [...TRANSFER_STUN_URLS] }] });
  const channel = pc.createDataChannel(TRANSFER_CHANNEL_LABEL, { ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = TRANSFER_BUFFER_LOW_BYTES;

  const teardown = (): void => {
    stopped = true;
    if (beat !== null) clearInterval(beat);
    beat = null;
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    unsubscribe?.();
    unsubscribe = null;
    try {
      channel.close();
      pc.close();
    } catch (err) {
      log.debug('closing a finished transfer threw', err);
    }
  };

  const fail = (refusal: SendStatus['refusal'], detail: string | null = null): void => {
    if (stopped || phase === 'done' || phase === 'failed') return;
    teardown();
    report('failed', { refusal, detail });
  };

  /*
   * The heartbeat.
   *
   * One timer says everything that still needs saying: the offer until it is
   * answered, and the candidate list until the channel is open. Both messages
   * are the complete current state rather than a delta, so a beat that is
   * dropped by the last-value slot costs nothing at all — the next one carries
   * the same thing.
   */
  const beatOnce = (): void => {
    if (stopped) return;
    const local = pc.localDescription;
    if (!answered && local !== null) {
      o.sendCmd('transferOffer', {
        sid,
        name: o.file.name,
        size: total,
        mime: o.file.type,
        sdp: local.sdp,
      });
    }
    if (!open && mine.length > 0) {
      o.sendCmd('transferIce', { sid, candidates: fitCandidates(sid, mine) });
    }
  };

  pc.onicecandidate = (event) => {
    const candidate = event.candidate;
    if (candidate === null || candidate.candidate === '') return;
    if (mine.length >= TRANSFER_ICE_MAX) return;
    mine.push({
      c: candidate.candidate,
      ...(candidate.sdpMid === null ? {} : { m: candidate.sdpMid }),
      ...(candidate.sdpMLineIndex === null ? {} : { i: candidate.sdpMLineIndex }),
    });
    beatOnce();
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') fail('unreachable');
  };

  channel.onerror = () => {
    // `RTCErrorEvent` fires for a channel torn down under us as well as for a
    // genuine protocol error, and the two are indistinguishable from here. Both
    // mean the same thing to the person holding the phone.
    fail(open ? 'interrupted' : 'unreachable');
  };

  channel.onclose = () => {
    // Closed before the last byte landed: the receiving window went away.
    if (phase === 'sending' || phase === 'connecting') fail('interrupted');
  };

  /**
   * The stream, with the one thing that actually matters about it.
   *
   * `send()` never blocks, never refuses and never tells you it is drowning: it
   * queues. A naive `for` loop over a 400 MB file therefore allocates 400 MB of
   * SCTP buffer and takes the tab with it. So the loop stops at the high-water
   * mark and waits for `bufferedamountlow`, which is the whole of the
   * backpressure contract and is why `shouldPause` is a tested function rather
   * than an inline comparison.
   */
  const drain = async (): Promise<void> => {
    const waitForRoom = (): Promise<void> =>
      new Promise((resolve) => {
        const onLow = (): void => {
          channel.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', onLow);
      });

    while (sent < total) {
      if (isStopped() || isShut()) return;
      if (shouldPause(channel.bufferedAmount, TRANSFER_BUFFER_HIGH_BYTES)) {
        await waitForRoom();
        continue;
      }
      const slice = o.file.slice(sent, Math.min(sent + TRANSFER_CHUNK_BYTES, total));
      const bytes = await slice.arrayBuffer();
      if (isStopped() || isShut()) return;
      channel.send(bytes);
      sent += bytes.byteLength;
      report('sending');
    }
    /*
     * The last byte is not the end.
     *
     * The display still has to validate, thumbnail and write the file, and the
     * user's question is "is it in my library", not "did the radio finish". So
     * the sender waits for the receiver's own `stored` packet — and gives up
     * after a minute rather than spinning forever on a window that closed.
     */
    report('storing');
    deadline = setTimeout(() => {
      fail('interrupted');
    }, TRANSFER_STORE_TIMEOUT_MS);
  };

  channel.onopen = () => {
    open = true;
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const header: TransferHeader = { name: o.file.name, size: total, mime: o.file.type };
    channel.send(JSON.stringify(header));
    report('sending');
    void drain();
  };

  unsubscribe = o.subscribeTele((body) => {
    if (stopped) return;

    const answer = parseTransferAnswer(body);
    if (answer !== null && answer.sid === sid) {
      if (answer.refused !== undefined) {
        fail(answer.refused, answer.detail ?? null);
        return;
      }
      if (!answered && answer.sdp !== undefined) {
        answered = true;
        void pc
          .setRemoteDescription({ type: 'answer', sdp: answer.sdp })
          .then(() => {
            // Candidates that arrived before the answer did have nowhere to go
            // until now, which is why they are replayed rather than discarded.
            for (const line of theirs) {
              void pc.addIceCandidate({ candidate: line }).catch(() => undefined);
            }
          })
          .catch((err: unknown) => {
            log.warn('the answer could not be applied', err);
            fail('unreachable');
          });
      }
      return;
    }

    const ice = parseTransferIce(body);
    if (ice !== null && ice.sid === sid) {
      for (const candidate of ice.candidates) {
        if (theirs.has(candidate.c)) continue;
        theirs.add(candidate.c);
        if (pc.remoteDescription === null) continue;
        void pc
          .addIceCandidate({
            candidate: candidate.c,
            ...(candidate.m === undefined ? {} : { sdpMid: candidate.m }),
            ...(candidate.i === undefined ? {} : { sdpMLineIndex: candidate.i }),
          })
          .catch((err: unknown) => {
            log.debug('a candidate was refused', err);
          });
      }
      return;
    }

    const progress = parseTransferProgress(body);
    if (progress !== null && progress.sid === sid) {
      if (progress.state === 'stored') {
        teardown();
        report('done');
      } else if (progress.state === 'failed') {
        fail('unsupported', progress.detail ?? null);
      }
    }
  });

  if (total > TRANSFER_MAX_BYTES) {
    // Refused here rather than after a handshake: the display would say the same
    // thing, and the person is holding the phone that already knows the size.
    queueMicrotask(() => {
      fail('too-large');
    });
    return { sid, cancel: teardown };
  }

  deadline = setTimeout(() => {
    fail('unreachable');
  }, TRANSFER_TIMEOUT_MS);

  void (async () => {
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (isStopped()) return;
      beatOnce();
      beat = setInterval(beatOnce, TRANSFER_SIGNAL_INTERVAL_MS);
    } catch (err) {
      log.warn('could not create an offer', err);
      fail('unreachable');
    }
  })();

  report('connecting');

  return {
    sid,
    cancel: () => {
      teardown();
    },
  };
}
