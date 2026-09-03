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
import {
  BASE_KIND_LEAF,
  LAYER_LEAF_PREFIX,
  ORDER_LEAF,
  deepEqual,
  enumerateLeaves,
  leavesToPatch,
  withBaseKind,
} from './leaves';
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
 * How long a page may hear NOTHING before it treats itself as out of touch.
 *
 * ## Why a page needs this at all
 *
 * The intent layer's question is "have I heard the room since I went dark?",
 * and the two honest answers a page can compute are the transport's own status
 * and the age of the last frame it folded. The status is exact and it is not
 * enough on its own: a screen lock, a lift, a backgrounded tab and a
 * `pagehide`/`visibilitychange` suspension all stop frames arriving without
 * necessarily producing a status EVENT, and the one moment that matters — the
 * tap the instant the screen comes back — happens after the link reads online
 * again. So the age of the last inbound frame is the second reading, and it is
 * the only one available at that instant.
 *
 * ## Where the number comes from, and what it costs
 *
 * A room with a Kraken in it beats continuously: the display's replica monitor
 * is 2.5 s (`MONITOR_PERIOD_MS`) and video telemetry is faster. Five seconds is
 * twice the slowest of those and well inside the shortest outage a person
 * notices, so a connected room never trips it and a locked screen always does.
 *
 * It is a heuristic, and the cost is stated rather than hidden: in a room with
 * NO telemetry — `publishTelemetry` off, or no display at all — a quiet stretch
 * longer than this makes the next local write an intent, so if somebody else
 * taps the same leaf inside the following round trip, the re-stamp hands the
 * contest to this page rather than to whichever clock read later. That is the
 * "genuinely simultaneous" case `docs/remote-control.md` already says is
 * decided arbitrarily, widened by one round trip. The alternative — leaving the
 * write stamped in the page's own past — loses the tap outright, which is worse.
 */
export const ROOM_SILENCE_MS = 5000;

/**
 * How long the room gets to claim a change that arrived as a DOCUMENT.
 *
 * CAM's two browsers share an origin, so a write by one of them reaches the
 * other synchronously, through the in-memory bus — always sooner than the same
 * change coming back around the room as a frame. A PAIRED CAM makes both; an
 * unpaired one, and CAM's Home screen before `useSync` was hoisted to the config
 * app root, makes only the document.
 *
 * The display cannot tell those apart at the instant the document lands, and
 * guessing wrong in the paired direction is not harmless: it re-stamps somebody
 * else's write with the display's own clock and client id, which is not a lie
 * any receiver can detect and which changes who wins a contested leaf (the
 * arbitration `hlcFloorPin` and `clockSkew` pin). So it waits one round trip.
 * 600 ms is the publish throttle (200 ms) plus a slow broker's hop and change,
 * comfortably inside the "did that click do anything?" threshold, and every
 * paired write is claimed long before it elapses.
 *
 * See `noteDocumentWrite`.
 */
export const DOCUMENT_ADOPT_GRACE_MS = 600;

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
 *    The intent layer does not save it and cannot: a returning peer's write IS
 *    re-stamped now (see below), but the re-stamp is `tick(clock, roomNow())`
 *    and this peer's `roomNow()` is the thing that is a day short. INSIDE the
 *    clamp the re-stamp lands the tap, which is what the clamp buys.
 *  - one far-future stamp PINS every peer's floor at its own `t` until real time
 *    catches up — three days, for a peer three days fast — and while `t` is
 *    frozen the total order degrades to `(c, s)`, where `c` is a per-peer
 *    counter and `s` is the writer's client id in STRING order. The poison is in
 *    the register the room agreed on, not in the peer: neither correcting the
 *    clock nor reloading the page unsticks it, and the bad peer's process, slot
 *    and clock can all be gone from the room.
 *
 *    What this costs is now narrower than it was, and the difference is the
 *    intent layer's re-arm. A peer coming back from an outage re-stamps its
 *    first write against the frame that greeted it, so its `c` is one past the
 *    clock it just folded and its LATER TAP WINS even under a pinned `t` — the
 *    case that used to be measured as "the last finger lost to alphabetical
 *    order". What remains is two peers that were BOTH connected the whole time
 *    tapping the same leaf inside one round trip: neither is holding an intent,
 *    so neither re-stamps, `t` is frozen for both, and the tie really is decided
 *    by `(c, s)`. That is the same simultaneity `docs/remote-control.md` already
 *    says the room resolves arbitrarily — with a pinned `t` it resolves
 *    arbitrarily by client id rather than by clock.
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
   *
   * ## What arms it, in full: a write the room has not heard is an INTENT
   *
   * "Have I ever heard the room?" is the question this layer was written for and
   * it is the wrong one on its own, because it is only ever asked once per
   * device. The question a page actually needs answered before every write is
   * "have I heard the room SINCE I went dark?", and there are three ways to be
   * dark, all of which lose the write the same way:
   *
   *  - a page that has never heard the room at all (the original case);
   *  - a page whose PREVIOUS SESSION never heard the room, restored below — the
   *    intents set used to be in-memory only, so a phone that opened with no
   *    connectivity, tapped, and reloaded came back holding its offline write
   *    stamped against a clock it had no reason to trust. Measured: lost at
   *    three seconds of skew, permanently, across every subsequent reload;
   *  - a page whose LINK IS DOWN, or that is back up and has not yet folded a
   *    frame. Measured with every clock in the room correct: phoneB taps, locks
   *    its screen, phoneA's clock steps forward ten seconds (an NTP correction),
   *    phoneA taps, and the room moves on; phoneB unlocks and taps at once and
   *    its tap is reverted on every screen. Its `roomNow()` was frozen at its
   *    last fold plus monotonic elapsed and the ROOM had moved forward — so the
   *    boundary was never the clamp, it was the room's forward clock motion
   *    during the deaf window, which any in-clamp skew on ANOTHER device
   *    produces.
   *
   * All three are the same fact — this write is one the room has not heard — and
   * all three now hold the write as an intent: it takes effect locally at once,
   * and it is re-stamped against the FIRST frame folded after the link is (back)
   * up, which by construction is after everything that sender had accounted for.
   * `outOfTouch()` is the test; `ROOM_SILENCE_MS` says what "dark" means for the
   * case a status flag cannot see.
   */
  const intents = new Set<string>();
  let heardFromRoom = restored?.heard ?? false;
  /*
   * A page whose previous session heard NOTHING has, by construction, only its
   * OWN writes in the restored table: `heard` is set by the first inbound frame
   * on any channel, so a restored register cannot have come from a merge. Every
   * one of them was stamped against a clock this device had no reason to trust,
   * and re-stamping exactly those is the intent layer's whole job.
   *
   * Derived from `heard` plus the restored paths, both of which the v2 slot
   * already carries — no new slot key, no version bump.
   */
  if (!heardFromRoom) for (const path of registers.keys()) intents.add(path);

  /** On the MONOTONIC clock. `null` until the first frame of any kind lands. */
  let lastFoldAt: number | null = null;

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
  /**
   * ── How long each unshipped write has WAITED ───────────────────────────────
   *
   * A monotonic counter, recorded when a path ENTERS the unshipped set and
   * dropped with it, so `wireStamps` can hand the paths over oldest-wait-first.
   *
   * It exists because the wire budget was evicting exactly the wrong stamp, in
   * the mirror image of the slot bug `unshipped` itself was written for.
   * `fitStateEnvelope` takes the unshipped head before anything else — but it
   * took the NEWEST of that head, in `stampedNewestFirst()` order, and rotated
   * the rest. An offline tap made BEFORE a multi-leaf config commit is therefore
   * the OLDEST entry in its own head and rotates to the back of a queue hundreds
   * long. Round 8 closed the tap-then-tune order for an ONLINE peer, whose head
   * drains a few stamps per frame as they ship; a peer that is offline while
   * writing has nothing draining, so the head is the whole write set when the
   * radio returns. Measured on an eight-layer look: the phone taps 90 offline,
   * tunes 400 knobs, and reconnects for six seconds — 29 state frames leave it
   * and NOT ONE carries `render.rotate`'s stamp. Every one carries the value
   * BARE, which reads as EPOCH and loses to the room's stamped 270, so the tap
   * is reverted on the Kraken and on CAM permanently, with `lastError` null and
   * the status line reading online. At 470 knobs the same room took 32 s to
   * converge even when the tap was the write that should have won.
   *
   * The oldest unshipped register is by construction the one at greatest risk of
   * never travelling, and this is `saveClock`'s slot invariant restated for the
   * wire: a budget may only drop a stamp the room already holds, and among the
   * stamps the room does NOT hold, the one that has waited longest goes first.
   */
  const unshippedSeq = new Map<string, number>();
  let unshippedCounter = 0;

  function markUnshipped(path: string): void {
    if (unshipped.has(path)) return;
    unshipped.add(path);
    unshippedCounter += 1;
    unshippedSeq.set(path, unshippedCounter);
  }

  function clearUnshipped(path: string): boolean {
    unshippedSeq.delete(path);
    return unshipped.delete(path);
  }

  /** The unshipped paths, oldest wait first — the order the wire ships them in. */
  function unshippedOldestFirst(paths: Iterable<string>): string[] {
    return [...paths].sort((a, b) => (unshippedSeq.get(a) ?? 0) - (unshippedSeq.get(b) ?? 0));
  }

  if (restored !== null) {
    /*
     * Seeded IN WAIT ORDER, so the counter means the same thing across a reload.
     *
     * `saveClock` writes the array oldest-wait-first for exactly this. A slot
     * from a build that predates the key says nothing at all, and "says nothing"
     * has to mean "assume none of it shipped" — so every restored register is
     * unshipped, ordered by its stamp, which is the only proxy for wait order a
     * silent slot leaves behind.
     */
    if (restored.unshipped === undefined)
      for (const [path] of [...registers].sort((a, b) => compareStamps(a[1].stamp, b[1].stamp)))
        markUnshipped(path);
    // Intersected with what actually restored: a path the slot named but whose
    // register was dropped (an unparseable stamp, a half register) has nothing
    // left to defend.
    else for (const path of restored.unshipped) if (registers.has(path)) markUnshipped(path);
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
   *
   * ORDER MATTERS inside this function, and it is the whole of why the re-arm
   * works: the room-time samples are folded FIRST, so the re-stamp below is
   * taken against a `roomNow()` that already knows what time this frame says it
   * is. A phone whose room clock was frozen at its last fold plus monotonic
   * elapsed learns the room's forward motion here, one line before it uses it.
   */
  function foldRoomFrame(meta: RecvMeta): void {
    noteRoomTime(meta.ts);
    if (meta.clock !== null) noteRoomTime(meta.clock.t);
    lastFoldAt = monotonicNow();
    if (!heardFromRoom) {
      heardFromRoom = true;
      clockDirty = true;
    }
    if (intents.size === 0) return;
    for (const path of intents) {
      const held = registers.get(path);
      if (held === undefined) continue;
      registers.set(path, { value: held.value, stamp: nextStamp() });
      /*
       * The room has not heard THIS stamp — it may well have heard the value
       * under the old one — so the write goes back to the front of the wire's
       * unshipped queue. `onStateShipped` can only ever be too conservative, and
       * this is the direction that costs a little budget rather than an edit.
       */
      markUnshipped(path);
    }
    intents.clear();
    clockDirty = true;
  }

  /**
   * "Has this page heard the room since it went dark?" — the intent layer's arm.
   *
   * Two readings, because neither alone can answer it. See `ROOM_SILENCE_MS`.
   */
  function outOfTouch(): boolean {
    const status = service.status();
    /*
     * The room's transport, by the same rule `roomTransports()` uses on the far
     * side of the wire: the network slot when the room has one, the zero-network
     * slot only when it has not. A page with a network transport that is offline
     * has not heard the room, however happily its localStorage echo resolves.
     */
    const linkUp =
      status.network === 'online' || (status.network === 'idle' && status.local === 'online');
    if (!linkUp) return true;
    if (lastFoldAt === null) return true;
    return monotonicNow() - lastFoldAt > ROOM_SILENCE_MS;
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
          /*
           * Exactly the pass-1 paths that actually made it into `stamps`, so the
           * next page load gives them the same priority this one did — written
           * OLDEST WAIT FIRST, which is the order the restore seeds the counter
           * in and the order the wire ships them in. The packing above is
           * newest-first (what survives a full slot) and this is wait order
           * (what leaves first); they are different questions about the same set.
           */
          unshipped: unshippedOldestFirst(
            unshippedFirst.map(([path]) => path).filter((path) => path in stamps),
          ),
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
      for (const path of paths) changed = clearUnshipped(path) || changed;
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
       * So the paths the room has not heard travel with the map, and
       * `fitStateEnvelope` takes them before anything else. This is the only
       * place that knows both halves.
       *
       * OLDEST WAIT FIRST, not newest-stamp-first: among the stamps the room
       * does not hold, the one that has waited longest is the one at greatest
       * risk of never travelling at all. See `unshippedSeq` for the measured
       * loss that order was hiding.
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
      return {
        map,
        clock: encodeStamp(clock),
        unshipped: unshippedOldestFirst(unshippedPaths),
      };
    },
    ...(o.factories === undefined ? {} : { factories: o.factories }),
  });

  /**
   * ── The same-origin DOCUMENT, as a stamped write channel ───────────────────
   *
   * ## The room this was missing
   *
   * CAM opens two Chromium browsers on one origin, and the configuration one
   * spends its whole life on `#/`, where nothing mounts a sync layer: the
   * module chips, the looks, the editor and every setting are on the HOME
   * screen, and `useSync` was only ever called from About, Library and Remote.
   * So a person editing in CAM published NO state frame at all — the shared
   * `kraken-hub:v1:state` document was their only channel to the LCD.
   *
   * That channel worked for exactly as long as the display's register table was
   * empty. The first inbound state frame gives it a register for EVERY leaf of
   * `stateToSyncBody` — `mergeInto` creates one wherever it holds none, EPOCH
   * stamps included — and from that instant `patch()` covers the whole synced
   * document, `remote` outranks `persisted` in `resolveState` with nothing to
   * arbitrate, and `persistNow()` writes the masked resolution back over CAM's
   * value. One phone opening its Remote tab is enough to arm it. Measured: CAM
   * clicks Clock, the LCD holds Video for as long as anybody watched, and the
   * document is rewritten to Video behind the click. The phone kept working the
   * whole time, because a phone's edits arrive as STAMPED FRAMES and win the
   * comparison, while CAM's arrive as a DOCUMENT the merge never sees.
   *
   * ## The repair, in one sentence
   *
   * A document written by another browser on this origin is a decision that
   * nobody put on the wire, so — unless the room says it first — the display
   * stamps it like one and publishes it, and the phone learns what CAM did even
   * though CAM said nothing.
   *
   * ## The four things that make it safe, each of which is measured
   *
   *  - **Diffed against the PREVIOUS DOCUMENT, never against the registers.**
   *    A document carries every leaf, most of them untouched by the write that
   *    delivered it, so "differs from my register" would adopt the whole
   *    document — including leaves where a peer's newer frame is right and the
   *    document is merely two seconds stale, which would revert a phone's edit
   *    every time CAM saved anything. What a write actually decided is what
   *    CHANGED in it, and that is a question about two documents.
   *  - **This page's own writes are skipped by `writerId`.** `commit()` fires
   *    the in-memory bus synchronously, so a page's own document write comes
   *    straight back through `watchState` into this resolver — the echo
   *    suppression in `src/state/storage.ts` covers the `storage` event and the
   *    poll, and deliberately not the bus. Without the check the display would
   *    re-stamp its own `persistRemote` write twice a second and hand itself
   *    the whole room.
   *  - **Only the DISPLAY adopts.** It is the page for which the document is a
   *    channel it has no other copy of: every other surface either publishes its
   *    own decisions (`useSync`, now mounted on Home too) or has no sync layer
   *    running at all. Letting a configuration page adopt as well made it revert
   *    ITSELF — the display's `persistRemote` transcription is a document write
   *    like any other, and a CAM page that adopted it re-stamped the value it
   *    had just replaced.
   *  - **A browser this page HEARS is never adopted from.** A paired CAM writes
   *    the document AND publishes a frame, and the document always arrives first
   *    — it is a synchronous call on the same origin, while the frame is a round
   *    trip. Adopting it would re-stamp somebody else's write with the DISPLAY's
   *    clock and client id, which no receiver can detect and which changes who
   *    wins a contested leaf: exactly the arbitration `hlcFloorPin` and
   *    `clockSkew` pin, and measured to flip three of their rows.
   *
   *    A page's `clientId()` is BOTH its document `writerId` and the `src` on
   *    every frame it sends, so "have I ever heard a state frame from the
   *    browser that wrote this?" is an exact question with an exact answer, and
   *    a yes means the document is redundant. `DOCUMENT_ADOPT_GRACE_MS` is the
   *    same rule in the time dimension: it gives a browser that has only just
   *    started publishing one round trip to be heard from before its document
   *    write is treated as the only copy.
   *
   *  - **A leaf the URL layer owns is never adopted.** `persistNow` writes the
   *    RESOLVED state, so a display opened with `?fit=contain` has that value in
   *    its document; adopting it would publish a per-link override into the
   *    room, which is the one thing the URL layer is not for.
   */
  let lastDocLeaves = enumerateLeaves(
    stateToSyncBody(resolveState({ persisted: o.persisted() }).state),
  );

  /** Leaves an arriving document changed, and who wrote them, waiting one round trip. */
  const pendingDoc = new Map<string, { value: unknown; writer: string }>();
  let pendingDocTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Every peer this page has folded a STATE frame from, by `src`.
   *
   * The same string a page writes into `AppState.writerId`, because both are
   * its `clientId()`. That is what makes "this browser speaks for itself" a
   * fact rather than a guess — see the note above.
   */
  const heardStateFrom = new Set<string>();

  /** Does the URL layer define a value at, above, or below this leaf path? */
  function urlMasks(path: string): boolean {
    let node: unknown = o.url;
    for (const part of path.split('.')) {
      if (node === undefined) return false;
      // A scalar above the leaf: the URL owns the whole subtree under it.
      if (!isPlainObject(node)) return true;
      node = node[part];
    }
    return node !== undefined;
  }

  /**
   * Adopt whatever the room did not claim in the meantime, and publish it.
   *
   * Two tests, and they are the same test asked twice: has this decision
   * reached the room by itself? A writer this page has heard a frame from
   * speaks for itself, and a leaf whose register already holds the document's
   * value has been spoken for. What survives both is a decision with no other
   * way onto the wire.
   */
  function drainPendingDocument(): void {
    pendingDocTimer = null;
    // A page that has been told to stop adopts nothing. See `stopped`.
    if (stopped) {
      pendingDoc.clear();
      return;
    }
    /*
     * Asked ONCE per drain, on exactly the rule a local commit uses: a decision
     * taken while this page could not hear the room is an intent, re-stamped
     * against the first frame that arrives. See the intent layer.
     */
    const asIntent = !heardFromRoom || outOfTouch();
    let adopted = false;
    for (const [path, { value, writer }] of pendingDoc) {
      if (heardStateFrom.has(writer)) continue;
      const held = registers.get(path);
      if (held !== undefined && deepEqual(held.value, value)) continue;
      registers.set(path, { value, stamp: nextStamp() });
      if (asIntent) intents.add(path);
      // The room has not heard this yet, so no cap may evict it. See `unshipped`.
      markUnshipped(path);
      adopted = true;
    }
    pendingDoc.clear();
    if (!adopted) {
      // A save that waited for this drain still has to happen.
      if (persistPending && o.settings.persistRemote) schedulePersist();
      return;
    }
    clockDirty = true;
    saveClock();
    const resolved = resolveState({ persisted: o.persisted(), remote: patch(), url: o.url }).state;
    /*
     * ── And the display stops being a pure sink, for this one reason ─────────
     *
     * A display was `grep publishState`-provably a sink, and everything else
     * about it still is: it never volunteers a snapshot, never republishes what
     * it was told, and answers nothing on the state channel. But it is the ONLY
     * page that can see what CAM's configuration window just decided — CAM
     * shares an origin with it and shares nothing with the phone — so if the
     * display does not carry that decision onto the wire, the phone cannot learn
     * it at all.
     *
     * Coalesced rather than `immediate`: `SyncService` batches at 5 Hz, which is
     * far faster than the eye and keeps a slider dragged in CAM from becoming
     * one frame per pixel.
     */
    service.publishState(stateToSyncBody(resolved), { rev: resolved.rev });
    o.store.replace(resolved);
    // Write the adopted resolution down — the save this drain was holding back,
    // now carrying the decision rather than the value it replaced.
    if (o.settings.persistRemote) schedulePersist();
  }

  /** Queue what one arriving document changed. See the note above. */
  function noteDocumentWrite(doc: AppState): void {
    const incoming = enumerateLeaves(stateToSyncBody(doc));
    const previous = lastDocLeaves;
    lastDocLeaves = incoming;
    if (doc.writerId === o.clientId) return;
    if (o.role !== 'display') return;
    // This browser publishes its own decisions — see the note above.
    if (heardStateFrom.has(doc.writerId)) return;
    /*
     * A DECISION, never a transcription.
     *
     * Both CAM's browser and this one commit the state they resolve from the
     * room every two seconds (`persistRemote`), and those writes are documents
     * like any other. Adopting one re-stamps a value the room already settled as
     * though it were fresh — and a CAM window whose radio is down transcribes
     * the room AS IT LAST HEARD IT, so the stale save reverts everything that
     * happened while it was away. Measured on a muted CAM: a phone's tap
     * reverted room-wide by a routine save nobody made.
     *
     * See `AppState.writerOrigin`, including why a document that does not carry
     * the field at all is treated as a transcription.
     */
    if (doc.writerOrigin !== 'local') return;

    let queued = false;
    for (const [path, value] of incoming) {
      if (deepEqual(previous.get(path), value)) continue;
      if (urlMasks(path)) continue;
      pendingDoc.set(path, { value, writer: doc.writerId });
      queued = true;
    }
    if (!queued || pendingDocTimer !== null) return;
    pendingDocTimer = setTimeout(drainPendingDocument, DOCUMENT_ADOPT_GRACE_MS);
  }

  /** On the MONOTONIC clock, and `-Infinity` so the first write is never held. */
  let lastPersistAt = -Infinity;
  /** The last layer summary printed, so DEV logs only the transitions. */
  let lastTrace: string | null = null;

  /**
   * ── A remote layer that names a layer it cannot describe ───────────────────
   *
   * `look.order` and the per-layer leaves are two halves of ONE claim, and
   * `leavesToPatch` needs both: an id in the order with no `look.layer.<id>`
   * leaf beside it is SKIPPED (see `src/sync/leaves.ts`). That is right on the
   * wire, where the body carries every layer it names. It is a lie as a
   * PRECEDENCE PATCH, because `remote` outranks `persisted` and `mergeLeaf`
   * replaces arrays wholesale — so a look with one leaf missing does not fall
   * back to the persisted layer, it deletes it.
   *
   * The register table gets into exactly that shape by ordinary use, and the
   * commonest path is the one a user is most likely to walk. A page stamps only
   * what a commit CHANGED, so the phone adding its first overlay writes
   * `look.order` and `look.layer.<new>` and nothing else — it has never had a
   * reason to stamp `look.layer.base`. From that moment `patch()` claimed an
   * order of two layers while describing one, and the next re-resolve dropped
   * the base out of the phone's own look. Measured on the room harness: the
   * layer the phone had just added was gone from the phone's snapshot half a
   * second later, while the document and the display still held it. It looked
   * like a sync bug and it was a completeness bug.
   *
   * It was invisible for as long as the room was chatty, because any inbound
   * state frame gives `mergeInto` a leaf for every layer in the body and fills
   * the hole. That is why it surfaced the moment idle publishing was gated: the
   * page's own commit was only durable while somebody kept re-notifying it.
   *
   * So the hole is filled from the DOCUMENT — the value this page already holds
   * for that layer — and filled in the patch rather than in the table, because
   * this page has decided nothing about that layer and must not claim a stamp
   * for it. A layer the document cannot describe either is still skipped: there
   * is no value to be had, and skipping is what it has always done.
   */
  function fillOrderedLayers(leaves: Map<string, unknown>): void {
    const order = leaves.get(ORDER_LEAF);
    if (!Array.isArray(order)) return;
    const missing = order.filter(
      (id): id is string => typeof id === 'string' && !leaves.has(`${LAYER_LEAF_PREFIX}${id}`),
    );
    if (missing.length === 0) return;
    const held = enumerateLeaves(stateToSyncBody(resolveState({ persisted: o.persisted() }).state));
    for (const id of missing) {
      const path = `${LAYER_LEAF_PREFIX}${id}`;
      const value = held.get(path);
      if (value !== undefined) leaves.set(path, value);
    }
  }

  function patch(): DeepPartial<AppState> {
    const leaves = new Map<string, unknown>();
    for (const [path, register] of registers) leaves.set(path, register.value);
    fillOrderedLayers(leaves);
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

  /**
   * ── A page that has been told to stop does not write afterwards ────────────
   *
   * `stop()` is not an instant, it is a WINDOW. `SyncService.stop()` awaits
   * every transport's `disconnect()`, and `MqttTransport.disconnect()` uses
   * `end(false, …)` with a 1.5 s ceiling on purpose, so the last frame of a
   * session is not discarded. The subscriptions come down only after that wait
   * — so a frame already on the wire when the page began closing is still
   * delivered to this layer's own handlers.
   *
   * Folding one ended in `schedulePersist()`, which is how a closing page wrote
   * the shared document one more time AFTER its shutdown flush — either
   * straight away, or on a trailing timer up to two seconds later, long after
   * `stop()` had resolved and the caller believed the page was silent.
   *
   * It is the document that makes this more than untidy: it is what the next
   * cold boot reads, so a page that has been closed otherwise gets a vote on
   * what the machine wakes up as, and a page whose radio was stale gets to cast
   * it with a stale snapshot. The e2e cold-boot test caught it as a state
   * document reappearing after it had been deleted, written by a phone that had
   * already gone.
   *
   * So the flag: from the first line of `stop()`, this layer folds nothing,
   * adopts nothing and saves nothing. The one write that still happens is
   * `stop()`'s own flush, which calls `persistNow` directly and is deliberately
   * not gated here. See `src/sync/stopSilence.dom.test.ts`.
   */
  let stopped = false;

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
    /*
     * ── Never transcribe over a decision this page is in the middle of taking ─
     *
     * A document write from the other browser is held for one round trip before
     * it is adopted (`noteDocumentWrite`), and until it IS adopted the register
     * table still holds the old value — so a `persistRemote` save landing inside
     * that window writes the old value back over the write it is about to
     * accept. That is not a cosmetic race: the OTHER browser reads its own
     * snapshot back out of this document, so the save deletes the overlay the
     * person just added from the editor they are still looking at, and the next
     * thing they add is built on a look that lost it. Measured on one origin:
     * add Clock, add Text 1.5 s later, add Date 1.5 s after that, and the
     * stored look ends as `video,date` — each add REPLACING the last, with the
     * rail dropping to zero overlays about 1.2 s after every commit.
     *
     * So the save waits for the drain, which schedules it again on the way out.
     * At most one round trip later, and the throttle it was already under is
     * five times longer than that.
     */
    // A page that has been told to stop makes no further saves. See `stopped`.
    if (stopped) return;
    if (pendingDocTimer !== null) {
      persistPending = true;
      return;
    }
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
      // A timer armed BEFORE the document write is still a save, and it must
      // wait for the drain exactly as a fresh one does. `persistPending` stays
      // true, and `drainPendingDocument` schedules it again.
      if (pendingDocTimer !== null) return;
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
   *
   * It is also, since the CAM-Home regression, the page's SECOND WRITE CHANNEL:
   * a document written by the other browser on this origin is a decision, and
   * `noteDocumentWrite` stamps it like one — after giving the room one round
   * trip to say it first. See that function for why the diff is against the
   * previous document rather than against the register table.
   */
  o.store.setResolve((persistedDoc) => {
    noteDocumentWrite(persistedDoc);
    return resolveState({ persisted: persistedDoc, remote: patch(), url: o.url }).state;
  });

  const stopFolding = o.store.onCommit((next, origin, before) => {
    /*
     * A `'sync'` commit is this page WRITING DOWN what it already holds (the
     * `persistRemote` path above). Stamping it would re-date every leaf in the
     * document to now, twice a second, and hand this page the whole room.
     */
    if (origin !== 'local') return;
    const was = enumerateLeaves(stateToSyncBody(before));
    const now = enumerateLeaves(stateToSyncBody(next));
    /*
     * Asked ONCE per commit, and asked here rather than at the drain: this is
     * the moment the write is made, and "was the room reachable when I tapped?"
     * is a fact about that moment. See the intent layer above.
     */
    const asIntent = !heardFromRoom || outOfTouch();
    let wrote = false;
    for (const [path, value] of now) {
      if (deepEqual(was.get(path), value)) continue;
      registers.set(path, { value, stamp: nextStamp() });
      if (asIntent) intents.add(path);
      // The room has not heard this yet, so no cap may evict it. See `unshipped`.
      markUnshipped(path);
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
      clearUnshipped(path);
      wrote = true;
    }
    if (!wrote) return;
    clockDirty = true;
    saveClock();
  });

  service.onState((body, meta) => {
    // Delivered inside the transport's flush window, to a page that is closing:
    // nothing this frame says can be published, saved or acted on. See `stopped`.
    if (stopped) return;
    /*
     * The Lamport counter, kept fed.
     *
     * `AppState.rev` no longer orders anything in this layer — the stamps do —
     * but it is still what `src/state/storage.ts` uses to arbitrate two writers
     * of ONE localStorage document, and a counter that never observes anything
     * is not a counter. This is the observation.
     */
    if (meta.rev !== null) noteSeenRev(meta.rev);
    // This browser speaks for itself, so its document writes are redundant.
    // See `noteDocumentWrite`.
    heardStateFrom.add(meta.src);

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
    // See `stopped`: a closing page writes nothing, and its clock slot is
    // already written down as it was when the page said its last word.
    if (stopped) return;
    foldRoomFrame(meta);
    saveClock();
    o.onCmd?.(body, meta);
  });
  service.onTele((body, meta) => {
    if (stopped) return;
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
        // First line, before the flush and long before the transports are
        // actually down: from here nothing inbound is folded, adopted or saved,
        // and the only write left is the flush below. See `stopped`.
        stopped = true;
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
        /*
         * A document adoption still waiting out its grace window is dropped
         * rather than flushed: the page is closing, so it can neither publish
         * the frame nor be the thing that answers for it, and a stamp written
         * into the slot for a value the room never heard would be defended by
         * the next page load for nothing.
         */
        if (pendingDocTimer !== null) clearTimeout(pendingDocTimer);
        pendingDocTimer = null;
        pendingDoc.clear();
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
