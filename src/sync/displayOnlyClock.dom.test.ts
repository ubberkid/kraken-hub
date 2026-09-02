/**
 * The display-only room: what a peer learns when nobody publishes state.
 *
 * This is the shipped shape of a Kraken with one phone pointed at it. The
 * display APPLIES state and never publishes it — that is deliberate, and it is
 * the reason the last-will is on `tele` and not on `state` — and a peer never
 * applies its own echo. So a phone alone with a display receives no `state`
 * frame in its entire session, however long it runs.
 *
 * Two things were wired as if that could not happen.
 *
 *  - **Room time was folded only in `onState`.** The display emits telemetry
 *    every two seconds and the phone read none of it as a clock, so the one
 *    peer with no other source of room time had none at all. A phone 90 s
 *    behind therefore ended its session with `offset = 0`.
 *  - **"Has heard the room" was inferred from "has a persisted HLC".** Those
 *    are different questions, and the room above is where they come apart: the
 *    phone's session leaves a stamp of its own and an offset of zero, so on
 *    reload the intent layer was disarmed for a page that genuinely knew
 *    nothing, and its first tap was stamped 90 s in its own past and lost.
 *
 * And one thing was wired as if a page always gets a second chance: a snapshot
 * handed over inside the 200 ms publish throttle was dropped by `stop()`. In a
 * room with a display and a CAM, CAM's next keepalive papers over it. In this
 * room there is nobody to ask, so the last tap of a session is simply gone.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  HANDSHAKE_MS,
  createBroker,
  installDeviceClocks,
  note,
  resetClockSlots,
  resetTrace,
  restoreDeviceClocks,
  rotateOn,
  settleWithin,
  sleep,
  startDisplayPeer,
  startPhonePeer,
  withStory,
} from './roomHarness';

import type { AppState } from '../state/schema';

const BEHIND_90_S = -90_000;

const setRotate =
  (deg: AppState['render']['rotate']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

describe('a room whose only other peer is a display', () => {
  beforeEach(() => {
    installDeviceClocks();
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

  afterAll(() => {
    restoreDeviceClocks();
  });

  for (const behind of [BEHIND_90_S, 0]) {
    it(`lands the first tap after a reload on a phone ${String(behind / 1000)} s off that heard only telemetry`, async () => {
      /*
       * Skeptic 2's trace 1, with its own control.
       *
       * At −90 s the tap was permanently lost and at 0 it was not, which is
       * what says the mechanism is room time rather than ordering. The phone's
       * FIRST session is where the damage is done: it hears no state frames at
       * all, so unless the display's telemetry teaches it the room's clock it
       * closes having learned nothing, and the reload then stamps in the past.
       */
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      let slow = await startPhonePeer(broker, {
        name: 'slow',
        id: 'slowpeer0001',
        device: 'slowdev',
        offsetMs: behind,
      });
      await sleep(HANDSHAKE_MS * 3);

      /*
       * `good` joins only AFTER the slow phone's session has ended, so that
       * session really is display-only: the one thing the phone can hear is the
       * display's telemetry.
       */
      let good: Awaited<ReturnType<typeof startPhonePeer>> | null = null;
      try {
        note('---- session 1: the slow phone taps 90, and hears no state back ----');
        slow.store.commit(setRotate(90));
        await sleep(HANDSHAKE_MS * 3);
        expect(withStory(rotateOn(display), '90')).toBe('90');

        const inherited = slow.doc();
        await slow.stop();

        note('---- a second phone with a correct clock joins and taps 180 ----');
        good = await startPhonePeer(broker, { name: 'good', id: 'goodpeer0001' });
        await sleep(HANDSHAKE_MS * 3);
        good.store.commit(setRotate(180));
        await sleep(HANDSHAKE_MS * 3);
        expect(withStory(rotateOn(display), '180')).toBe('180');

        note('---- the slow phone reloads and taps 270 inside the retained window ----');
        slow = await startPhonePeer(broker, {
          name: 'slow2',
          id: 'slowpeer0002',
          device: 'slowdev',
          offsetMs: behind,
          initial: inherited,
          handshakeMs: 400,
        });
        slow.store.commit(setRotate(270));

        const peers = [slow, good, display];
        const readings = await settleWithin(
          () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
          12_000,
        );
        const want = 'slow2=270 good=270 display=270';
        expect(withStory(readings.join(' '), want)).toBe(want);
      } finally {
        await slow.stop();
        await good?.stop();
        await display.stop();
      }
    }, 120_000);
  }

  it('publishes a tap made inside the throttle window when the page closes', async () => {
    /*
     * Skeptic 2's trace 2. Two taps forty milliseconds apart: the first goes
     * out at once, the second is held by the 5 Hz throttle, and then the page
     * closes. `stop()` used to clear the timer and drop the snapshot, so the
     * value the user actually left the room in never reached the wall.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const phone = await startPhonePeer(broker, { name: 'phone', id: 'phonepeer001' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- tap 90, then tap 180 forty ms later, then close the page ----');
      phone.store.commit(setRotate(90));
      await sleep(40);
      phone.store.commit(setRotate(180));
      await phone.stop();
      await sleep(3000);
      expect(withStory(`display=${rotateOn(display)}`, 'display=180')).toBe('display=180');
    } finally {
      await display.stop();
    }
  }, 60_000);
});
