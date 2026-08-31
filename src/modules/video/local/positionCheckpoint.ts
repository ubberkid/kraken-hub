/**
 * "Where was I?" across a cold restart — the LOCAL half of position sync.
 *
 * The wire half (`src/sync/position.ts`) answers "where is the *other* machine
 * right now", and it belongs on the network because two machines do not share a
 * clock. This file answers a different question: the LCD lost power at 3 a.m.,
 * CAM restarted it at 9 a.m., nobody is in the room, and there is no remote to
 * ask. The only record of where the clip was is the one the display wrote for
 * itself, so this is deliberately local-only — no wire format, no publish, no
 * change to the sync contract. A display still never publishes state.
 *
 * ## What is stored
 *
 * One entry, for the last source that played, under
 * `kraken-hub:v1:video:positionCheckpoint`. Keyed by source identity — a clip
 * id for a local clip, otherwise the same 8-hex `urlHash` telemetry already
 * uses — so resuming happens only on a remount of the SAME source. Change the
 * URL and the key no longer matches, which is exactly right: a new clip starts
 * at the beginning.
 *
 * Keeping one entry rather than a map is a size decision, not laziness: this
 * key shares a localStorage quota with the state document, the telemetry ring
 * buffer and the clip index, and an unbounded per-URL history would grow
 * forever on a machine that cycles through a playlist.
 *
 * ## What is NOT stored
 *
 * Nothing for a live stream (a position in a live edge is meaningless), and
 * nothing while an A-B loop is enabled — there, the loop's own start is the
 * right resume point and the user configured it deliberately, so the loop wins.
 * Both decisions are made by the caller, which is the only place that knows.
 */

import { createLogger } from '../../../lib/log';
import { readRaw, removeRaw, writeRaw } from '../../../platform/storage';
import { LOCAL_CLIP_SCHEME } from '../routing/patterns';

const log = createLogger('video/checkpoint');

export const CHECKPOINT_SUFFIX = 'video:positionCheckpoint';

/** How often a playing source re-stamps its checkpoint. */
export const CHECKPOINT_INTERVAL_MS = 10_000;

/**
 * Positions below this are not worth restoring.
 *
 * Resuming a clip 0.4 s in is indistinguishable from starting it, and writing
 * one would mean every source change leaves a checkpoint that does nothing.
 */
export const CHECKPOINT_MIN_SEC = 1;

/**
 * How close to the end still counts as "finished".
 *
 * Without it, a clip checkpointed 0.2 s from its end would resume into its own
 * final frame and immediately loop — which looks exactly like a display that
 * failed to resume at all.
 */
export const CHECKPOINT_END_MARGIN_SEC = 2;

export interface PositionCheckpoint {
  /** Source identity, from `checkpointKey()`. Never a raw URL. */
  key: string;
  posSec: number;
  durationSec: number | null;
  /** Epoch ms, for diagnostics only — the position itself is not extrapolated. */
  atMs: number;
}

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The stable identity of a source.
 *
 * A local clip is already an opaque id, so it is used directly. Everything else
 * is hashed with the same function telemetry uses, which keeps a raw URL out of
 * localStorage for the same defence-in-depth reason. `null` when the hash is
 * unavailable (no WebCrypto), which simply means no checkpointing — a missing
 * convenience, never a failure.
 */
export async function checkpointKey(
  url: string,
  hash: (value: string) => Promise<string | null>,
): Promise<string | null> {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(LOCAL_CLIP_SCHEME)) {
    return `clip:${trimmed.slice(LOCAL_CLIP_SCHEME.length)}`;
  }
  const digest = await hash(trimmed);
  return digest === null ? null : `url:${digest}`;
}

export function readCheckpoint(): PositionCheckpoint | null {
  const raw = readRaw(CHECKPOINT_SUFFIX);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['key'] !== 'string' || o['key'].length === 0) return null;
  if (!isPositive(o['posSec'])) return null;
  return {
    key: o['key'],
    posSec: o['posSec'],
    durationSec: isPositive(o['durationSec']) ? o['durationSec'] : null,
    atMs: isPositive(o['atMs']) ? o['atMs'] : 0,
  };
}

export function writeCheckpoint(cp: PositionCheckpoint): void {
  try {
    writeRaw(CHECKPOINT_SUFFIX, JSON.stringify(cp));
  } catch (err) {
    log.warn('could not write the position checkpoint', err);
  }
}

export function clearCheckpoint(): void {
  removeRaw(CHECKPOINT_SUFFIX);
}

/**
 * The resume decision, in one testable place.
 *
 * Returns the seconds to seek to, or `null` for "start from the beginning".
 */
export function resumeTarget(
  cp: PositionCheckpoint | null,
  o: { key: string | null; durationSec: number | null; loopEnabled: boolean },
): number | null {
  if (cp === null || o.key === null || cp.key !== o.key) return null;
  // The A-B loop's own start wins: the user configured it, and a resume that
  // dropped playback outside the span would be immediately dragged back anyway.
  if (o.loopEnabled) return null;
  if (cp.posSec < CHECKPOINT_MIN_SEC) return null;
  // A live edge has no meaningful duration and no meaningful position.
  if (o.durationSec === null || !Number.isFinite(o.durationSec) || o.durationSec <= 0) return null;
  if (cp.posSec >= o.durationSec - CHECKPOINT_END_MARGIN_SEC) return null;
  return cp.posSec;
}
