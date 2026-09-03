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
 * part that is still open and why it was left open deliberately.
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
 * nobody touching anything. Value-gating `store.replace`
 * (`src/state/store.ts`) takes them to **13, 13 and 16**: the mutual echo of
 * unchanged snapshots is gone, and what remains is the display's routine
 * `persistRemote` save, which bumps `rev` on a document nobody edited, which is
 * a genuine change of state and therefore a genuine notification and publish.
 *
 * Closing that last gap needs an idempotent publish — the page remembering the
 * last `SyncStateBody` it sent and saying nothing when the next notification
 * would repeat it. That was written, measured (it takes all three readings to
 * 0, 2 and 2) and then REMOVED, because it breaks the phone: a layer added on
 * the remote loses its selection the instant the display saves, and ten cases
 * in `tests/e2e/remote-editor.spec.ts` fail with it in and pass with it out.
 * The phone's own resolved snapshot turns out to depend on being re-notified —
 * a defect of its own, and not one to fix behind a performance change.
 *
 * So the budget pins the repair that is real: a room that says a dozen things
 * in five seconds is quiet enough that no compositor rebuilds itself over it
 * (`tests/e2e/mirror-stability.spec.ts` is where THAT is pinned), and a
 * regression to the 10 Hz storm fails here immediately.
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
