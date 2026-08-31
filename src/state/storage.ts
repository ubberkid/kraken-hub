/**
 * Atomic single-key persistence for `AppState`, and the change watcher the
 * display depends on.
 *
 * CAM opens two Chromium browsers on the same origin — a visible Configuration
 * Browser and the hidden Kraken Browser — so localStorage plus the `storage`
 * event IS the sanctioned config→display channel. Whether that event fires
 * reliably inside the CAM webview is H14, and it is now confirmed on CAM 4.76.5
 * (see the hardware-checklist known results): every observed change arrived by
 * event, `viaPoll` was 0. The 1 s poll below stays unconditional anyway — one
 * CAM build on one machine is not every CAM build, and the poll costs a string
 * compare. The `{ viaEvent, viaPoll }` counters are how that stays honest.
 */

import { createLogger } from '../lib/log';
import { clientId } from '../platform/env';
import { onStorageEvent, readRaw, removeRaw, writeRaw } from '../platform/storage';

import { defaultAppState } from './defaults';
import { migrate } from './migrations';
import { MAX_STATE_BYTES, type AppState, type Role } from './schema';
import { validateAppState, type ValidationNote } from './validate';

const log = createLogger('state/storage');

/** `kraken-hub:v1:state` — never renamed; content evolves via `schema`. */
export const STATE_SUFFIX = 'state';
const FUTURE_SUFFIX = 'state:future';
const CORRUPT_SUFFIX = 'state:corrupt';

export const POLL_INTERVAL_MS = 1000;

export class StateTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `kraken-hub: state JSON is ${String(bytes)} bytes, over the ${String(MAX_STATE_BYTES)} byte cap. ` +
        'Blobs belong in IndexedDB, never in localStorage (invariant I6).',
    );
    this.name = 'StateTooLargeError';
  }
}

export interface ReadResult {
  state: AppState;
  notes: ValidationNote[];
  /** True when the stored document was written by a newer build. */
  future: boolean;
  raw: string | null;
}

let lastRaw: string | null = null;
let seenRevHighWater = 0;

/** Parse → migrate → validate. Never throws; a corrupt file is stashed, not lost. */
export function readState(): ReadResult {
  const raw = readRaw(STATE_SUFFIX);
  lastRaw = raw;
  if (raw === null) {
    return { state: defaultAppState(), notes: [], future: false, raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('stored state is not JSON — stashed and replaced with defaults', err);
    writeRaw(CORRUPT_SUFFIX, raw);
    return { state: defaultAppState(), notes: [], future: false, raw };
  }

  const migrated = migrate(parsed);
  if (migrated.future !== null) {
    writeRaw(FUTURE_SUFFIX, migrated.future);
    log.warn('stored state came from a newer build — preserved at state:future');
  }
  const { state, notes } = validateAppState(migrated.raw);
  seenRevHighWater = Math.max(seenRevHighWater, state.rev);
  return { state, notes, future: migrated.future !== null, raw };
}

/** The raw JSON written by a newer build, if any (config UI shows a banner). */
export function readFutureState(): string | null {
  return readRaw(FUTURE_SUFFIX);
}

export function clearFutureState(): void {
  removeRaw(FUTURE_SUFFIX);
}

type Listener = (state: AppState, via: 'event' | 'poll' | 'mem') => void;
const memBus = new Set<Listener>();

const counters = { viaEvent: 0, viaPoll: 0, viaMem: 0 };

/** How each state change actually reached this page — the H14 evidence. */
export function deliveryCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/** Accept a `rev` observed from a remote peer so the next commit exceeds it. */
export function noteSeenRev(rev: number): void {
  seenRevHighWater = Math.max(seenRevHighWater, rev);
}

/**
 * One `setItem` of one JSON string: readers can never observe a torn state.
 * The Lamport `rev` makes concurrent edits resolvable last-writer-wins.
 */
export function commit(mutate: (s: AppState) => AppState, meta: { role: Role }): AppState {
  const current = readState().state;
  const draft = mutate(current);
  const { state } = validateAppState({
    ...draft,
    rev: Math.max(current.rev, seenRevHighWater, draft.rev) + 1,
    updatedAt: Date.now(),
    writerId: clientId(),
    writerRole: meta.role,
  });

  const json = JSON.stringify(state);
  if (json.length > MAX_STATE_BYTES) throw new StateTooLargeError(json.length);

  writeRaw(STATE_SUFFIX, json);
  lastRaw = json;
  seenRevHighWater = Math.max(seenRevHighWater, state.rev);

  // The `storage` event never fires in the document that wrote the value.
  counters.viaMem += 1;
  for (const cb of memBus) {
    try {
      cb(state, 'mem');
    } catch (err) {
      log.error('state listener threw', err);
    }
  }
  return state;
}

/**
 * Watches for state changes from any source.
 *
 * Both the `storage` event and a 1 s poll are always active. The poll compares
 * the RAW STRING first, so the common case (no change) costs one `getItem` and
 * a string compare — no parse, no allocation.
 */
export function watchState(onChange: Listener): () => void {
  memBus.add(onChange);

  const refresh = (via: 'event' | 'poll'): void => {
    const raw = readRaw(STATE_SUFFIX);
    if (raw === lastRaw) return;
    const result = readState();
    if (via === 'event') counters.viaEvent += 1;
    else counters.viaPoll += 1;
    // Echo suppression: our own write already went out over memBus.
    if (result.state.writerId === clientId()) return;
    try {
      onChange(result.state, via);
    } catch (err) {
      log.error('state listener threw', err);
    }
  };

  const offStorage = onStorageEvent((e) => {
    if (e.suffix === STATE_SUFFIX || e.suffix === null) refresh('event');
  });
  const timer = setInterval(() => {
    refresh('poll');
  }, POLL_INTERVAL_MS);

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') refresh('event');
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);

  return () => {
    memBus.delete(onChange);
    offStorage();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', onVisible);
  };
}

/** Test helper: forget the cached raw string. */
export function resetStateCache(): void {
  lastRaw = null;
  seenRevHighWater = 0;
}
