/**
 * A room that nobody is touching says NOTHING.
 *
 * Every other suite in this directory asserts what the peers agree ON. None of
 * them asked how much they had to say to get there, and the answer — measured
 * on this same harness, on the build the user was running — was ten state
 * frames a second, at rest, forever:
 *
 *   - `src/sync/appSync.ts` calls `store.replace(resolved)` on every inbound
 *     frame, and `resolveState` returns a brand-new object graph every time, so
 *     the store's identity guard never fired and every frame notified.
 *   - `src/app/config/useSync.ts` publishes this page's whole snapshot on every
 *     notification — which the harness models verbatim as `publishOnEveryChange`.
 *   - The peer that receives that frame does the same thing back.
 *
 * Two publishing surfaces (CAM's configuration window and the phone) is all it
 * takes; `PUBLISH_THROTTLE_MS` is 200 ms, so the pair saturates at 5 Hz each.
 * The display is not involved — it is a pure sink — which is why nothing that
 * watched the display ever noticed.
 *
 * The store's value gate closes the mutual echo. See the budget below for the
 * part that is still open, and for why every way of closing it was measured and
 * then rejected.
 *
 * The cost was not bandwidth. Every one of those deliveries rebuilt the
 * editor's compositor from scratch: a new `LayerHost`, a fresh WebGL context,
 * `uTime` back to zero. That is the flicker in the user's report.
 *
 * So quiescence is an invariant now, with a number on it, and this file is
 * where it is pinned. The budgets are deliberately loose — a couple of frames
 * for a settling clock, a handful for a change and its convergence — because
 * what is being caught is a runaway, not a rounding error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  createBroker,
  meterStateFrames,
  note,
  openRoom,
  resetClockSlots,
  resetTrace,
  sleep,
  withStory,
} from './roomHarness';

/** Five seconds of wall clock — the window the user's "5–10 a second" was counted in. */
const WINDOW_MS = 5000;

/**
 * ── The budget, and why it is 20 rather than 2 ─────────────────────────────
 *
 * At the commit this file was written against, all three readings below were
 * **50** — a hard 10 Hz, split evenly between the two publishing peers, with
 * nobody touching anything. Value-gating `store.replace` (`src/state/store.ts`)
 * takes them to **13, 13 and 16**: the mutual echo of unchanged snapshots is
 * gone, and what remains is every page's routine `persistRemote` save — a
 * transcription of the state it already holds — notifying, publishing, and
 * being answered.
 *
 * ## That remainder is anti-entropy, and it was measured three ways
 *
 * It looks like pure waste and it is not. This wire has no acknowledgements:
 * `onStateShipped` can only say that a frame RESOLVED on a transport reading
 * online, never that a peer received it. The only thing that lands a frame
 * which lost a race — a peer mid-reload, a radio that came back between two
 * publishes, a stamp the wire budget rotated off the last frame — is somebody
 * saying it again, and the two-second save is what says it.
 *
 * Three separate idempotent gates were written, and each one reached full
 * quiescence (0 / 2 / 2 or better) and cost a write made in the dark:
 *
 *  - **On the body, in `useSync`** — "say nothing if this body matches the last
 *    one I sent". 13 failures. A frame is a body AND the stamps that date it: a
 *    phone re-stamps a write it made while its radio was down, and the same body
 *    with the new stamp is the entire difference between the tap landing and the
 *    room's value out-ranking it for good.
 *  - **On the whole frame, in `SyncService.flushState`** — body, stamps and all.
 *    22 failures. Recording a frame as said when it was merely handed to a dead
 *    transport silenced the page's own recovery; recording it only on a resolved
 *    publish to an online room transport still failed 14, because "the transport
 *    took it" is not "the room heard it".
 *  - **On the notification a no-op `commit()` raises, in `store.ts`** — with the
 *    save's re-announcement then driven by `unshipped` instead. Down to 3, and
 *    the last 3 are the plainest statement of the problem: a peer that missed one
 *    frame stays wrong forever in a room where nobody says anything twice.
 *
 * All three are reverted. The repetition is the design; what it costs is bounded
 * and is now on the record, and a regression to the 10 Hz storm fails here
 * immediately.
 *
 * Suites that fail when the repetition is removed, for whoever tries again:
 * `persistShippedness`, `intentReloadSkew`, `hlcFloorPin`, `slotCapUnshipped`,
 * `newestStampReserve`, `intentReconnect`. A real fix is an acknowledgement or
 * a digest exchange, not a gate.
 */
const REST_BUDGET = 20;

/** One change, its convergence, and the same routine saves. A loop is 50. */
const CHANGE_BUDGET = 20;

describe('a room at rest', () => {
  beforeEach(() => {
    resetTrace();
    resetClockSlots();
    localStorage.clear();
    resetStateCache();
    commitToStorage((s) => ({ ...s, activeModuleId: 'video' }), { role: 'config' });
  });

  afterEach(() => {
    localStorage.clear();
    resetStateCache();
  });

  it('goes quiet, and stays quiet, with nobody touching anything', async () => {
    const broker = createBroker();
    const meter = meterStateFrames(broker);
    const room = await openRoom(broker);

    try {
      // The room has already settled inside `openRoom`; give the first persist
      // cycle another second to land before the count begins.
      await sleep(1000);
      meter.reset();

      note('---- five seconds, nobody touches anything ----');
      await sleep(WINDOW_MS);
      const frames = meter.total();
      note(`state frames at rest: ${String(frames)}`);

      expect(withStory(String(frames <= REST_BUDGET), 'true')).toBe('true');
    } finally {
      await room.stop();
    }
  }, 60_000);

  it('spends a handful of frames on ONE change made in CAM, then goes quiet', async () => {
    const broker = createBroker();
    const meter = meterStateFrames(broker);
    const room = await openRoom(broker);

    try {
      await sleep(1000);
      meter.reset();

      note('---- CAM rotates to 90 ----');
      room.config.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      await sleep(WINDOW_MS);
      const frames = meter.total();
      note(`state frames after one CAM change: ${String(frames)}`);

      // The change still has to ARRIVE — a budget that passes because nothing
      // moved would be worse than no budget at all.
      expect(withStory(String(room.display.store.getSnapshot().render.rotate), '90')).toBe('90');
      expect(withStory(String(room.phone.store.getSnapshot().render.rotate), '90')).toBe('90');
      expect(withStory(String(frames <= CHANGE_BUDGET), 'true')).toBe('true');
    } finally {
      await room.stop();
    }
  }, 60_000);

  it('spends a handful of frames on ONE change made on the phone, then goes quiet', async () => {
    const broker = createBroker();
    const meter = meterStateFrames(broker);
    const room = await openRoom(broker);

    try {
      await sleep(1000);
      meter.reset();

      note('---- the phone rotates to 270 ----');
      room.phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 270 } }));
      await sleep(WINDOW_MS);
      const frames = meter.total();
      note(`state frames after one phone change: ${String(frames)}`);

      expect(withStory(String(room.display.store.getSnapshot().render.rotate), '270')).toBe('270');
      expect(withStory(String(room.config.store.getSnapshot().render.rotate), '270')).toBe('270');
      expect(withStory(String(frames <= CHANGE_BUDGET), 'true')).toBe('true');
    } finally {
      await room.stop();
    }
  }, 60_000);
});
