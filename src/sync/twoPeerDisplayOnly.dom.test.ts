/**
 * The room the product actually ships in: one Kraken display and one phone.
 *
 * Every convergence suite before this one had CAM's configuration browser open,
 * and CAM is a chatty peer — it republishes its whole snapshot on every store
 * notification, and the display persists remote state about twice a second, so
 * there is always return traffic. That traffic papered over an entire class of
 * defect: a room where the peer that DISAGREES with you never publishes state
 * at all, so a refusal produces no answer and there is no second chance.
 *
 * The display is a pure sink by design (`grep publishState src/app` finds it
 * only in `src/app/config/useSync.ts`), and it stays one. What changed is that
 * it no longer needs to talk back: the merge is a comparison of per-leaf
 * timestamps, so a phone's fresh write beats the display's older one on the
 * first frame that carries it, with nothing to negotiate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  HANDSHAKE_MS,
  createBroker,
  firstDeviation,
  note,
  resetClockSlots,
  resetTrace,
  rotateOn,
  seedEarlierSession,
  settleWithin,
  sleep,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

describe('a display and one phone', () => {
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

  it('applies a tap made by a phone that has just reloaded', async () => {
    /*
     * S4 / P4 — the reload, in the room with no witness.
     *
     * `clientId()` is fresh per page load, so a pull-to-refresh is a brand-new
     * `src` that never heard the previous session's frames. Under the ack design
     * the display had a stamp on `render.rotate` naming a peer that no longer
     * exists, nothing could ever acknowledge it, and — because a refusal on a
     * display generates no return traffic — the tap was lost for good rather
     * than for the length of a liveness timeout.
     *
     * Under last-writer-wins on a hybrid logical clock there is nothing to
     * acknowledge: the new page's first write carries `t = max(now, seen)`,
     * which is later than the stamp the closed session left, so it wins on
     * arrival.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    let phone = await startPhonePeer(broker, { name: 'phone1', id: 'phonepeer001' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- the phone rotates to 90 ----');
      phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      await sleep(HANDSHAKE_MS * 2);
      expect(withStory(rotateOn(display), '90')).toBe('90');

      note('---- the phone reloads ----');
      await phone.stop();
      await sleep(1800);
      phone = await startPhonePeer(broker, {
        name: 'phone2',
        id: 'phonepeer002',
        device: 'phone1',
        handshakeMs: HANDSHAKE_MS,
      });

      note('---- tap A: 180, 1.8 s after the old session went quiet ----');
      phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 180 } }));

      // One round trip is a publish throttle plus a latency; two is generous.
      await sleep(1000);
      expect(withStory(rotateOn(display), '180')).toBe('180');
      expect(withStory(rotateOn(phone), '180')).toBe('180');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 40_000);

  it('converges after a muted phone comes back with a change of its own', async () => {
    /*
     * S4 / P3 — two phones, one display, no CAM.
     *
     * phoneB's radio is cut, both users tap, and B comes back 6.5 s later. Under
     * the ack design B had no reason to republish and nobody had a reason to
     * make it: the room stayed split forever. Here B's snapshot merges against
     * A's on arrival and the later stamp wins on every peer, including B.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
    const phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- phoneB loses its radio ----');
      phoneB.mute();

      note('---- both users tap ----');
      phoneA.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      phoneB.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 270 } }));
      await sleep(1500);

      note('---- phoneB gets its radio back ----');
      await sleep(5000);
      phoneB.unmute();

      const readings = await settleWithin(
        () => [display, phoneA, phoneB].map((p) => `${p.name}=${rotateOn(p)}`),
        10_000,
      );
      const values = new Set(readings.map((r) => r.split('=')[1]));
      expect(withStory([...values].join(','), [...values][0] ?? '')).toBe([...values][0] ?? '');
      expect(withStory(String(values.size), '1')).toBe('1');
      // …and it is one of the two values a human actually chose.
      const agreed = [...values][0] ?? '';
      expect(withStory(agreed, ['90', '270'].includes(agreed) ? agreed : '90|270')).toBe(agreed);
    } finally {
      await phoneB.stop();
      await phoneA.stop();
      await display.stop();
    }
  }, 60_000);

  it('holds a phone tap against the retained bootstrap it is handed', async () => {
    /*
     * The display-only version of the blip: a phone that comes back is handed
     * the broker's retained slot, which is a snapshot of the room as it was. A
     * replay is just a frame now — no special case, no rev floor — and it loses
     * because its stamps are older than the tap the user just made.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const phone = await startPhonePeer(broker, { name: 'phone', id: 'phonepeer001' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- the phone loses its radio, then taps ----');
      phone.mute();
      phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 270 } }));
      await sleep(600);
      note('---- and comes back, retained slot in hand ----');
      phone.unmute();

      expect(withStory(await firstDeviation(() => rotateOn(phone), '270', 4000), '')).toBe('');
      expect(withStory(rotateOn(display), '270')).toBe('270');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 40_000);

  it('lets a reloaded phone move a key its own previous session set', async () => {
    /*
     * H3 in the two-peer room. The stamp on the leaf names a src that no longer
     * exists AND the only other peer never publishes state, which is the exact
     * composition that made the ack design's liveness floor unreachable.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    let phone: Peer = await startPhonePeer(broker, { name: 'phone1', id: 'phonepeer001' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      phone.store.commit((s) =>
        Object.assign({}, s, { render: { ...s.render, fit: 'contain' as const } }),
      );
      await sleep(HANDSHAKE_MS * 2);
      await phone.stop();
      phone = await startPhonePeer(broker, {
        name: 'phone2',
        id: 'phonepeer002',
        device: 'phone1',
        handshakeMs: HANDSHAKE_MS,
      });
      await sleep(HANDSHAKE_MS * 2);

      note('---- the reloaded phone picks cover ----');
      phone.store.commit((s) =>
        Object.assign({}, s, { render: { ...s.render, fit: 'cover' as const } }),
      );

      const after = phone;
      expect(
        withStory(
          await firstDeviation(() => after.store.getSnapshot().render.fit, 'cover', 4000),
          '',
        ),
      ).toBe('');
      expect(withStory(display.store.getSnapshot().render.fit, 'cover')).toBe('cover');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 40_000);
});
