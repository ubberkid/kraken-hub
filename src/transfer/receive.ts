/**
 * The receiving half of a LAN file transfer — the DISPLAY's side.
 *
 * ## Why the display and not the configuration window
 *
 * Because the display is the window that owns the store. CAM's hidden Kraken
 * Browser and its Configuration Browser share one storage partition, and the
 * display page is the one that is always running whenever there is anything to
 * receive; the configuration window may not be open at all. A file that landed
 * anywhere else would be a second library, which is the exact failure this whole
 * arc exists to remove.
 *
 * ## Nothing here is a second ingest path
 *
 * The assembled blob goes straight into `ingestBlob` / `ingestImageBlob` — the
 * same functions the file picker and the download manager end in. So a file sent
 * from a phone is probed the same way, thumbnailed the same way, quota-checked
 * the same way and rejected with the same words as a file dropped on CAM's own
 * Library page. There is exactly one way a byte becomes a row.
 *
 * ## Loaded lazily, on the first offer
 *
 * Exactly the seam `requestDiag` uses: everything below `import('./receive')` in
 * `app/display/sync.ts` is in this chunk, so the LCD's critical path does not
 * grow by a byte for a feature that fires when somebody points a phone at it.
 * `npm run size` proves it on every build.
 */

import { createLogger } from '../lib/log';

import {
  TRANSFER_ANSWER_KIND,
  TRANSFER_ICE_KIND,
  TRANSFER_ICE_MAX,
  TRANSFER_MAX_BYTES,
  TRANSFER_PROGRESS_KIND,
  TRANSFER_SIGNAL_INTERVAL_MS,
  TRANSFER_STUN_URLS,
  createAssembler,
  fitCandidates,
  isPictureFile,
  parseTransferIce,
  parseTransferOffer,
  type Assembler,
  type TransferProgressState,
  type TransferRefusal,
  type WireCandidate,
} from './protocol';

const log = createLogger('transfer/receive');

/** How often the receiver repeats its answer and its candidate list. */
const ANSWER_BEAT_MS = TRANSFER_SIGNAL_INTERVAL_MS;

/** Progress packets, throttled — the point is a moving bar, not a byte count. */
const PROGRESS_MS = 500;

export interface TransferReceiverOptions {
  /** Publish a `tele` body. The caller passes `immediate`, so nothing is coalesced away. */
  publish: (body: { ts: number; kind: string } & Record<string, unknown>) => void;
  /** Called once a file has actually become a library row. */
  onStored: () => void;
}

export interface TransferReceiver {
  /** Feed a `cmd` body. Anything that is not for us is ignored. */
  accept: (body: { op: string; arg?: unknown }) => void;
  stop: () => void;
}

interface Session {
  sid: string;
  name: string;
  size: number;
  mime: string;
  pc: RTCPeerConnection;
  assembler: Assembler;
  answerSdp: string | null;
  candidates: WireCandidate[];
  seen: Set<string>;
  beat: ReturnType<typeof setInterval> | null;
  lastProgressAt: number;
  finished: boolean;
}

/**
 * The quota gate, consulted BEFORE a byte moves.
 *
 * This is the round trip the design promises: the offer carries the size, the
 * display answers with a refusal instead of an SDP, and the phone says so
 * immediately rather than after two minutes of upload. `checkQuotaFor` is the
 * same function manual ingest uses, so the number and the sentence are the ones
 * the rest of the app would have produced.
 */
async function refuseFor(
  size: number,
): Promise<{ refused: TransferRefusal; detail: string } | null> {
  if (size > TRANSFER_MAX_BYTES) {
    return { refused: 'too-large', detail: 'That file is too large to send this way.' };
  }
  try {
    const { checkQuotaFor } = await import('../modules/video/local/clipStore');
    const verdict = await checkQuotaFor(size);
    if (!verdict.ok) {
      return { refused: 'quota', detail: verdict.message ?? 'There is not enough room for it.' };
    }
  } catch (err) {
    // A quota reading we could not take is not a reason to refuse somebody's
    // file — ingest checks again before it writes, and refusing on no data
    // helps nobody. Exactly `checkQuotaFor`'s own policy, one layer up.
    log.debug('could not read the quota before a transfer', err);
  }
  return null;
}

export function createTransferReceiver(o: TransferReceiverOptions): TransferReceiver {
  let session: Session | null = null;
  let stopped = false;
  // Read through a function so TypeScript cannot narrow it across an await —
  // the same trick `ModuleHost` and `useSync` use for their teardown flags. A
  // plain boolean narrows to `false` after the first check and every guard
  // after an `await` becomes dead code the linter is right to flag.
  const isStopped = (): boolean => stopped;

  const publishProgress = (s: Session, state: TransferProgressState, detail?: string): void => {
    o.publish({
      ts: Date.now(),
      kind: TRANSFER_PROGRESS_KIND,
      sid: s.sid,
      received: s.assembler.received,
      total: s.size,
      state,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const closeSession = (): void => {
    const s = session;
    session = null;
    if (s === null) return;
    if (s.beat !== null) clearInterval(s.beat);
    try {
      s.pc.close();
    } catch (err) {
      log.debug('closing a finished transfer threw', err);
    }
  };

  /**
   * The answer and the candidates, repeated until the channel is up.
   *
   * The mirror image of the sender's heartbeat, and for the same reason: the
   * signalling channel is a last-value slot, so the only safe message is one
   * that carries the whole current state and can be sent again harmlessly.
   */
  const beatOnce = (s: Session): void => {
    if (s.answerSdp !== null && !s.finished) {
      o.publish({ ts: Date.now(), kind: TRANSFER_ANSWER_KIND, sid: s.sid, sdp: s.answerSdp });
    }
    if (s.candidates.length > 0 && !s.finished) {
      o.publish({
        ts: Date.now(),
        kind: TRANSFER_ICE_KIND,
        sid: s.sid,
        candidates: fitCandidates(s.sid, s.candidates),
      });
    }
  };

  /**
   * The assembled file → a library row, through the ordinary front door.
   *
   * A picture and a clip take different ingest functions because they are
   * genuinely different acts — one probes a duration and draws a frame, the
   * other decodes an image — but both end in the same store, publish the same
   * index and produce the same tile.
   */
  const store = async (s: Session): Promise<void> => {
    publishProgress(s, 'storing');
    const blob = s.assembler.blob();
    try {
      if (isPictureFile(s.name, s.mime)) {
        const { ingestImageBlob } = await import('../modules/image/ingest');
        const result = await ingestImageBlob(blob, s.name);
        if (!result.ok) {
          publishProgress(s, 'failed', result.message ?? 'That file could not be added.');
          return;
        }
      } else {
        const { ingestBlob } = await import('../modules/video/local/ingest');
        // `force` because the probe already had its chance on the sending side's
        // own device and a file that will not report a duration over here still
        // usually plays. The alternative is an "Add anyway" button on a screen
        // that is in another room.
        const result = await ingestBlob(blob, s.name, { force: true });
        if (!result.ok) {
          publishProgress(s, 'failed', result.message ?? 'That file could not be added.');
          return;
        }
      }
      publishProgress(s, 'stored');
      o.onStored();
    } catch (err) {
      log.warn('a transferred file could not be stored', err);
      publishProgress(s, 'failed', 'That file could not be added.');
    }
  };

  const onChannel = (s: Session, channel: RTCDataChannel): void => {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      // The one non-binary message: the header. Everything the receiver needs is
      // already in the offer, so this is belt and braces — a sender whose name
      // or type differs from what it announced is believed about neither.
      if (typeof data === 'string') return;
      if (!(data instanceof ArrayBuffer)) return;
      if (s.finished) return;
      if (!s.assembler.push(data)) {
        s.finished = true;
        publishProgress(s, 'failed', 'That file did not arrive as it was announced.');
        closeSession();
        return;
      }
      const now = Date.now();
      if (now - s.lastProgressAt >= PROGRESS_MS) {
        s.lastProgressAt = now;
        publishProgress(s, 'receiving');
      }
      if (s.assembler.complete) {
        s.finished = true;
        if (s.beat !== null) clearInterval(s.beat);
        s.beat = null;
        void store(s).finally(() => {
          closeSession();
        });
      }
    };
    channel.onclose = () => {
      if (!s.finished) {
        publishProgress(s, 'failed', 'The connection closed before the file arrived.');
        closeSession();
      }
    };
  };

  const begin = async (offer: {
    sid: string;
    name: string;
    size: number;
    mime: string;
    sdp: string;
  }): Promise<void> => {
    const refusal = await refuseFor(offer.size);
    if (isStopped()) return;
    if (refusal !== null) {
      o.publish({
        ts: Date.now(),
        kind: TRANSFER_ANSWER_KIND,
        sid: offer.sid,
        refused: refusal.refused,
        detail: refusal.detail,
      });
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [{ urls: [...TRANSFER_STUN_URLS] }] });
    const s: Session = {
      sid: offer.sid,
      name: offer.name,
      size: offer.size,
      mime: offer.mime,
      pc,
      assembler: createAssembler({ size: offer.size, mime: offer.mime }),
      answerSdp: null,
      candidates: [],
      seen: new Set<string>(),
      beat: null,
      lastProgressAt: 0,
      finished: false,
    };
    session = s;

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (candidate === null || candidate.candidate === '') return;
      if (s.candidates.length >= TRANSFER_ICE_MAX) return;
      s.candidates.push({
        c: candidate.candidate,
        ...(candidate.sdpMid === null ? {} : { m: candidate.sdpMid }),
        ...(candidate.sdpMLineIndex === null ? {} : { i: candidate.sdpMLineIndex }),
      });
      beatOnce(s);
    };
    pc.ondatachannel = (event) => {
      onChannel(s, event.channel);
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (isStopped() || session !== s) return;
    s.answerSdp = pc.localDescription?.sdp ?? answer.sdp ?? null;
    beatOnce(s);
    s.beat = setInterval(() => {
      beatOnce(s);
    }, ANSWER_BEAT_MS);
  };

  let starting = false;

  return {
    accept(body) {
      if (isStopped()) return;

      if (body.op === 'transferOffer') {
        const offer = parseTransferOffer(body.arg);
        if (offer === null) return;
        // The offer is repeated on a beat until it is answered, so the common
        // case here is a duplicate. Answering it again is exactly right — the
        // answer is idempotent, and the repeat exists because the previous one
        // may have been written over.
        if (session !== null && session.sid === offer.sid) {
          beatOnce(session);
          return;
        }
        if (session !== null) {
          o.publish({
            ts: Date.now(),
            kind: TRANSFER_ANSWER_KIND,
            sid: offer.sid,
            refused: 'busy',
            detail: 'Your Kraken is already receiving a file.',
          });
          return;
        }
        if (starting) return;
        starting = true;
        void begin(offer)
          .catch((err: unknown) => {
            log.warn('could not accept a file transfer', err);
            closeSession();
          })
          .finally(() => {
            starting = false;
          });
        return;
      }

      if (body.op === 'transferIce') {
        const ice = parseTransferIce(body.arg);
        const s = session;
        if (ice === null || s === null) return;
        if (s.sid !== ice.sid) return;
        for (const candidate of ice.candidates) {
          if (s.seen.has(candidate.c)) continue;
          s.seen.add(candidate.c);
          void s.pc
            .addIceCandidate({
              candidate: candidate.c,
              ...(candidate.m === undefined ? {} : { sdpMid: candidate.m }),
              ...(candidate.i === undefined ? {} : { sdpMLineIndex: candidate.i }),
            })
            .catch((err: unknown) => {
              log.debug('a candidate was refused', err);
            });
        }
      }
    },

    stop() {
      stopped = true;
      closeSession();
    },
  };
}
