/**
 * What a badly-wrong clock costs the room, stated as three measurements rather
 * than as an intention.
 *
 * `docs/remote-control.md` used to claim that a far-future peer costs nothing —
 * "once a peer has received a stamp from a far-future clock, its own next write
 * is ordered after that stamp, so the room converges on whoever tapped last
 * whatever any clock says". That is true of a CONNECTED room and only of a
 * connected room, and the shipped test that measured it (`clockSkew.dom.test.ts`,
 * "does not let a peer three days fast own every setting in the room") never
 * mutes anybody. Add a 6.5 s outage — a lift, a tunnel, a screen lock — and the
 * claim fails in both directions:
 *
 *  - a peer more than `MAX_ROOM_OFFSET_MS` BEHIND loses its first tap back
 *    after every outage, because `clampRoomOffset` caps its room time a day
 *    short of the room's and `tick`'s floor is then its own pre-outage stamp;
 *  - a peer far AHEAD pins every peer's HLC at its own stamp for as long as it
 *    takes real time to catch up, and while `t` is frozen the total order
 *    degrades to `(c, s)` — a per-peer counter that is not comparable across an
 *    outage, then the writer's client id in string order. Measured: the last
 *    finger lost to alphabetical order of client ids, with the bad peer's
 *    process, slot and clock all long gone from the room.
 *
 * These three tests assert what the code ACTUALLY does. Two of them assert a
 * loss, and that is deliberate: the residue is real, it is not removable at
 * this layer (see the note below and `docs/remote-control.md`), and a test that
 * pretended otherwise would be the fourth version of the same wrong claim.
 *
 * ## Why the obvious fix is not in the code
 *
 * The proposed repair was to cap the LOCAL HLC floor — fold an incoming stamp
 * into `clock` at no more than `roomNow() + MAX_ROOM_OFFSET_MS` — so that `t`
 * resumes tracking real time while the per-leaf REGISTER stamps stay verbatim.
 * It cannot work, and the reason is one line of arithmetic: the poisoned
 * register still holds `now + 3 d`, so a local write stamped at the capped
 * ceiling (`now + 2 d` at best) LOSES to it on every receiver. The room does not
 * merely fail to order the last tap — it splits, with the writer showing its own
 * value and everybody else keeping the far-future one. Measured, applying that
 * cap: the shipped "does not let a peer three days fast own every setting in
 * the room" test fails.
 *
 * The only cap that removes the pin is one applied to the register stamps on
 * ARRIVAL, and that was rejected on its own merits last round: a cap computed
 * from the receiver's clock gives two receivers two different stamps for one
 * write, which is exactly the property ("one write, one stamp, everywhere") the
 * whole merge is built on. So the residue is documented instead.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  HANDSHAKE_MS,
  createBroker,
  installDeviceClocks,
  moduleOn,
  note,
  openRoom,
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

const AN_HOUR = 3_600_000;
const THREE_DAYS = 3 * 24 * AN_HOUR;
const BEHIND_23_H = -23 * AN_HOUR;
const BEHIND_3_D = -THREE_DAYS;

const setRotate =
  (deg: AppState['render']['rotate']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

describe('a room that has heard a stamp from a badly-wrong clock', () => {
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

  it('A3: a far-future peer that has LEFT still decides who wins for days', async () => {
    /*
     * Skeptic 2's A3, verbatim, and it is the general form of the defect: the
     * bad peer taps once and leaves, so its process, its slot and its clock are
     * all irrelevant by the time the contested writes happen.
     *
     * Instrumented stamps on the winning leaf, both peers agreeing:
     *
     *     STAMP good render.rotate t-now=259179s c=1 s=phonepeergood
     *     STAMP CAM  render.rotate t-now=259179s c=1 s=configpeer01
     *
     * `t` is three days out on both, so `compareStamps` fell through to `s`,
     * and 'configpeer01' < 'phonepeergood' ranked CAM's LATER tap as the
     * earlier write.
     *
     * This test asserts the RESIDUE — CAM's later tap losing — because that is
     * what the code does and there is no fix for it at this layer. If a future
     * change makes the later tap win, this test is the thing that should be
     * rewritten, loudly, along with `docs/remote-control.md`.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const cam = await startConfigPeer(broker, HANDSHAKE_MS);
    const bad = await startPhonePeer(broker, {
      name: 'bad',
      id: 'phonepeerbad',
      device: 'bad',
      offsetMs: THREE_DAYS,
    });
    const good = await startPhonePeer(broker, {
      name: 'good',
      id: 'phonepeergood',
      device: 'good',
    });
    await sleep(HANDSHAKE_MS * 3);
    const peers: Peer[] = [good, cam, display];

    try {
      note('---- the bad phone, three days fast, taps 90 and leaves the room ----');
      bad.store.commit(setRotate(90));
      await sleep(HANDSHAKE_MS * 4);
      await bad.stop();

      note('---- CAM drops off ----');
      cam.mute();
      await sleep(200);

      note('---- the good phone taps 180 ----');
      good.store.commit(setRotate(180));
      await sleep(6500);

      note('---- CAM comes back and taps 270 at once ----');
      cam.unmute();
      cam.store.commit(setRotate(270));

      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
        12_000,
      );
      /*
       * The residue: the room converges (it always does — the merge is a
       * lattice) but on the write the total order ranked higher, which with `t`
       * frozen is the one whose client id sorts later, not the one somebody
       * tapped last.
       */
      const want = peers.map((p) => `${p.name}=180`).join(' ');
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await good.stop();
      await cam.stop();
      await display.stop();
    }
  }, 120_000);

  it('A2: correcting the clock and reloading does not unstick it', async () => {
    /*
     * Skeptic 2's A2. The phone is three days fast, taps once, and the room
     * converges on it exactly as the shipped test says it should. Then the
     * owner FIXES the clock and reloads the page — same device, same slot, the
     * document it left — and the room is still poisoned, because the poison is
     * in the register the room agreed on, not in the phone.
     *
     * `docs/remote-control.md` used to say the wrong-clock peer wins ties
     * "until its clock is corrected". This is the measurement that says the
     * clause is false: correcting it changes nothing, and neither does a
     * reload.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const cam = await startConfigPeer(broker, HANDSHAKE_MS);
    let phone = await startPhonePeer(broker, { device: 'phone', offsetMs: THREE_DAYS });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- the phone, three days fast, taps 90 ----');
      phone.store.commit(setRotate(90));
      await sleep(HANDSHAKE_MS * 4);

      note('---- the owner corrects the clock and reloads the page ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, { device: 'phone', initial: inherited });
      await sleep(HANDSHAKE_MS * 3);

      note('---- CAM drops off ----');
      cam.mute();
      await sleep(200);

      note('---- the now-correct phone taps 270 ----');
      phone.store.commit(setRotate(270));
      await sleep(6500);

      note('---- CAM comes back and taps 180 at once ----');
      cam.unmute();
      cam.store.commit(setRotate(180));

      const peers: Peer[] = [phone, cam, display];
      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
        12_000,
      );
      // The residue again: 'configpeer01' sorts before 'phonepeer001', so with
      // `t` pinned three days out CAM's LATER tap is ranked as the earlier one.
      const want = peers.map((p) => `${p.name}=270`).join(' ');
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await phone.stop();
      await cam.stop();
      await display.stop();
    }
  }, 120_000);

  for (const behind of [BEHIND_23_H, BEHIND_3_D]) {
    const past = behind < -24 * AN_HOUR;
    it(`the S2-contended script with the phone ${String(behind / AN_HOUR)} h behind ${
      past ? 'LOSES the tap (past the clamp)' : 'lands the tap'
    }`, async () => {
      /*
       * The clamp, from both sides, on the script `clockSkew.dom.test.ts` runs
       * at 0 / −10 s / −90 s / +40 s and never past a day.
       *
       * `clampRoomOffset` caps a folded sample at `MAX_ROOM_OFFSET_MS`, so a
       * phone three days slow reads room time as `now − 2 d`. `tick(seen, now)`
       * then floors at its own pre-outage stamp, which is under everything CAM
       * wrote while it was away, and the tap on unlock is lost — the screen
       * goes green and reverts, which is the original bug report verbatim,
       * reappearing outside the clamp. At −23 h the identical script passes,
       * which is what says the boundary is the clamp and not the script.
       *
       * Said plainly, because it is what a person needs to know: a device whose
       * clock is more than a day SLOW loses its first tap after every outage
       * until somebody corrects the clock.
       */
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      const room = await openRoom(broker, { offsets: { phone: behind } });

      try {
        note('---- the phone taps Clock ----');
        room.phone.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
        await sleep(HANDSHAKE_MS * 3);
        expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');

        note('---- the screen locks ----');
        room.phone.mute();
        await sleep(200);
        note('---- CAM picks Stats while the phone is away ----');
        room.config.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
        await sleep(6500);
        expect(withStory(moduleOn(room.display), 'stats')).toBe('stats');

        note('---- the phone is unlocked and its owner picks Video at once ----');
        room.phone.unmute();
        room.phone.store.commit((s) => ({ ...s, activeModuleId: 'video' }));

        const peers = [room.phone, room.config, room.display];
        const readings = await settleWithin(
          () => peers.map((p) => `${p.name}=${moduleOn(p)}`),
          12_000,
        );
        const settled = past ? 'stats' : 'video';
        const want = peers.map((p) => `${p.name}=${settled}`).join(' ');
        expect(withStory(readings.join(' '), want)).toBe(want);
      } finally {
        await room.stop();
      }
    }, 120_000);
  }
});
