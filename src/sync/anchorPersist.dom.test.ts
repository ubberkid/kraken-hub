/**
 * The stamping base across a reload, when the device clock has moved backwards
 * and the room is not there to correct it.
 *
 * `appSync`'s room time is an ANCHOR plus a monotonic projection, and the
 * projection is the only thing a deaf page has: `Date.now() + roomOffset` takes
 * a backward wall-clock step with it, and there is nothing inbound during an
 * outage to relearn from. Two seams broke the anchor at exactly the moment it
 * was needed:
 *
 *  - `anchorRoomTime` only ever advances inside `roomNow()`, and `saveClock()`
 *    wrote it down without calling `roomNow()` first. During an outage a page
 *    makes no commits and folds no frames, so nothing advanced it and the slot
 *    recorded a base from before the step.
 *  - the restore set `anchorMono = monotonicNow()` and started the projection at
 *    zero elapsed, discarding the wall time that passed between the last save
 *    and the reload.
 *
 * Measured (`display` + CAM correct, phone correct at start): phone taps
 * `rotate=90`, room settles; phone mutes; phone's clock steps back; CAM taps
 * `rotate=180`; the phone RELOADS while still dark; the owner taps `rotate=270`
 * before anything inbound has landed; the radio comes back.
 *
 *     step  −1 s   -> phone2=270 CAM=270 display=270   PASS
 *     step −10 s   -> phone2=180 CAM=180 display=180   FAIL — the tap reverted
 *     step  −1 h   -> phone2=180 CAM=180 display=180   FAIL
 *
 * `loss = min(step, elapsed since the last saveClock)`, which is what pins the
 * mechanism — and so does the control: the IDENTICAL script with one extra local
 * commit after the step and before the reload passes, because that commit's
 * `nextStamp()` calls `roomNow()` and refreshes the anchor before it is written.
 *
 * The repair is both halves — `saveClock()` refreshes the anchor first, and
 * `StoredClock.baseAt` lets the restore project across the gap under a
 * `Math.max(0, …)` that a backward step cannot drag down.
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
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

const AN_HOUR = 3_600_000;

const setRotate =
  (deg: AppState['render']['rotate']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

/**
 * The script, once. `nudge` is the extra local commit that made the mechanism
 * provable: with it the anchor is refreshed by `nextStamp()` and the tap wins on
 * every build, which is why the interesting rows are the ones without it.
 */
async function darkReloadScript(o: {
  stepMs: number;
  nudge?: boolean;
}): Promise<{ readings: string[]; stop: () => Promise<void> }> {
  const broker = createBroker();
  const display = await startDisplayPeer(broker);
  const config = await startConfigPeer(broker, HANDSHAKE_MS);
  let phone: Peer = await startPhonePeer(broker, { device: 'ph' });

  const stop = async (): Promise<void> => {
    await phone.stop();
    await config.stop();
    await display.stop();
  };

  await sleep(HANDSHAKE_MS * 3);

  note('---- the phone taps 90 and the room agrees ----');
  phone.store.commit(setRotate(90));
  await settleWithin(() => [rotateOn(display), rotateOn(config), rotateOn(phone)], 8000);

  note('---- the phone loses its radio ----');
  phone.mute();
  await sleep(200);

  note(`---- the phone's clock steps ${String(o.stepMs / 1000)} s while dark ----`);
  phone.clock.jump(o.stepMs);

  note('---- CAM taps 180 while the phone is away ----');
  config.store.commit(setRotate(180));
  await sleep(HANDSHAKE_MS * 4);

  if (o.nudge === true) {
    note('---- control: one unrelated local commit before the reload ----');
    phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
    await sleep(200);
  }

  note('---- the phone reloads, STILL dark ----');
  const inherited = phone.doc();
  await phone.stop();
  phone = await startPhonePeer(broker, {
    device: 'ph',
    initial: inherited,
    offsetMs: o.stepMs,
    handshakeMs: 5000,
  });
  phone.mute();
  await sleep(200);

  note('---- the owner taps 270 before anything inbound has landed ----');
  phone.store.commit(setRotate(270));
  await sleep(200);
  phone.unmute();

  const readings = await settleWithin(
    () => [rotateOn(phone), rotateOn(config), rotateOn(display)],
    10_000,
  );
  return { readings, stop };
}

describe('a tap made after a backward clock step and a dark reload', () => {
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

  for (const stepMs of [-1000, -10_000, -AN_HOUR]) {
    it(`wins at a step of ${String(stepMs / 1000)} s`, async () => {
      const { readings, stop } = await darkReloadScript({ stepMs });
      try {
        expect(withStory(readings.join('/'), '270/270/270')).toBe('270/270/270');
      } finally {
        await stop();
      }
    }, 90_000);
  }

  it('wins after a FORWARD step too', async () => {
    /*
     * The other direction, which the projection must not make worse: a forward
     * step is already covered by `Date.now() + roomOffset` beating the
     * projection, and `baseAt` adds to the base rather than replacing it, so the
     * result has to be identical.
     */
    const { readings, stop } = await darkReloadScript({ stepMs: 10_000 });
    try {
      expect(withStory(readings.join('/'), '270/270/270')).toBe('270/270/270');
    } finally {
      await stop();
    }
  }, 90_000);

  it('wins with a corrected clock — the control that pinned the mechanism', async () => {
    /*
     * One extra local commit between the step and the reload, and nothing else
     * changed. It passed on the broken build too, and that is the point: the
     * commit's only contribution is a `roomNow()` call before `saveClock()`
     * writes the anchor down, which is now what `saveClock()` does itself.
     */
    const { readings, stop } = await darkReloadScript({ stepMs: -10_000, nudge: true });
    try {
      expect(withStory(readings.join('/'), '270/270/270')).toBe('270/270/270');
    } finally {
      await stop();
    }
  }, 90_000);
});
