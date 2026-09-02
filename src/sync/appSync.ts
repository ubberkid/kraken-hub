/**
 * The bridge between the wire and the state model.
 *
 * `SyncService` deals in envelopes and bytes; `src/state/precedence.ts` deals in
 * layers. This file is the only place that knows both, which is what keeps the
 * sync layer free of app imports (invariant 6's `sync ↛ app` zone) and keeps
 * `precedence.ts` free of any idea that a network exists.
 *
 * ## What it holds
 *
 * One thing: the REGISTER TABLE — every leaf anybody in the room has written,
 * with the hybrid-logical-clock stamp of the write that put it there. Inbound
 * frames merge into it (`src/sync/merge.ts`), local commits write into it, and
 * `resolveState` sees it as the `remote` precedence layer. It is the whole of
 * the sync layer's memory.
 *
 * There used to be two layers here — `remote` for what peers said and `local`
 * for what this page had said that no peer had acknowledged yet — plus a stamp
 * table, an acknowledgement map, a provenance map, a liveness timer and a rev
 * floor, all arbitrating between them. Every one of those is gone. The reason
 * they existed was that arrival order is not causal order, and the reason they
 * could not be made to work is that CAUSAL order is not a total order either:
 * two people touching the same setting at the same moment have seen nothing of
 * each other, so a rule made only of causality has nothing to say about them,
 * and every patch for that produced a deadlock (two chatty peers defending the
 * same leaf forever), a laundered acknowledgement, or a room that split in two.
 * A hybrid logical clock is a total order that AGREES with causality wherever
 * causality has an opinion, so one comparison answers both questions and there
 * is nothing left for two peers to negotiate.
 *
 * ## The precedence layers, after
 *
 * `defaults < persisted < remote < local < url` still holds, and `remote` and
 * `local` have collapsed into one: the merged register table IS both, because a
 * local write is simply the write with the latest stamp. `url` still sits on
 * top, and the store's API (`commit` / `replace` / `subscribe`) is unchanged —
 * no app file moved for this.
 */

import { isPlainObject } from '../lib/clamp';
import { createLogger } from '../lib/log';
import { monotonicNow } from '../lib/monotonic';
import { readRaw, writeRaw } from '../platform/storage';
import { baseLook } from '../state/look/types';
import { resolveState } from '../state/precedence';
import { noteSeenRev } from '../state/storage';

import { EPOCH, compareStamps, decodeStamp, encodeStamp, maxStamp, tick, type Stamp } from './hlc';
import { BASE_KIND_LEAF, deepEqual, enumerateLeaves, leavesToPatch, withBaseKind } from './leaves';
import { mergeInto, type Register, type Registers } from './merge';
import {
  WIRE_TOO_LARGE_CLAIM,
  createSyncService,
  type SyncService,
  type SyncServiceOptions,
} from './SyncService';
import {
  MAX_SLOT_BYTES,
  MAX_SLOT_REGISTERS,
  MAX_UNSHIPPED_REGISTERS,
  MAX_UNSHIPPED_SLOT_BYTES,
} from './types';

import type { StampTuple } from './hlc';
import type { CmdBody, RecvMeta, Role, SyncStateBody, SyncStatus, TeleBody } from './types';
import type { AppState, DeepPartial } from '../state/schema';
import type { Store } from '../state/store';

const log = createLogger('sync/app');

/** Remote state is committed to localStorage no more often than this. */
export const PERSIST_REMOTE_THROTTLE_MS = 2000;

/**
 * What travels. Blobs and settings deliberately do not — and neither do `sync`,
 * `platform` or `diagnostics`: a remote peer must not be able to change which
 * broker a display talks to, whether its watchdog may reload it, or whether
 * audio is opted in. Those are local trust decisions and they stay local.
 *
 * `activeModuleId` and `look.layers[0].kind` are the same fact, and this is
 * where they are forced to agree on the way out (§6.1: written both ways for
 * one release, removed at schema 8). `src/sync/leaves.ts` treats them as one
 * merge unit, so they cannot come apart on the way back in either.
 */
export function stateToSyncBody(s: AppState): SyncStateBody {
  return {
    activeModuleId: s.activeModuleId,
    look: withBaseKind(s.look, s.activeModuleId),
    modules: s.modules,
    playback: s.playback,
    render: s.render,
  };
}

/**
 * The inverse, as a precedence PATCH rather than a whole state.
 *
 * A body with no `look` is a body from a build that predates §6; `baseLook` is
 * the same projection the 6 → 7 migration uses, so an old phone's snapshot
 * lands losslessly as a one-layer arrangement.
 */
export function syncBodyToPatch(b: SyncStateBody): DeepPartial<AppState> {
  return {
    activeModuleId: b.activeModuleId,
    look: withBaseKind(b.look ?? baseLook(b.activeModuleId), b.activeModuleId),
    modules: b.modules,
    playback: b.playback,
    render: b.render,
  };
}

// ---------------------------------------------------------------------------
// The persisted clock
// ---------------------------------------------------------------------------

/**
 * Where a page's REGISTER TABLE survives a reload.
 *
 * ## Why the slot carries values now (v2)
 *
 * It used to carry stamps only, on the reasoning that the values were already
 * persisted — they are the state document. They are, but they are written by a
 * DIFFERENT act: stamps go into this slot on every local commit and on
 * `stop()`, while values go into the document only through `persistNow()`,
 * which is throttled to two seconds and which `sync.persistRemote: false`
 * switches off entirely. Any page that closed inside that gap left a slot whose
 * stamps described values its document did not contain, and the restore loop
 * paired them anyway: the room's newest stamp against a value it never
 * described. That page then out-ranked the true value everywhere, permanently,
 * because the two registers tied on stamp and the tie went to whichever value
 * sorted larger as JSON. Measured on a display-only room: a tap lost forever;
 * measured on a three-peer room: the author's own edit reverted room-wide.
 *
 * So the slot is now SELF-CONTAINED — `{ stamp, value }` per leaf — and the
 * document is not consulted at all. It was, for one thing: whether the leaf
 * still existed. That gate turned out to unpair the two halves of a look, since
 * `look.order` is in every document and the layer it names may not be yet; see
 * the restore in `startAppSync`. A stamp is a fact about a value, and the two
 * are written together or not at all. `stop()` still flushes them in the only
 * safe order: values first (the document), stamps second (this slot).
 *
 * `persistRemote` governs whether REMOTE state is authoritative on a cold boot,
 * not whether this page is allowed to remember what it decided — so the slot is
 * written either way. See `docs/settings.md` / the sync settings note.
 *
 * ## What it buys
 *
 *  - the first write after a reload is ordered after everything the page had
 *    seen before it, even on a device whose wall clock is behind the room's;
 *  - a leaf this page authored is still defended by the stamp it was authored
 *    with, rather than reverting to "unstamped" and losing to any older frame
 *    that happens to mention it;
 *  - the ROOM-CLOCK OFFSET (below) survives, so a device that reloads during an
 *    outage still stamps in room time when it comes back.
 *
 * A missing slot is not an error — it is every page that has ever run, and
 * every leaf it names simply migrates in at `EPOCH`. A v1 slot is discarded
 * outright rather than mis-paired: `readStoredClock` returns `null` on a
 * version mismatch, and a discarded slot is the pre-existing safe default.
 */
export interface ClockSlot {
  read(): string | null;
  write(raw: string): void;
}

const CLOCK_SLOT_VERSION = 2;

/** One persisted register: the stamp, and the value that stamp describes. */
interface StoredRegister {
  s: StampTuple;
  v: unknown;
}

interface StoredClock {
  v: number;
  clock: StampTuple;
  /** The room-clock offset in ms. Missing reads as 0. */
  offset: number;
  /**
   * The monotone stamping base — the highest `Date.now() + offset` this page has
   * ever stamped against. Missing reads as 0, which is exactly right: the HLC
   * floor in `tick` already covers everything the clock itself knows about, and
   * the base only ever adds to that.
   */
  base: number;
  /**
   * `Date.now()` at the moment `base` was written down.
   *
   * `base` is a projection — the anchor plus however long a monotonic clock says
   * has passed — and a monotonic clock does not survive a page load. So the
   * restore used to restart the projection at zero elapsed and DISCARD every
   * second that passed between the last `saveClock()` and the reload. With a
   * correct wall clock that is invisible, because `Date.now() + offset` beats
   * the projection anyway; after a BACKWARD step the projection is the only
   * thing holding room time up, and the discarded gap is exactly the size of the
   * edit that gets lost. Measured: a phone that steps back 10 s during an outage
   * and reloads while still dark stamps its first tap ~7 s in the past, and the
   * room reverts it — at −1 s it survives, at −10 s and −1 h it does not.
   *
   * So the gap is written down and projected across on restore, under a
   * `Math.max(0, …)` that keeps a backward step from dragging the base DOWN.
   * Missing reads as 0, which disables the projection and is exactly the old
   * behaviour — the conservative direction, and the same argument `heard` makes
   * for not bumping the slot version.
   */
  baseAt: number;
  /**
   * Which of `stamps`' paths the ROOM had not heard when the slot was written.
   *
   * Shippedness used to be in-memory only, and `saveClock`'s whole two-pass
   * argument rests on it: pass one packs the writes the room has not heard, so a
   * cap may only ever evict a register the room already holds. A page load that
   * never reaches the room restored the registers and an EMPTY unshipped set, so
   * its next `saveClock()` — `stop()` alone is enough — re-packed the slot as if
   * every register were shipped and evicted the oldest offline write. Measured:
   * a phone that edits offline, reloads twice without ever reaching the room
   * (a lift, a locked screen, a discarded tab), and comes back to find exactly
   * the one edit the room had an opinion about silently reverted.
   *
   * A MISSING key reads as "every restored register is unshipped", not as
   * "none". That is the conservative direction — the same reasoning
   * `StoredClock.heard` gives for reading a missing key as false — so an
   * existing v2 slot needs no version bump; `MAX_UNSHIPPED_REGISTERS` already
   * bounds the pessimistic case.
   */
  unshipped?: string[];
  /**
   * Whether the previous session ever folded an inbound frame.
   *
   * Deliberately NOT the same question as "is there a persisted HLC". A page
   * whose only company was a display — which publishes telemetry and never
   * publishes state — could end a session having heard the room's clock and
   * still hold a stamp of its own; and a page could hold a stamp having heard
   * nothing at all. It is the second case that matters, because that page knows
   * nothing about room time and its first write after a reload must be held as
   * an intent rather than stamped against a clock it has no reason to trust.
   *
   * The key is read as FALSE when it is missing, which is the conservative
   * direction and is why the slot version did not have to move: a v2 slot from a
   * build that predates this field arms the intent layer for one write, and the
   * intent layer's only effect is to re-stamp that write once a frame arrives.
   * Bumping the version instead would have discarded every existing slot — its
   * registers, its offset and its clock — to learn one boolean.
   */
  heard: boolean;
  stamps: Record<string, StoredRegister>;
}

/**
 * The default slot: one localStorage key PER ROLE.
 *
 * Per role rather than per page, because CAM's configuration browser and the
 * Kraken display browser share an origin and would otherwise share a clock —
 * two pages incrementing one counter, each clobbering the other's writes of it.
 * Per role rather than per client id, because a `clientId()` is fresh on every
 * page load and a slot keyed by one could never be read back, which is the
 * entire point of persisting it.
 */
function localStorageClockSlot(role: Role): ClockSlot {
  const suffix = `sync-clock:${role}`;
  return {
    read: () => readRaw(suffix),
    // A full or blocked quota costs ordering after a reload and nothing more,
    // so the boolean `writeRaw` returns is deliberately not acted on.
    write: (raw) => void writeRaw(suffix, raw),
  };
}

/**
 * ── The room clock ─────────────────────────────────────────────────────────
 *
 * The HLC's wall-clock floor (`t = max(now, seen.t)`) keeps a slow device from
 * writing UNDER something it has actually received. It says nothing about
 * writes it never heard — and a phone that was in a lift, or had its screen
 * locked, has heard nothing for the length of the outage. Measured: a phone 10
 * s behind, deaf for 6.5 s while CAM changed a module, then tapped the instant
 * it came back — the tap stamped 10 s in the past, lost on arrival, and the
 * screen reverted 276 ms later. At 90 s behind, the same. The threshold is
 * exactly "skew longer than the outage", which is not an exotic device.
 *
 * So the page keeps an OFFSET beside the clock — its best reading of what time
 * the room thinks it is — and stamps with `Date.now() + offset`.
 *
 * **The estimator is `max`, monotonically, over inbound clock readings** — the
 * sender's `ts` (its own `roomNow()`) and its HLC `clock.t`. Not a
 * median or an EWMA, and the reason is that this number has exactly one job:
 * make sure a write is not stamped BEFORE writes it never heard. Under-shooting
 * loses the tap; over-shooting only makes this page win a genuine tie it might
 * otherwise have lost, which is the same exposure the HLC already documents for
 * skew. `max` is also what the HLC itself does with `seen.t`, so the two agree.
 *
 * ## `MAX_ROOM_OFFSET_MS` is a BOUND, not a cliff
 *
 * It used to IGNORE a sample further than 24 h from now, on the reasoning that
 * such a reading is a broken clock rather than skew and that clamping "would
 * still hand a liar 24 h". Ignoring it is strictly worse. It does not remove the
 * peer from the room — its own stamps still ride on every frame it sends — it
 * only stops everybody ELSE from tracking it, which is exactly the state in
 * which a peer that has been offline for a while cannot out-write it.
 *
 * So the sample is CLAMPED instead: everything over 24 h counts as 24 h. The
 * trade-off is stated rather than hidden — one badly-wrong peer can now drag the
 * whole room's stamps up to a day into the future, where before it dragged them
 * nowhere. That is the better failure: a room a day fast still converges and
 * still responds to the next tap, because every peer moves together.
 *
 * ## What this does NOT do, said plainly
 *
 * It does not stop a peer with a wildly wrong clock from winning contested
 * leaves, and the exposure is bigger than it used to say here.
 *
 * A CONNECTED room is covered by the HLC floor: once you have received a stamp
 * three days out, `tick`'s `max(now, seen.t)` puts your own next write after it,
 * so the room converges on whoever tapped last regardless of whose clock is
 * broken. That is measured (`clockSkew.dom.test.ts`) and it is the whole of what
 * is measured — nobody in that script is ever muted.
 *
 * Add an outage and the claim fails, in BOTH directions, and neither residue is
 * removable at this layer:
 *
 *  - a peer more than the clamp BEHIND loses its first tap back after every
 *    outage. Its room time is capped a day short of the room's, so `tick` floors
 *    at its own pre-outage stamp, under everything written while it was away.
 *  - one far-future stamp PINS every peer's floor at its own `t` until real time
 *    catches up — three days, for a peer three days fast — and while `t` is
 *    frozen the total order degrades to `(c, s)`. `c` is a per-peer counter and
 *    is not comparable across an outage, so the tie falls through to the
 *    writer's client id in STRING order: measured, the last finger lost to
 *    alphabetical order, with the bad peer's process, slot and clock all gone
 *    from the room, and neither correcting the clock nor reloading the page
 *    unsticks it. The poison is in the register the room agreed on, not in the
 *    peer.
 *
 * There is no cap that fixes the second one here, and it is worth writing down
 * which two were tried, because both are plausible:
 *
 *  - capping the LOCAL floor (fold an inbound stamp into `clock` at no more than
 *    `roomNow() + MAX_ROOM_OFFSET_MS`, registers verbatim) makes it strictly
 *    worse. The poisoned register still holds `now + 3 d`, so a local write
 *    stamped at the ceiling LOSES to it on every receiver: the room does not
 *    mis-order the last tap, it SPLITS, the writer showing its own value and
 *    everybody else the far-future one. Measured: with that cap, the shipped
 *    "does not let a peer three days fast own every setting in the room" test
 *    reads `display=90 CAM=90 phoneA=90 phoneB=90` where it wants 180.
 *  - capping the incoming REGISTER stamps is the only cap that removes the pin,
 *    and it costs the merge its "one write, one stamp, everywhere" property,
 *    since a cap computed from the receiver's own clock gives two receivers two
 *    different stamps for one write.
 *
 * So the residue is stated instead — in `docs/remote-control.md`, and pinned by
 * `src/sync/hlcFloorPin.dom.test.ts`, which asserts what actually happens rather
 * than what one would like to.
 *
 * The offset never goes negative, so nobody can drag this page's writes into
 * the past. And a room where a peer can lie about the clock is a room where that
 * peer can also just write the value it wants, so this is not the boundary worth
 * spending a Kalman filter on.
 */
export const MAX_ROOM_OFFSET_MS = 24 * 60 * 60 * 1000;

/** A usable offset, clamped to the bound. Never negative. */
function clampRoomOffset(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(Math.min(ms, MAX_ROOM_OFFSET_MS));
}

function readStoredClock(slot: ClockSlot): StoredClock | null {
  const raw = slot.read();
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed['v'] !== CLOCK_SLOT_VERSION) return null;
    const clock = decodeStamp(parsed['clock'], 64);
    if (clock === null) return null;
    const rawOffset = parsed['offset'];
    const offset =
      typeof rawOffset === 'number' && Number.isFinite(rawOffset)
        ? clampRoomOffset(rawOffset)
        : /* a slot written before offsets existed */ 0;
    const rawBase = parsed['base'];
    const base =
      typeof rawBase === 'number' && Number.isFinite(rawBase) && rawBase > 0 ? rawBase : 0;
    const rawBaseAt = parsed['baseAt'];
    // Missing reads as 0, which disables the projection — see `StoredClock.baseAt`.
    const baseAt =
      typeof rawBaseAt === 'number' && Number.isFinite(rawBaseAt) && rawBaseAt > 0 ? rawBaseAt : 0;
    // Missing reads as FALSE — see `StoredClock.heard`.
    const heard = parsed['heard'] === true;
    /*
     * Missing reads as UNDEFINED here and as "all of them" at the seeding site —
     * see `StoredClock.unshipped`. An array of strings, defensively: anything
     * else is a slot this build did not write.
     */
    const rawUnshipped = parsed['unshipped'];
    const unshipped = Array.isArray(rawUnshipped)
      ? rawUnshipped.filter((p): p is string => typeof p === 'string')
      : undefined;
    const stamps: Record<string, StoredRegister> = {};
    const rawStamps = parsed['stamps'];
    if (isPlainObject(rawStamps)) {
      for (const [path, entry] of Object.entries(rawStamps)) {
        if (!isPlainObject(entry)) continue;
        // A register with no `v` key is half a register — `undefined` is not a
        // value any leaf holds, and JSON drops the key rather than storing it.
        if (!('v' in entry)) continue;
        const stamp = decodeStamp(entry['s'], 64);
        if (stamp !== null) stamps[path] = { s: encodeStamp(stamp), v: entry['v'] };
      }
    }
    return {
      v: CLOCK_SLOT_VERSION,
      clock: encodeStamp(clock),
      offset,
      base,
      baseAt,
      heard,
      stamps,
      ...(unshipped === undefined ? {} : { unshipped }),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AppSyncOptions {
  role: Role;
  clientId: string;
  store: Store;
  /**
   * The persisted layer, read **on every re-resolve** rather than captured once.
   *
   * A function, not a value, and that is the whole point. `resolveState` runs
   * again on every inbound state frame, and a layer frozen at start-up means
   * every local change made since then is invisible to it — so the first remote
   * frame after an edit silently rolls that edit back.
   */
  persisted: () => DeepPartial<AppState>;
  /** The URL layer, which still outranks anything a remote peer sends. */
  url: DeepPartial<AppState>;
  settings: AppState['sync'];
  /** Where the clock survives a reload. Defaults to one localStorage key per role. */
  clockSlot?: ClockSlot;
  factories?: SyncServiceOptions['factories'];
  onRemoteState?: (state: AppState, meta: RecvMeta) => void;
  onCmd?: (body: CmdBody, meta: RecvMeta) => void;
  onTele?: (body: TeleBody, meta: RecvMeta) => void;
  onStatus?: (status: SyncStatus) => void;
}

export interface AppSync {
  service: SyncService;
  /** The merged register table as a precedence patch, for diagnostics. */
  remoteLayer(): DeepPartial<AppState>;
  /** Every leaf this page holds a stamp for, newest first. Diagnostics only. */
  stampedLeaves(): { path: string; stamp: Stamp }[];
  stop(): Promise<void>;
}

/**
 * Starts a service already wired into the store. Never throws: a display whose
 * sync layer fails to start must keep playing from its persisted state.
 */
export async function startAppSync(o: AppSyncOptions): Promise<AppSync> {
  const slot = o.clockSlot ?? localStorageClockSlot(o.role);

  /** Every leaf anybody has written, and when. See `src/sync/merge.ts`. */
  const registers: Registers = new Map();

  /** The greatest stamp this page has seen from anybody, including itself. */
  let clock: Stamp = EPOCH;

  /** How far ahead of this device's wall clock the room reads. See above. */
  let roomOffset = 0;

  /**
   * ── The stamping base: room time, projected on a MONOTONIC clock ──────────
   *
   * `Date.now() + roomOffset` is the number `tick` is asked to stamp against,
   * and `roomOffset` being monotone does NOT make it monotone: a device clock
   * that steps backwards takes the whole sum with it, and the page starts
   * writing into its own past.
   *
   * Freezing the base at its highest value is not enough either, and the
   * measured script says why: a phone that was CORRECT at start-up has an
   * offset of zero, steps its clock back ten seconds, then locks its screen for
   * six and a half while CAM changes a module. A frozen base still reads the
   * moment of the step, which is BEFORE CAM's write, so the tap on unlock loses
   * exactly as it did with no base at all — and there is nothing inbound during
   * an outage to relearn from.
   *
   * So the base is an ANCHOR plus a projection: the highest room-time reading
   * this page has ever taken, plus however long a monotonic clock says has
   * elapsed since it took it. Time passing is information, and it is the only
   * information a deaf page has. The wall clock is still consulted every time
   * and still wins whenever it reads later — it is the source of truth for
   * anything longer than one page's lifetime — so a device that is genuinely
   * correct is unaffected by any of this.
   */
  let anchorRoomTime = 0;
  let anchorMono = monotonicNow();

  /** This page's best reading of what time the room thinks it is. Never falls. */
  function roomNow(): number {
    const projected = anchorRoomTime + (monotonicNow() - anchorMono);
    const direct = Date.now() + roomOffset;
    if (direct >= projected) {
      anchorRoomTime = direct;
      anchorMono = monotonicNow();
      return direct;
    }
    return projected;
  }

  /*
   * ── Restoring the register table ───────────────────────────────────────────
   *
   * BOTH halves come from the slot: the stamp and the value it describes.
   *
   * And ONLY from the slot. There used to be a gate here that dropped a
   * restored register unless the persisted DOCUMENT still named the leaf, on
   * the reasoning that a stamp is a fact about a value and a value that no
   * longer exists has nothing to defend. The reasoning is fine and the gate was
   * not, because the two halves of a look are written at different times: a
   * document that has learned `look.order` but not yet the layer that order
   * names — a throttled write, a `persistRemote: false` page, a quota-refused
   * write — restored the ORDER of a two-layer look without the layer. The page
   * then published a one-layer body under the two-layer order's stamp, every
   * receiver saw the same stamp against a different value, and the merge's
   * "prefer incoming" rule deleted the layer room-wide. Measured: an overlay
   * blinking on and off forever, with no clock skew, no blip and no reorder.
   *
   * Since slot v2 the register is self-contained, so the document has nothing
   * left to contribute and consulting it is backwards — the slot is the fresher
   * of the two by construction. A leaf the room genuinely deleted is carried by
   * `look.order` and by the body, not by leaf absence, and the restored register
   * simply loses to the newer order write.
   */
  const restored = readStoredClock(slot);
  if (restored !== null) {
    clock = { t: restored.clock[0], c: restored.clock[1], s: restored.clock[2] };
    roomOffset = restored.offset;
    /*
     * The projection continues ACROSS the page load — see `StoredClock.baseAt`.
     *
     * `Math.max(0, …)` is the whole of the safety: a device whose wall clock has
     * stepped BACKWARD since the slot was written reads a negative gap, and a
     * negative gap must add nothing rather than drag the base into the past. A
     * clock that ran forward normally gets credit for the time that passed,
     * which is the case a dark reload during an outage depends on.
     */
    anchorRoomTime =
      restored.baseAt > 0
        ? restored.base + Math.max(0, Date.now() - restored.baseAt)
        : restored.base;
    anchorMono = monotonicNow();
    for (const [path, entry] of Object.entries(restored.stamps)) {
      registers.set(path, {
        value: entry.v,
        stamp: { t: entry.s[0], c: entry.s[1], s: entry.s[2] },
      });
    }
  }

  /*
   * ── The intent layer ───────────────────────────────────────────────────────
   *
   * A page that has received NO frame yet — a phone unlocked and tapped before
   * its first inbound state frame lands — has a clock of `EPOCH` and no idea
   * what the room's clock reads. On a device whose wall clock is BEHIND the
   * room's, its write would be stamped earlier than values already in play and
   * would lose on arrival: the tap would go green and come back, which is the
   * original bug report verbatim.
   *
   * So a write made before the first frame is held as an INTENT: it takes
   * effect locally at once (the user sees their tap), and the moment a frame
   * arrives it is RE-STAMPED against the clock that frame carried, which by
   * construction is after everything the sender had accounted for. The intent
   * drains at that instant; it is not a layer with a lifetime.
   *
   * ## What "has heard the room" is, and what it is not
   *
   * This used to be `compareStamps(clock, EPOCH) > 0` — "I have a persisted
   * HLC" — justified by "a page with a persisted clock needs none of this, its
   * clock is already at least as late as everything it had seen before the
   * reload". That is true of the HLC floor and FALSE of room time, and the gap
   * between them is a shipped room: a phone alone with a display hears no state
   * frames at all, because a display never publishes state and a peer never
   * applies its own echo. Such a session ends with a stamp of its own and an
   * offset of zero, and on reload the old test called it "heard", disarmed the
   * intent layer, and stamped the first tap in the phone's own skewed past —
   * where it lost to a correct-clock peer and never came back. Measured on a
   * phone 90 s behind: the tap was gone for good.
   *
   * So it is a fact that is REMEMBERED rather than inferred: `heard` in the
   * clock slot, set the first time any frame — state, cmd or telemetry — is
   * folded, and read as false when the key is missing.
   */
  const intents = new Set<string>();
  let heardFromRoom = restored?.heard ?? false;

  /** Set whenever the slot's contents have moved on from what is written. */
  let clockDirty = false;

  /**
   * ── Writes the room has not heard ─────────────────────────────────────────
   *
   * Every leaf this page has written locally and not yet seen leave on the
   * room's transport. A path is added on a local commit and removed when
   * `SyncService` reports that a state frame carrying that path's stamp actually
   * went out (`onStateShipped`).
   *
   * It exists because the slot's caps were evicting exactly the wrong register.
   * `saveClock` packed newest-first, so a phone that went offline, changed
   * `render.fit`, then turned 31 other knobs and reloaded came back with 32
   * registers — and the one that fell off the end was `render.fit`, the FIRST
   * offline edit and the only one the room already held a register for. The
   * other 31 landed unopposed (no register anywhere to argue with) and the one
   * that mattered restored unstamped, lost to the room's stale `cover`, and was
   * silently reverted on every screen. 33 stamped registers is not a stress
   * figure: a settled room measures 21 after twenty ordinary config writes.
   *
   * So the cap may only ever evict a register THE ROOM ALREADY HOLDS. That is a
   * statable invariant rather than a heuristic, and it is the slot-side twin of
   * the unshipped-first pass in `fitStateEnvelope` on the wire.
   *
   * It SURVIVES A PAGE LOAD, because the invariant is worthless if it does not:
   * a second reload that never reached the room would otherwise re-pack the slot
   * as if every register were shipped and evict the oldest offline write. See
   * `StoredClock.unshipped` for the measured failure, and note the seeding
   * below — a slot written by a build that predates the key says nothing, and
   * "says nothing" has to mean "assume none of it shipped".
   */
  const unshipped = new Set<string>();
  if (restored !== null) {
    if (restored.unshipped === undefined) for (const path of registers.keys()) unshipped.add(path);
    // Intersected with what actually restored: a path the slot named but whose
    // register was dropped (an unparseable stamp, a half register) has nothing
    // left to defend.
    else for (const path of restored.unshipped) if (registers.has(path)) unshipped.add(path);
  }

  /** Stamped in ROOM time, not device time. See `MAX_ROOM_OFFSET_MS`. */
  function nextStamp(): Stamp {
    clock = tick(clock, roomNow(), o.clientId);
    return clock;
  }

  /** Fold one peer's clock reading into the offset. Monotone, clamped, never negative. */
  function noteRoomTime(t: number): void {
    const sample = clampRoomOffset(t - Date.now());
    if (sample <= roomOffset) return;
    roomOffset = sample;
    clockDirty = true;
  }

  /**
   * What EVERY inbound envelope teaches, on every channel.
   *
   * Room time is a property of the room, not of the state channel, and the
   * display-only room is the proof: the display publishes telemetry every two
   * seconds and state never, so folding only in `onState` left the one peer that
   * needed room time most with no source for it at all. `tele` and `cmd` carry
   * `meta.ts` exactly as `state` does.
   *
   * Draining the intent layer belongs here for the same reason: the question the
   * intent layer asks is "do I know what time the room thinks it is yet?", and a
   * telemetry packet answers it.
   */
  function foldRoomFrame(meta: RecvMeta): void {
    noteRoomTime(meta.ts);
    if (meta.clock !== null) noteRoomTime(meta.clock.t);
    if (heardFromRoom) return;
    heardFromRoom = true;
    clockDirty = true;
    for (const path of intents) {
      const held = registers.get(path);
      if (held === undefined) continue;
      registers.set(path, { value: held.value, stamp: nextStamp() });
    }
    intents.clear();
  }

  /**
   * The slot write, coalesced onto the same trailing edge as the document.
   *
   * ## Two passes, and the invariant that needs them
   *
   * Pass one takes every register in `unshipped` — a write the room has not
   * heard — newest-first among themselves, under the far looser
   * `MAX_UNSHIPPED_*` safety bounds. Pass two takes the rest, newest-first, into
   * whatever is left of the ordinary budget. So an overflowing slot can only
   * ever evict a register the room already holds, and a user's own offline edit
   * cannot be dropped in favour of the stale value it was replacing. See
   * `unshipped` for the measured failure that made this necessary.
   *
   * ## Two smaller repairs in the same loop
   *
   * The byte rung SKIPS an oversized register rather than `break`ing: one leaf
   * bigger than the remaining budget used to discard itself and every older
   * register behind it, turning a fat module config into a slot-wide wipe.
   *
   * And if even the unshipped pass overflows its own bound, that is a fact the
   * person can act on, so it goes out as `WIRE_TOO_LARGE_CLAIM` — the same "Too
   * much to send" sentence an oversized frame raises — rather than being quietly
   * absorbed.
   */
  function saveClock(): void {
    if (!clockDirty) return;
    clockDirty = false;
    /*
     * ── What gets written down as `base` ──────────────────────────────────────
     *
     * `roomNow()`'s RETURN VALUE, not `anchorRoomTime`. The two differ in
     * exactly the case this matters in, and that is the whole bug: `roomNow()`
     * advances the anchor only on the branch where the WALL CLOCK wins, and
     * after a backward step the wall clock never wins again — the projection
     * carries room time and the anchor sits at whatever it read before the step.
     * `saveClock` persisted the anchor, so a phone that stepped back 10 s during
     * an outage and reloaded while still dark restored a base from before the
     * step, stamped its first tap in the past, and had it reverted.
     *
     * Calling `roomNow()` at all is also new, and necessary on its own: during
     * an outage a page makes no commits and folds no frames, so nothing else
     * calls it and nothing else advances the reading. Measured: the identical
     * script with ANY local commit before the reload passes, and that commit's
     * only contribution is a `roomNow()` before the slot is written.
     */
    const base = roomNow();
    const stamps: Record<string, StoredRegister> = {};
    let bytes = 0;
    let count = 0;
    let refusedUnshipped = 0;

    const pack = (entries: [string, Register][], maxCount: number, maxBytes: number): number => {
      let refused = 0;
      for (const [path, register] of entries) {
        if (count >= maxCount) {
          refused += 1;
          continue;
        }
        const entry: StoredRegister = { s: encodeStamp(register.stamp), v: register.value };
        let size: number;
        try {
          size = JSON.stringify({ [path]: entry }).length;
        } catch {
          // A value that will not serialize is a value the slot cannot keep.
          refused += 1;
          continue;
        }
        // `continue`, never `break`: one oversized register skips only itself.
        if (bytes + size > maxBytes) {
          refused += 1;
          continue;
        }
        bytes += size;
        count += 1;
        stamps[path] = entry;
      }
      return refused;
    };

    const newestFirst = stampedNewestFirst();
    const unshippedFirst = newestFirst.filter(([path]) => unshipped.has(path));
    refusedUnshipped = pack(unshippedFirst, MAX_UNSHIPPED_REGISTERS, MAX_UNSHIPPED_SLOT_BYTES);
    pack(
      newestFirst.filter(([path]) => !unshipped.has(path)),
      Math.max(MAX_SLOT_REGISTERS, count),
      Math.max(MAX_SLOT_BYTES, bytes),
    );
    if (refusedUnshipped > 0) {
      log.warn(`the clock slot could not keep ${String(refusedUnshipped)} unsent write(s)`);
      service.noteError(WIRE_TOO_LARGE_CLAIM);
    }
    try {
      slot.write(
        JSON.stringify({
          v: CLOCK_SLOT_VERSION,
          clock: encodeStamp(clock),
          offset: roomOffset,
          base,
          baseAt: Date.now(),
          heard: heardFromRoom,
          // Exactly the pass-1 paths that actually made it into `stamps`, so the
          // next page load gives them the same priority this one did.
          unshipped: unshippedFirst.map(([path]) => path).filter((path) => path in stamps),
          stamps,
        }),
      );
    } catch (err) {
      log.warn('could not persist the sync clock', err);
    }
  }

  /**
   * Stamped leaves, newest first — the order the slot drops from, so what is
   * lost is always the annotation the room settled longest ago.
   *
   * Nothing on the WIRE drops from here any more: see `wireStamps`.
   */
  function stampedNewestFirst(): [string, Register][] {
    const out: [string, Register][] = [];
    for (const entry of registers) {
      if (compareStamps(entry[1].stamp, EPOCH) === 0) continue;
      out.push(entry);
    }
    out.sort((a, b) => compareStamps(b[1].stamp, a[1].stamp));
    return out;
  }

  const service = createSyncService({
    role: o.role,
    clientId: o.clientId,
    settings: o.settings,
    /*
     * ROOM time for the wire — the `ts` on every outbound envelope and, on the
     * far side, the `CMD_MAX_AGE_MS` gate. See `SyncServiceOptions.roomNow`.
     */
    roomNow,
    /*
     * The room has heard these. They become evictable from the slot, and not one
     * moment before — see `unshipped` and `saveClock`.
     */
    onStateShipped: (paths) => {
      let changed = false;
      for (const path of paths) changed = unshipped.delete(path) || changed;
      if (changed) clockDirty = true;
    },
    /*
     * EVERY stamp this page holds for a leaf the OUTGOING BODY agrees with,
     * uncapped, newest first.
     *
     * There used to be a fixed cap of 32 here and it was a hole, not a budget.
     * A frame is a full snapshot: dropping a leaf's stamp while shipping its
     * value does not send less, it sends `EPOCH` — a positive claim that
     * nobody has ever written that leaf. Any peer that was not listening when
     * the stamp was fresh then loses it forever, because a leaf buried under 33
     * newer edits can never climb back into the newest 32. Trimming is now
     * `fitStateEnvelope`'s job alone, measured against the real 8 kB budget.
     *
     * ## The two halves of the rule, and why the second one lives here
     *
     *  - "a value never travels without its stamp" — the ladder's business, and
     *    the reason its only stamp-dropping rung rotates;
     *  - "a stamp never travels without the value it describes" — this
     *    function's business, and it is the converse that had no owner. The
     *    body comes from the STORE and the stamps come from the REGISTER TABLE,
     *    and any seam that can make those two disagree — a restore that
     *    unpaired one from the other, a `url` layer overriding a leaf on the way
     *    out — puts a stamp on the wire describing a value the frame does not
     *    contain. Every receiver then reads the same stamp against a different
     *    value, which is precisely the corrupt-register case `merge.ts` handles
     *    by preferring the incoming one, so the two sides swap forever.
     *
     * This is the one place both halves are visible at once, so it is the only
     * place the check can be local. A mismatch drops the STAMP, never the value:
     * an unstamped value can be out-ranked, which is recoverable, while a
     * mispaired stamp is a lie that out-ranks the truth.
     */
    wireStamps: (body) => {
      const map: Record<string, StampTuple> = {};
      /*
       * The wire twin of `saveClock`'s pass one.
       *
       * `RESERVED_NEWEST_STAMPS` reserved the newest few stamps, which answers
       * "was this the last thing touched?" — and the question a room actually
       * needs answered is "has the room HEARD this write yet?". One ordinary
       * multi-leaf config commit issues a stamp per leaf, so 300 knobs push an
       * unheard tap out of the newest eight immediately: measured, a passive
       * display showed the wrong value for 20.2 s at 300 knobs and 96.2 s at
       * 400, on a plain sequential edit with no race and no skew.
       *
       * So the paths the room has not heard travel with the map, newest-first
       * among themselves, and `fitStateEnvelope` takes them before anything
       * else. This is the only place that knows both halves.
       */
      const unshippedPaths: string[] = [];
      const leaves = enumerateLeaves(body);
      let mismatched = 0;
      for (const [path, register] of stampedNewestFirst()) {
        if (!leaves.has(path)) continue;
        if (!deepEqual(leaves.get(path), register.value)) {
          mismatched += 1;
          continue;
        }
        map[path] = encodeStamp(register.stamp);
        if (unshipped.has(path)) unshippedPaths.push(path);
      }
      if (mismatched > 0)
        log.warn(
          `dropped ${String(mismatched)} stamp(s) whose value the outgoing body does not carry`,
        );
      return { map, clock: encodeStamp(clock), unshipped: unshippedPaths };
    },
    ...(o.factories === undefined ? {} : { factories: o.factories }),
  });

  /** On the MONOTONIC clock, and `-Infinity` so the first write is never held. */
  let lastPersistAt = -Infinity;
  /** The last layer summary printed, so DEV logs only the transitions. */
  let lastTrace: string | null = null;

  function patch(): DeepPartial<AppState> {
    const leaves = new Map<string, unknown>();
    for (const [path, register] of registers) leaves.set(path, register.value);
    return leavesToPatch(leaves);
  }

  /*
   * ── Persisting remote state: throttled with a TRAILING edge ────────────────
   *
   * Leading-edge alone DROPS the last write of a burst, and the last write of a
   * burst is the only one that matters — it is the value that is still true.
   * Measured, not feared: two frames a fifth of a second apart left the stored
   * document holding the FIRST one for the next two seconds, so the config page
   * read a superseded module out of storage and republished it, and a display
   * reloading inside that window cold-booted into a state nobody had asked for.
   */
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistPending = false;

  function persistNow(): void {
    lastPersistAt = monotonicNow();
    try {
      /*
       * The RESOLVED state, never the raw remote body.
       *
       * `commit()` overwrites the snapshot outright, so writing the peer's body
       * here would throw away the answer `resolveState` produced — defeating
       * `url`, and putting a value back on screen that this page had already
       * merged past. Persisting what we actually resolved is the SAME write in
       * the cold-boot case and the correct one in every other.
       *
       * RE-RESOLVED at the moment of the write rather than captured when it was
       * scheduled: a trailing write carrying a state resolved two seconds ago
       * overwrote every local edit made inside the throttle window.
       *
       * `origin: 'sync'` keeps it out of the register table: this is the page
       * writing down what it holds, not the page deciding anything.
       */
      const next = resolveState({ persisted: o.persisted(), remote: patch(), url: o.url }).state;
      o.store.commit((s) => ({ ...s, ...stateToSyncBody(next) }), { origin: 'sync' });
    } catch (err) {
      log.warn('could not persist remote state', err);
    }
    saveClock();
  }

  /*
   * Measured on a MONOTONIC clock, and defensively clamped on top of that.
   *
   * `Date.now() - lastPersistAt` after a backward wall-clock step is negative,
   * which both fails the "enough time has passed" test and schedules the
   * trailing write `|step|` into the future — an hour, for an hour-long step —
   * behind a `if (timer !== null) return` guard that then swallows every write
   * until it fires. See `src/lib/monotonic.ts`; the publish throttle in
   * `SyncService.ts` had the identical arithmetic and the identical repair.
   */
  function schedulePersist(): void {
    const elapsed = monotonicNow() - lastPersistAt;
    if (elapsed < 0 || elapsed >= PERSIST_REMOTE_THROTTLE_MS) {
      persistNow();
      return;
    }
    persistPending = true;
    if (persistTimer !== null) return;
    const delay = Math.min(
      Math.max(PERSIST_REMOTE_THROTTLE_MS - elapsed, 0),
      PERSIST_REMOTE_THROTTLE_MS,
    );
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!persistPending) return;
      persistPending = false;
      persistNow();
    }, delay);
  }

  /*
   * A document arriving from storage is re-resolved through the layers.
   *
   * The other CAM browser writes to this document, and so does the display
   * every time `persistRemote` fires. Without this the store simply adopted
   * whatever it read, which threw away the merged registers and `url` — and on
   * the config page the very next `store.subscribe` republished that raw
   * document as this page's own desire. See `Store.setResolve`.
   */
  o.store.setResolve(
    (persistedDoc) => resolveState({ persisted: persistedDoc, remote: patch(), url: o.url }).state,
  );

  const stopFolding = o.store.onCommit((next, origin, before) => {
    /*
     * A `'sync'` commit is this page WRITING DOWN what it already holds (the
     * `persistRemote` path above). Stamping it would re-date every leaf in the
     * document to now, twice a second, and hand this page the whole room.
     */
    if (origin !== 'local') return;
    const was = enumerateLeaves(stateToSyncBody(before));
    const now = enumerateLeaves(stateToSyncBody(next));
    let wrote = false;
    for (const [path, value] of now) {
      if (deepEqual(was.get(path), value)) continue;
      registers.set(path, { value, stamp: nextStamp() });
      if (!heardFromRoom) intents.add(path);
      // The room has not heard this yet, so no cap may evict it. See `unshipped`.
      unshipped.add(path);
      wrote = true;
    }
    /*
     * A register whose leaf the document no longer has is a register with
     * nothing to defend.
     *
     * This loop used to iterate `now` alone, so a deleted module-config key kept
     * its register for the life of the device — occupying a slot the caps then
     * spent on nothing, and helping push a live write off the end. A leaf the
     * room genuinely deleted is carried by `look.order` and by the body, not by
     * leaf absence, so dropping the register here costs the deletion nothing.
     */
    for (const path of [...registers.keys()]) {
      if (now.has(path) || !was.has(path)) continue;
      registers.delete(path);
      intents.delete(path);
      unshipped.delete(path);
      wrote = true;
    }
    if (!wrote) return;
    clockDirty = true;
    saveClock();
  });

  service.onState((body, meta) => {
    /*
     * The Lamport counter, kept fed.
     *
     * `AppState.rev` no longer orders anything in this layer — the stamps do —
     * but it is still what `src/state/storage.ts` uses to arbitrate two writers
     * of ONE localStorage document, and a counter that never observes anything
     * is not a counter. This is the observation.
     */
    if (meta.rev !== null) noteSeenRev(meta.rev);

    /*
     * ── Step 1: the ROOM CLOCK, which is a different question from the HLC ──
     *
     * The HLC says "later than everything I have HEARD"; the offset says "what
     * time is it where the room is" — which is what a peer needs after an
     * outage longer than its own skew, because every write it slept through is
     * one it has not heard and `seen.t` therefore cannot floor it high enough.
     *
     * TWO samples, and both are needed. `meta.clock.t` is the sender's HLC,
     * which is a room-wide high-water mark but only reflects clocks that have
     * actually WRITTEN something; in a room where the only writer so far is the
     * slow device, it reads back the slow device's own time and teaches nothing.
     * `meta.ts` is the sender's own `roomNow()` — its wall clock plus whatever
     * offset it has learned — so a peer with a correct clock advertises the
     * correct time by existing, whether or not it has ever touched a setting.
     * That is the sample that closes the hole. It cannot run away: a peer's
     * `roomNow()` is a `max` of readings it has folded, each clamped to
     * `MAX_ROOM_OFFSET_MS`, so passing it on adds nothing to the bound.
     *
     * `ts` still orders nothing — see `Envelope.ts`. It is read here only as a
     * clock reading, folded by `max`, clamped, and never allowed to go negative.
     *
     * It also drains the intent layer — a tap made before this page had heard
     * anything is re-stamped now, so it lands after everything the room had
     * decided and the merge below cannot overturn it.
     */
    foldRoomFrame(meta);

    /*
     * ── Step 2: absorb the frame's clock ───────────────────────────────────
     *
     * Before anything is merged, because the next stamp this page issues must
     * be later than everything this frame knows about — including writes whose
     * stamps were trimmed off it and writes by peers this page has never heard
     * from. This is the whole of what remains of causality tracking, and it is
     * two lines.
     *
     * It is also, on its own, what keeps a peer with a wildly wrong clock from
     * owning the room: having absorbed its stamp, this page's next write is
     * ordered after it. See `MAX_ROOM_OFFSET_MS`.
     */
    for (const stamp of meta.stamps.values()) clock = maxStamp(clock, stamp);
    if (meta.clock !== null) clock = maxStamp(clock, meta.clock);

    /*
     * ── Step 3: merge ──────────────────────────────────────────────────────
     *
     * No retained branch, no rev floor, no acknowledgement: a replay is a frame
     * whose stamps are old, and old loses. A leaf the body does not mention —
     * the modules a `partial` snapshot dropped — is a leaf this page keeps.
     */
    const look = body.look === undefined ? undefined : withBaseKind(body.look, body.activeModuleId);
    const incoming = new Map<string, Register>();
    for (const [path, value] of enumerateLeaves(look === undefined ? body : { ...body, look })) {
      incoming.set(path, { value, stamp: meta.stamps.get(path) ?? EPOCH });
    }
    const changed = mergeInto(registers, incoming);
    if (changed) clockDirty = true;

    const resolved = resolveState({ persisted: o.persisted(), remote: patch(), url: o.url });
    if (import.meta.env.DEV) {
      const trace = `${resolved.state.activeModuleId} ${String(registers.size)} leaves, ${String(
        stampedNewestFirst().length,
      )} stamped`;
      if (trace !== lastTrace) {
        lastTrace = trace;
        log.debug(`merged: ${trace}`);
      }
    }
    o.store.replace(resolved.state);
    o.onRemoteState?.(resolved.state, meta);

    if (o.settings.persistRemote) schedulePersist();
    else saveClock();
  });

  /*
   * `cmd` and `tele` carry no state and are folded for their CLOCK alone.
   *
   * A display never publishes state, so in the shipped display-only room the
   * telemetry it emits every two seconds is the only evidence of room time a
   * phone will ever receive. Folding it here is what keeps that phone from
   * stamping in its own skewed past for the whole life of the session — and
   * from persisting `heard: false` and doing it again after every reload.
   */
  service.onCmd((body, meta) => {
    foldRoomFrame(meta);
    saveClock();
    o.onCmd?.(body, meta);
  });
  service.onTele((body, meta) => {
    foldRoomFrame(meta);
    saveClock();
    o.onTele?.(body, meta);
  });
  if (o.onStatus !== undefined) service.onStatus(o.onStatus);

  try {
    await service.start();
  } catch (err) {
    log.warn('sync failed to start — the display keeps running without it', err);
  }

  /**
   * `stop()` is reachable from two directions — React effect cleanup and the
   * `pagehide` flush listener — and both can fire for the same page load.
   * `SyncService.stop()` aborts a shared `AbortController` and awaits every
   * transport's `disconnect()`, so calling it twice would race a second
   * `end(false, …)` against the first one's flush window. One promise,
   * memoised, is the whole guard.
   */
  let stopping: Promise<void> | null = null;

  return {
    service,
    remoteLayer: () => patch(),
    stampedLeaves: () => stampedNewestFirst().map(([path, r]) => ({ path, stamp: r.stamp })),
    stop: () =>
      (stopping ??= (async () => {
        stopFolding();
        /*
         * ── The shutdown flush, in the only safe order ────────────────────────
         *
         * VALUES first, STAMPS second. `stop()` used to clear the pending
         * document write and save the clock anyway, which left a slot whose
         * stamps described values the document did not contain — the seam that
         * laundered a superseded value across a whole room (see `ClockSlot`).
         * The slot is self-contained now, so this is no longer load-bearing for
         * correctness; it still matters, because the document is what a cold
         * boot reads before any peer says anything, and throwing away the last
         * write of a session means booting into a state nobody asked for.
         *
         * A `pagehide` handler gets one synchronous localStorage write or two.
         * These are they.
         */
        if (persistTimer !== null) clearTimeout(persistTimer);
        persistTimer = null;
        const flushDocument = persistPending && o.settings.persistRemote;
        persistPending = false;
        clockDirty = true;
        // `persistNow` commits the document and then calls `saveClock` itself.
        if (flushDocument) persistNow();
        else saveClock();
        o.store.setResolve(null);
        await service.stop();
      })()),
  };
}

/** Exported for `appSync.test.ts`: the leaf enumeration is the whole contract. */
export { enumerateLeaves, leavesToPatch, deepEqual } from './leaves';
export { BASE_KIND_LEAF };
