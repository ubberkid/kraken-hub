/**
 * The first tap after a screen lock, on a device whose own clock is PERFECT.
 *
 * Both the code and the docs used to state the first-tap-back loss as a property
 * of the victim's own absolute slowness, bounded by `MAX_ROOM_OFFSET_MS`: "a
 * device more than a day SLOW loses its first tap after every outage … the
 * boundary is exactly the clamp".
 *
 * The boundary is not the clamp. It is the ROOM's forward clock motion during
 * the deaf window, and that motion can be produced by an ordinary in-clamp step
 * on ANOTHER device — an NTP correction, a timezone fix, a Kraken with no RTC
 * reaching a time server. `roomOffset` is folded only from INBOUND frames, so a
 * muted peer's `roomNow()` is frozen at "whatever the room read when I last
 * heard it, plus monotonic elapsed" while the room moves on without it.
 *
 * Measured with EVERY clock in the room correct at the start: phoneB taps 90 and
 * locks; phoneA's wall clock steps forward by `step`; phoneA taps 180 and the
 * room folds it; 6.5 s later phoneB unlocks and its owner taps 270 at once.
 *
 *     step  0 s   -> 270 everywhere   PASS
 *     step +1 s   -> 270 everywhere   PASS
 *     step +10 s  -> 180 everywhere   FAIL — phoneB's tap reverted
 *     step +1 h   -> 180 everywhere   FAIL — phoneB's tap reverted
 *
 * The control that pins the mechanism is the same script with phoneA STATICALLY
 * an hour fast from the start, so phoneB folds the offset before it locks: that
 * one always passed, which is what says the defect is the STEP arriving inside
 * the deaf window rather than the skew.
 *
 * The repair is the intent layer, armed on reconnection rather than only on a
 * page that has never heard the room: a write made while the link is down, or
 * between reconnect and the first folded frame, takes effect locally at once and
 * is re-stamped against that first frame. See `appSync.ts`'s `outOfTouch`.
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
  seedEarlierSession,
  settleWithin,
  sleep,
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

const AN_HOUR = 60 * 60 * 1000;

const setRotate =
  (deg: AppState['render']['rotate']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

describe('a phone that unlocks into a room whose clock moved on without it', () => {
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

  /**
   * Lens 3's script. `stepMs` is applied to phoneA mid-outage; `staticMs` is
   * applied to phoneA from the start, which is the control.
   */
  async function runScript(o: {
    stepMs?: number;
    staticMs?: number;
  }): Promise<{ got: string; want: string }> {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const cam = await startConfigPeer(broker, HANDSHAKE_MS);
    const phoneA = await startPhonePeer(broker, {
      name: 'phoneA',
      id: 'phonepeera01',
      device: 'phoneA',
      offsetMs: o.staticMs ?? 0,
    });
    const phoneB = await startPhonePeer(broker, {
      name: 'phoneB',
      id: 'phonepeerb01',
      device: 'phoneB',
    });
    await sleep(HANDSHAKE_MS * 3);
    const peers: Peer[] = [phoneB, phoneA, cam, display];

    try {
      note('---- phoneB taps 90, with everyone listening ----');
      phoneB.store.commit(setRotate(90));
      const first = await settleWithin(() => peers.map((p) => `${p.name}=${rotateOn(p)}`), 10_000);
      const want90 = peers.map((p) => `${p.name}=90`).join(' ');
      expect(withStory(first.join(' '), want90)).toBe(want90);

      note('---- phoneB locks its screen ----');
      phoneB.mute();
      await sleep(200);

      if (o.stepMs !== undefined) {
        note(`---- phoneA's wall clock steps forward ${String(o.stepMs)} ms ----`);
        phoneA.clock.jump(o.stepMs);
      }

      note('---- phoneA taps 180, and the room folds it ----');
      phoneA.store.commit(setRotate(180));
      await sleep(6500);
      expect(withStory(rotateOn(display), '180')).toBe('180');

      note('---- phoneB unlocks and its owner taps 270 at once ----');
      phoneB.unmute();
      phoneB.store.commit(setRotate(270));

      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
        12_000,
      );
      const want = peers.map((p) => `${p.name}=270`).join(' ');
      return { got: withStory(readings.join(' '), want), want };
    } finally {
      await phoneB.stop();
      await phoneA.stop();
      await cam.stop();
      await display.stop();
    }
  }

  for (const step of [0, 1000, 10_000, AN_HOUR]) {
    it(`lands the tap back after phoneA's clock steps +${String(step)} ms mid-outage`, async () => {
      const { got, want } = await runScript({ stepMs: step });
      expect(got).toBe(want);
    }, 120_000);
  }

  it('CONTROL: the same script with phoneA statically an hour fast', async () => {
    /*
     * phoneB folds the offset BEFORE it locks, so its frozen room clock is
     * already an hour ahead and the tap lands even without the re-arm. This row
     * always passed; it is here to say which half of the mechanism is which.
     */
    const { got, want } = await runScript({ staticMs: AN_HOUR });
    expect(got).toBe(want);
  }, 120_000);
});
