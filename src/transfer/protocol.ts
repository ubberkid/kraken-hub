/**
 * LAN file transfer — the wire contract, and the arithmetic underneath it.
 *
 * ## What this is for
 *
 * A photo in a phone's camera roll cannot reach the Kraken's library by any
 * path the app had: the bytes have to land in CAM's browser profile, because
 * that is the only profile the hidden LCD page can read back, and a phone shares
 * nothing with it. Everything else about the shelf is already one shelf — the
 * phone sees every row and can play any of them — so this is the last genuinely
 * device-local thing, and it is device-local for a physical reason rather than
 * an architectural one.
 *
 * So the bytes go peer to peer, over WebRTC, on the LAN. **The DISPLAY is the
 * receiver**, because the display is the window that owns the store; the phone
 * is the sender. The assembled blob is then handed to the ordinary ingest
 * pipeline — validation, thumbnail, quota — exactly as if the file had been
 * dropped on CAM's own Library page. There is no second write path.
 *
 * ## Signalling rides the channel that already exists
 *
 * There is no signalling server and there will not be one. The offer, the answer
 * and the ICE candidates travel as ordinary `cmd`/`tele` bodies over the same
 * encrypted sync channel everything else uses, which buys three things for free:
 * the broker only ever sees ciphertext, only a peer holding the room key can
 * start a transfer, and a fork inherits all of it without configuring anything.
 *
 * Two properties of that channel shape this protocol completely:
 *
 *  1. **It is a LAST-VALUE SLOT, not a queue.** Both zero-network transports
 *     write one localStorage key per channel, and `SyncService.sendCmd`
 *     throttles per-op at 200 ms and DROPS what lands inside the window. A burst
 *     of trickle-ICE messages would therefore lose most of itself.
 *  2. **Nothing is acknowledged.**
 *
 * The answer to both is the same and it is why nothing here retransmits
 * *differences*: every signalling message is **cumulative and idempotent**. The
 * offer is re-sent on a slow beat until an answer arrives; an ICE message
 * carries every candidate gathered *so far*, not the new one; the receiver
 * de-duplicates by candidate string. A dropped message is not a lost candidate,
 * it is a message that was about to be superseded anyway.
 *
 * ## LAN-grade, and honest about it
 *
 * One STUN server and **no TURN**. STUN lets two peers on the same network find
 * each other's real addresses; TURN is a relay, which means somebody's server
 * carrying somebody's video, which this project is not going to run and cannot
 * honestly promise. So the failure copy names the actual constraint — the phone
 * and the PC have to be on the same network — and it is shown only on a genuine
 * failure or timeout, never as a pre-emptive warning about a thing that usually
 * works.
 *
 * This file is pure: constants, wire shapes, validators, the chunk arithmetic
 * and the assembler. Everything that needs an `RTCPeerConnection` lives in
 * `send.ts` and `receive.ts` beside it, so the parts that can be tested without
 * a browser are tested without one.
 */

/**
 * Bytes per DataChannel message.
 *
 * 16 KB is the largest message every WebRTC implementation is required to carry
 * without SCTP-level fragmentation problems, and it is what every file-transfer
 * example in the wild converges on. Larger messages do work in current Chromium
 * and would be faster; they also fail on the first peer that is not current
 * Chromium, which on a phone is not a hypothetical.
 */
export const TRANSFER_CHUNK_BYTES = 16 * 1024;

/**
 * The largest file this will carry.
 *
 * Not a protocol limit — a promise limit. Half a gigabyte over a LAN data
 * channel is a minute or two; ten gigabytes is a progress bar somebody watches
 * fail. The quota check below is the real gate, and it happens BEFORE a byte
 * moves.
 */
export const TRANSFER_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Backpressure, in bytes already queued on the channel.
 *
 * `send()` never blocks and never refuses: it buffers, and a loop that ignores
 * `bufferedAmount` will happily queue a 400 MB file into memory and take the tab
 * with it. So the sender stops at the high-water mark and resumes on
 * `bufferedamountlow`, which is what the low mark arms.
 */
export const TRANSFER_BUFFER_HIGH_BYTES = 1024 * 1024;
export const TRANSFER_BUFFER_LOW_BYTES = 256 * 1024;

/**
 * How often an unanswered signalling message is repeated.
 *
 * Comfortably clear of the 200 ms per-op command throttle (which drops rather
 * than queues) and slow enough that a room with nobody home costs almost
 * nothing. Every repeat is the full current state, so a repeat is never a
 * correction — it is the same sentence said again in case the first one was
 * written over.
 */
export const TRANSFER_SIGNAL_INTERVAL_MS = 700;

/**
 * How long the sender waits for a data channel before it says the honest thing.
 *
 * Fifteen seconds is well past a working LAN handshake (host candidates connect
 * in well under one) and well short of a person deciding the app is broken. It
 * is deliberately NOT a warning shown up front: the overwhelming majority of
 * these transfers are a phone and a PC on one home network, where this works,
 * and pre-emptively apologising for the case that does not happen is how a
 * feature teaches its user not to trust it.
 */
export const TRANSFER_TIMEOUT_MS = 15_000;

/** How long the sender waits, after the last byte, for the display to store it. */
export const TRANSFER_STORE_TIMEOUT_MS = 60_000;

/**
 * The most candidates one cumulative ICE message carries.
 *
 * A host-plus-STUN gathering is typically four to eight; twelve is slack. The
 * cap exists because the message is cumulative, so without one a pathological
 * gathering would grow the body until the envelope was refused — and an
 * envelope over the cap is dropped, which is precisely the silent failure this
 * whole design is built to avoid.
 */
export const TRANSFER_ICE_MAX = 12;

/**
 * One STUN server, no TURN. See the header.
 *
 * Google's public STUN is used for the same reason the QR path uses no service
 * at all: it needs no account, no key and no configuration, and STUN learns
 * nothing but the IP that was already going to reach it. If it is unreachable,
 * host candidates alone still connect two peers on one LAN — which is the case
 * this feature is for.
 */
export const TRANSFER_STUN_URLS: readonly string[] = ['stun:stun.l.google.com:19302'];

/** The label both ends open the data channel with. */
export const TRANSFER_CHANNEL_LABEL = 'kh-file';

// ---------------------------------------------------------------------------
// The wire bodies
// ---------------------------------------------------------------------------

/** `tele` kinds. Distinct names so a peer that has never heard of them ignores them. */
export const TRANSFER_ANSWER_KIND = 'transferAnswer';
export const TRANSFER_ICE_KIND = 'transferIce';
export const TRANSFER_PROGRESS_KIND = 'transferProgress';

/**
 * Why a transfer could not happen, as a machine-readable reason.
 *
 * The COPY lives in the configuration UI, next to the button that is about to
 * render it — this file is imported by the display page and must not drag the
 * vocabulary (or anything else from `src/app/config`) onto the LCD's graph.
 */
export type TransferRefusal = 'quota' | 'too-large' | 'unsupported' | 'busy';

/** Remote → display, on `cmd`. The SDP of a data-channel-only offer is ~1–2 KB. */
export interface TransferOfferArg {
  sid: string;
  name: string;
  size: number;
  mime: string;
  sdp: string;
}

/** Either direction. Cumulative: every candidate gathered so far. */
export interface TransferIceArg {
  sid: string;
  candidates: WireCandidate[];
}

/**
 * One ICE candidate, shortened.
 *
 * `c`/`m`/`i` rather than `candidate`/`sdpMid`/`sdpMLineIndex` because the
 * message is cumulative and every key is paid for up to twelve times inside an
 * 8 KB envelope.
 */
export interface WireCandidate {
  c: string;
  m?: string;
  i?: number;
}

/** Display → remote, on `tele`. Carries either an SDP or a refusal, never both. */
export interface TransferAnswerBody {
  ts: number;
  kind: typeof TRANSFER_ANSWER_KIND;
  sid: string;
  sdp?: string;
  refused?: TransferRefusal;
  /** A sentence the display can say better than the phone can guess it. */
  detail?: string;
}

export type TransferProgressState = 'receiving' | 'storing' | 'stored' | 'failed';

/** Display → remote, on `tele`. The receiving end of the progress bar. */
export interface TransferProgressBody {
  ts: number;
  kind: typeof TRANSFER_PROGRESS_KIND;
  sid: string;
  received: number;
  total: number;
  state: TransferProgressState;
  detail?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function text(o: Record<string, unknown>, key: string): string | null {
  const value = o[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseTransferOffer(arg: unknown): TransferOfferArg | null {
  const o = record(arg);
  if (o === null) return null;
  const sid = text(o, 'sid');
  const name = text(o, 'name');
  const sdp = text(o, 'sdp');
  const size = positive(o['size']);
  if (sid === null || name === null || sdp === null || size === null) return null;
  return { sid, name, size, mime: typeof o['mime'] === 'string' ? o['mime'] : '', sdp };
}

/** Candidates, cleaned and capped. An empty list is a valid message: "nothing yet". */
export function parseTransferIce(arg: unknown): TransferIceArg | null {
  const o = record(arg);
  if (o === null) return null;
  const sid = text(o, 'sid');
  if (sid === null) return null;
  const raw = o['candidates'];
  if (!Array.isArray(raw)) return null;
  const candidates: WireCandidate[] = [];
  for (const entry of raw) {
    const c = record(entry);
    if (c === null) continue;
    const line = text(c, 'c');
    if (line === null) continue;
    const mid = text(c, 'm');
    const index = c['i'];
    candidates.push({
      c: line,
      ...(mid === null ? {} : { m: mid }),
      ...(typeof index === 'number' && Number.isFinite(index) ? { i: index } : {}),
    });
    if (candidates.length >= TRANSFER_ICE_MAX) break;
  }
  return { sid, candidates };
}

export function parseTransferAnswer(body: unknown): TransferAnswerBody | null {
  const o = record(body);
  if (o === null) return null;
  if (o['kind'] !== TRANSFER_ANSWER_KIND) return null;
  const sid = text(o, 'sid');
  if (sid === null) return null;
  const sdp = text(o, 'sdp');
  const refused = o['refused'];
  const detail = text(o, 'detail');
  const isRefusal =
    refused === 'quota' ||
    refused === 'too-large' ||
    refused === 'unsupported' ||
    refused === 'busy';
  if (sdp === null && !isRefusal) return null;
  return {
    ts: typeof o['ts'] === 'number' ? o['ts'] : 0,
    kind: TRANSFER_ANSWER_KIND,
    sid,
    ...(sdp === null ? {} : { sdp }),
    ...(isRefusal ? { refused } : {}),
    ...(detail === null ? {} : { detail }),
  };
}

export function parseTransferProgress(body: unknown): TransferProgressBody | null {
  const o = record(body);
  if (o === null) return null;
  if (o['kind'] !== TRANSFER_PROGRESS_KIND) return null;
  const sid = text(o, 'sid');
  const state = o['state'];
  if (
    sid === null ||
    (state !== 'receiving' && state !== 'storing' && state !== 'stored' && state !== 'failed')
  ) {
    return null;
  }
  const detail = text(o, 'detail');
  return {
    ts: typeof o['ts'] === 'number' ? o['ts'] : 0,
    kind: TRANSFER_PROGRESS_KIND,
    sid,
    received: typeof o['received'] === 'number' ? o['received'] : 0,
    total: typeof o['total'] === 'number' ? o['total'] : 0,
    state,
    ...(detail === null ? {} : { detail }),
  };
}

// ---------------------------------------------------------------------------
// The envelope budget
// ---------------------------------------------------------------------------

/**
 * `MAX_ENVELOPE_BYTES` from `src/sync/types.ts`, minus room for the envelope's
 * own keys — the same copy-and-pin arrangement `chunkedTele` uses, and for the
 * same reason: importing a runtime value from the sync core would drag this file
 * into that chunk's graph in both directions. `protocol.test.ts` asserts the two
 * constants agree.
 */
export const TRANSFER_ENVELOPE_CAP_BYTES = 8192;
export const TRANSFER_BODY_BUDGET_BYTES = 7000;

/** UTF-8 length, because an SDP can carry a UTF-8 session name. */
export function bodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/**
 * Does this signalling message fit one envelope?
 *
 * Checked before it is sent rather than discovered afterwards: `encodeEnvelope`
 * throws over the cap and `publishTele` would drop it, and a signalling message
 * that silently vanishes is a handshake that hangs for fifteen seconds and then
 * blames the network.
 */
export function signalFits(body: unknown): boolean {
  return bodyBytes(body) <= TRANSFER_BODY_BUDGET_BYTES;
}

/**
 * Trim a cumulative candidate list until it fits, newest last.
 *
 * The OLDEST candidates are dropped, not the newest: host candidates are
 * gathered first and are the ones a LAN transfer actually connects on, but a
 * list that no longer fits has already carried them several times over, so the
 * peer has them. Dropping from the front keeps the message a strict suffix of
 * what was already sent, which is the property that makes truncation safe.
 */
export function fitCandidates(sid: string, candidates: readonly WireCandidate[]): WireCandidate[] {
  let out = candidates.slice(-TRANSFER_ICE_MAX);
  while (out.length > 1 && !signalFits({ sid, candidates: out })) out = out.slice(1);
  return out;
}

// ---------------------------------------------------------------------------
// Chunking and assembly
// ---------------------------------------------------------------------------

/** How many 16 KB messages a file of this size becomes. Always at least one. */
export function chunkCount(size: number, chunk = TRANSFER_CHUNK_BYTES): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.max(1, Math.ceil(size / chunk));
}

/**
 * Should the sender stop and wait?
 *
 * A function rather than an inline comparison so the rule is one thing with one
 * test, and so `send.ts` cannot drift from what the tests believe it does.
 */
export function shouldPause(bufferedAmount: number, high = TRANSFER_BUFFER_HIGH_BYTES): boolean {
  return bufferedAmount >= high;
}

export interface Assembler {
  /** Bytes accepted so far. */
  readonly received: number;
  /** True once `received` reaches the declared size. */
  readonly complete: boolean;
  /**
   * Accept one chunk. Returns false when the chunk would take the payload past
   * the declared size — a sender that is not sending what it said it would.
   */
  push(part: ArrayBuffer | Uint8Array): boolean;
  /** The finished file. Only meaningful once `complete`. */
  blob(): Blob;
}

/**
 * Collects chunks into one Blob.
 *
 * Kept as an array of parts and joined once at the end rather than concatenated
 * as it goes: `new Blob(parts)` is a single allocation the browser can back with
 * the parts themselves, whereas re-concatenating a growing buffer per 16 KB
 * chunk is quadratic and, at 500 MB, is the tab.
 *
 * The size guard is not paranoia about our own sender. The offer that declared
 * the size arrived over a channel any peer holding the room key can write to,
 * and the quota was checked against THAT number — so a stream allowed to run
 * past it is a quota check that means nothing.
 */
export function createAssembler(o: { size: number; mime: string }): Assembler {
  const parts: BlobPart[] = [];
  let received = 0;
  return {
    get received() {
      return received;
    },
    get complete() {
      return received >= o.size;
    },
    push(part) {
      const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
      if (bytes.byteLength === 0) return true;
      if (received + bytes.byteLength > o.size) return false;
      // A copy, because the caller may reuse the underlying buffer.
      parts.push(bytes.slice().buffer);
      received += bytes.byteLength;
      return true;
    },
    blob() {
      return new Blob(parts, o.mime === '' ? {} : { type: o.mime });
    },
  };
}

/**
 * Is this file a picture or a clip?
 *
 * The MIME type a phone attaches is authoritative when it is there and absent
 * often enough — a file picked out of a document provider can arrive with an
 * empty type — that the extension is a real fallback rather than a belt and
 * braces. Anything that is neither is routed to the video ingest path, which is
 * the one with the honest rejection messages.
 */
export function isPictureFile(name: string, mime: string): boolean {
  if (mime.startsWith('image/')) return true;
  if (mime.startsWith('video/')) return false;
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|apng)$/i.test(name.trim());
}
