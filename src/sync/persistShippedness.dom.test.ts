/**
 * Shippedness across TWO page loads — the half of the slot-cap repair that was
 * only ever true inside one process.
 *
 * `saveClock` packs the register table in two passes so a cap may only evict a
 * register the ROOM ALREADY HOLDS, and "has the room heard this?" is the
 * `unshipped` set. That set was in memory only. So the invariant held for
 * exactly one page load, and any second load that never reached the room —
 * `startAppSync` restoring the registers and initialising `unshipped` EMPTY —
 * re-packed the slot as if every register were shipped and evicted the oldest
 * offline write. `stop()` alone is enough to trigger it: it sets `clockDirty`
 * and calls `saveClock()`.
 *
 * Two page loads without a round trip to the room is not a stress case. It is a
 * phone in a lift, a locked screen, a tab the browser discarded and restored.
 *
 * Measured before the repair, with `A/B/C` = registers before reload #1 / after
 * reload #1 / after reload #2:
 *
 *     N=20 :: 22/22/22  fit=contain/contain/contain  knob0=0   PASS (control)
 *     N=31 :: 33/33/32  fit=cover/cover/cover        knob0=0   FAIL
 *     N=35 :: 37/37/32  fit=cover/cover/cover        knob0=0   FAIL
 *     N=60 :: 62/62/32  fit=cover/cover/cover        knob0=0   FAIL
 *
 * `A == B` on every row is the round-7 repair working within one process. `C ==
 * 32` on the failing rows is the eviction happening at the OFFLINE page's
 * `stop()`, and the boundary is exactly `MAX_SLOT_REGISTERS`. `knob0` lands
 * every time, broken or fixed, which is what makes the loss so hard to see: the
 * room holds no register for the gap-fillers, so 31 of 32 offline edits arrive
 * and exactly the one the room had an opinion about is silently reverted, with
 * no `lastError` and no notice.
 *
 * The repair is `StoredClock.unshipped`: the set is written down beside the
 * registers, read back defensively, and a MISSING key reads as "all of them".
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  HANDSHAKE_MS,
  createBroker,
  fitOn,
  installDeviceClocks,
  note,
  readClockSlot,
  resetClockSlots,
  resetTrace,
  restoreDeviceClocks,
  settleWithin,
  sleep,
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  videoCfg,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

/** Turn one module-config knob, the way the video panel's sliders do. */
function knob(peer: Peer, key: string, value: unknown): void {
  peer.store.commit((s) => ({
    ...s,
    modules: {
      ...s.modules,
      video: {
        v: s.modules['video']?.v ?? 1,
        cfg: { ...((s.modules['video']?.cfg ?? {}) as Record<string, unknown>), [key]: value },
      },
    },
  }));
}

const setFit =
  (fit: AppState['render']['fit']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, fit } });

describe('an offline write survives a page load that never reaches the room', () => {
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

  /*
   * BOTH value orders, because `merge.ts` breaks a stamp tie on the value
   * sorting larger as JSON — and 'contain' < 'cover' as strings. A repair that
   * happened to work only in the direction the failure was first measured in
   * would pass one of these two rows and not the other.
   */
  for (const [roomFit, phoneFit] of [
    ['cover', 'contain'],
    ['contain', 'cover'],
  ] as const) {
    for (const n of [20, 31, 35, 60]) {
      it(`keeps an offline fit=${phoneFit} through ${String(n)} edits and TWO reloads`, async () => {
        const broker = createBroker();
        const display = await startDisplayPeer(broker);
        const config = await startConfigPeer(broker, HANDSHAKE_MS);
        let phone = await startPhonePeer(broker, { device: 'ph' });

        try {
          await sleep(HANDSHAKE_MS * 3);

          note(`---- CAM stamps render.fit=${roomFit} ----`);
          config.store.commit(setFit(roomFit));
          await settleWithin(() => [fitOn(display), fitOn(config), fitOn(phone)], 6000);

          note('---- the phone loses its radio ----');
          phone.mute();
          await sleep(200);

          // The FIRST offline edit, and the only leaf the room already holds a
          // register for. Everything after it is a gap-filler.
          phone.store.commit(setFit(phoneFit));
          for (let i = 0; i < n; i += 1) knob(phone, `k${String(i)}`, i);
          await sleep(300);
          const before = phone.sync.stampedLeaves().length;

          /*
           * RELOAD #1 — the page load that never reaches the room.
           *
           * A fresh, empty broker: nothing is retained on it, no peer speaks on
           * it, and the phone therefore ships nothing and hears nothing for the
           * whole life of the page. It restores the slot and writes it back at
           * `stop()`, which is the entire failure.
           */
          note('---- reload #1: a page load with no room at all ----');
          const dark = phone.doc();
          await phone.stop();
          phone = await startPhonePeer(createBroker(), { device: 'ph', initial: dark });
          await sleep(HANDSHAKE_MS * 2);
          const during = phone.sync.stampedLeaves().length;
          const fitAfterDark = phone.sync.stampedLeaves().some((l) => l.path === 'render.fit');

          note('---- reload #2: back on the real broker ----');
          const inherited = phone.doc();
          await phone.stop();
          phone = await startPhonePeer(broker, { device: 'ph', initial: inherited });
          await sleep(HANDSHAKE_MS * 4);
          const after = phone.sync.stampedLeaves().length;

          const readings = await settleWithin(
            () => [fitOn(display), fitOn(config), fitOn(phone)],
            8000,
          );
          const raw = videoCfg(display)['k0'];
          const knob0 = typeof raw === 'number' ? String(raw) : 'missing';
          const stamped = `${String(before)}/${String(during)}/${String(after)}`;
          note(`stamped=${stamped} fitAfterOfflineReload=${String(fitAfterDark)}`);
          expect(
            withStory(
              `fit=${readings.join('/')} knob0=${knob0}`,
              `fit=${phoneFit}/${phoneFit}/${phoneFit} knob0=0`,
            ),
          ).toBe(`fit=${phoneFit}/${phoneFit}/${phoneFit} knob0=0`);
        } finally {
          await phone.stop();
          await config.stop();
          await display.stop();
        }
      }, 90_000);
    }
  }

  it('reads a slot with no unshipped key as "none of it shipped"', async () => {
    /*
     * The migration direction, stated as a test rather than as a hope.
     *
     * A v2 slot written by a build that predates `StoredClock.unshipped` names
     * registers and says nothing about which of them the room has heard. Reading
     * that silence as "all shipped" is the failure above; reading it as "none
     * shipped" costs at most some slot budget, bounded by
     * `MAX_UNSHIPPED_REGISTERS`. So the key is deliberately absent here and the
     * offline edit must still survive — which is also why the slot version did
     * not have to move and discard every existing register, offset and clock.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);
    let phone = await startPhonePeer(broker, { device: 'ph' });

    try {
      await sleep(HANDSHAKE_MS * 3);
      config.store.commit(setFit('cover'));
      await settleWithin(() => [fitOn(display), fitOn(config), fitOn(phone)], 6000);

      phone.mute();
      await sleep(200);
      phone.store.commit(setFit('contain'));
      for (let i = 0; i < 35; i += 1) knob(phone, `k${String(i)}`, i);
      await sleep(300);

      note('---- reload #1, onto a slot written by an older build ----');
      const dark = phone.doc();
      await phone.stop();
      const slotRaw = readClockSlot('ph');
      const older = ((): string | undefined => {
        if (slotRaw === null) return undefined;
        const parsed = JSON.parse(slotRaw) as Record<string, unknown>;
        delete parsed['unshipped'];
        return JSON.stringify(parsed);
      })();
      phone = await startPhonePeer(createBroker(), {
        device: 'ph',
        initial: dark,
        ...(older === undefined ? {} : { slotRaw: older }),
      });
      await sleep(HANDSHAKE_MS * 2);

      note('---- reload #2, back on the real broker ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, { device: 'ph', initial: inherited });
      await sleep(HANDSHAKE_MS * 4);

      const readings = await settleWithin(
        () => [fitOn(display), fitOn(config), fitOn(phone)],
        8000,
      );
      expect(withStory(`fit=${readings.join('/')}`, 'fit=contain/contain/contain')).toBe(
        'fit=contain/contain/contain',
      );
    } finally {
      await phone.stop();
      await config.stop();
      await display.stop();
    }
  }, 90_000);
});
