/**
 * A value never travels without its stamp.
 *
 * `wireStamps()` used to ship the newest 32 stamps and the WHOLE body. That
 * reads like a budget and is actually a lie: a state frame is a full snapshot,
 * so a leaf whose stamp was trimmed still arrives with a value, and a value
 * with no stamp is read as `EPOCH` — the beginning of time, the strongest
 * possible claim that nobody has ever written that leaf.
 *
 * The damage is permanent rather than slow. A leaf buried under 33 fresher
 * edits can never climb back into its own sender's newest 32, so a peer that
 * was not listening when the stamp was fresh — a locked screen, a lift, a
 * retained bootstrap — never converges, however long both sides republish.
 * Measured before the fix: thirty seconds of continuous traffic with the wall
 * showing one module and the phone showing another, and a SEQUENTIAL edit made
 * 1.2 s later losing on two of three peers.
 *
 * The fixed cap is gone. `fitStateEnvelope`'s byte ladder is the only trimmer,
 * and its last rung rotates, so every stamped leaf travels with its stamp
 * within a bounded number of frames.
 *
 * The ladder's own opening rung then turned out to be the same lie in a
 * different costume: it dropped the stamps of every leaf whose value equalled
 * the built-in default, permanently and on every frame, which made setting
 * anything BACK to its default unsendable once a snapshot crossed 8 kB. It is
 * gone too, and the last test here is the room that proved it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { decodeEnvelope } from './envelope';
import {
  HANDSHAKE_MS,
  createBroker,
  fitOn,
  moduleOn,
  note,
  openRoom,
  resetClockSlots,
  resetTrace,
  retainedAuthoredBy,
  rotateOn,
  seedEarlierSession,
  settleWithin,
  sleep,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

/**
 * More config edits than the old cap held, on a module nobody is arguing about.
 *
 * Thirty-four is one person adjusting one module for a minute — the cap counted
 * every leaf ANYBODY had touched, including the ones learned from inbound
 * frames, so it was a room-wide budget rather than a per-device tap counter.
 */
const BURIAL_EDITS = 40;

/**
 * One unrelated commit, to start the 5 Hz publish throttle.
 *
 * Everything committed after it inside the next 200 ms is coalesced onto ONE
 * frame, which is the whole point: the contested write and the edits that bury
 * its stamp have to leave on the same frame, or the room converges on the
 * earlier frame that still carried the stamp and the defect never appears.
 */
let opener = 0;
function openThePublishWindow(peer: Peer): void {
  opener += 1;
  const tick = opener;
  peer.store.commit((s: AppState) => ({
    ...s,
    modules: {
      ...s.modules,
      clock: {
        ...(s.modules['clock'] ?? { v: 1, cfg: {} }),
        cfg: { ...((s.modules['clock']?.cfg ?? {}) as Record<string, unknown>), open: tick },
      },
    },
  }));
}

function buryUnderConfigEdits(peer: Peer, count: number, from = 0): void {
  for (let i = from; i < from + count; i += 1) {
    peer.store.commit((s: AppState) => ({
      ...s,
      modules: {
        ...s.modules,
        video: {
          ...(s.modules['video'] ?? { v: 1, cfg: {} }),
          cfg: {
            ...((s.modules['video']?.cfg ?? {}) as Record<string, unknown>),
            [`k${String(i)}`]: i,
          },
        },
      },
    }));
  }
}

describe('a leaf whose stamp would have been trimmed off the frame that carried it', () => {
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

  it('converges on a contended leaf buried under fresher config edits', async () => {
    /*
     * Skeptic 3's trace 1, and the lens-native case: a simultaneous same-key
     * commit with no blip, no reorder and no outage. Both writers then bury
     * their own `render.rotate` stamp under 40 config leaves inside the same
     * publish window, so the one frame each of them sends carries the value and
     * not the stamp. Two values, held past the whole settle window.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      note('---- CAM picks rotate 180, the phone picks 90, both then tune 40 settings ----');
      openThePublishWindow(room.config);
      openThePublishWindow(room.phone);
      room.config.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 180 } }));
      room.phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      buryUnderConfigEdits(room.config, BURIAL_EDITS);
      buryUnderConfigEdits(room.phone, BURIAL_EDITS, 1000);

      const peers = [room.config, room.phone, room.display];
      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
        10_000,
      );
      const values = new Set(readings.map((r) => r.split('=')[1] ?? ''));
      expect(
        withStory(`${String(values.size)} ${readings.join(' ')}`, `1 ${readings.join(' ')}`),
      ).toBe(`1 ${readings.join(' ')}`);
    } finally {
      await room.stop();
    }
  }, 60_000);

  it('holds a SEQUENTIAL edit whose stamp is buried a second later', async () => {
    /*
     * Skeptic 3's trace 2, and the damning one: there is no race here at all.
     * The phone picks Stats; a FULL SECOND later CAM picks Image; CAM then
     * tunes 40 settings. The later edit is the one the room must land on, and
     * before the fix it lost on two of the three peers.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      note('---- the phone picks Stats ----');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      await sleep(1200);
      note('---- 1.2 s later CAM picks Image, then tunes 40 settings ----');
      openThePublishWindow(room.config);
      room.config.store.commit((s) => ({ ...s, activeModuleId: 'image' }));
      buryUnderConfigEdits(room.config, BURIAL_EDITS);

      const peers = [room.config, room.phone, room.display];
      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${moduleOn(p)}`),
        10_000,
      );
      const want = 'CAM=image phone=image display=image';
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await room.stop();
    }
  }, 60_000);

  it('reaches a phone that was locked while CAM chose and then tuned 34 settings', async () => {
    /*
     * The dumped script, which is the whole mechanism in one story: the phone
     * picks Stats with everyone listening, its screen locks, CAM picks Image
     * and tunes 34 settings 120 ms apart, and the phone comes back.
     *
     * Before the fix, `activeModuleId` ranked 36th of 37 stamps on CAM, so it
     * travelled — on the retained bootstrap and on every frame after it —
     * with no stamp at all. The phone read that as `EPOCH`, compared it against
     * its own real `stats` stamp, and dropped it. Thirty seconds, both sides
     * publishing, and the phone never learned what the wall was showing.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      note('---- the phone picks Stats, with everyone listening ----');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      await sleep(HANDSHAKE_MS * 3);
      expect(withStory(moduleOn(room.display), 'stats')).toBe('stats');

      note('---- the phone screen locks ----');
      room.phone.mute();
      await sleep(200);

      note('---- CAM picks Image ----');
      room.config.store.commit((s) => ({ ...s, activeModuleId: 'image' }));
      note('---- and tunes 34 settings, 120 ms apart ----');
      for (let i = 0; i < 34; i += 1) {
        buryUnderConfigEdits(room.config, 1, i);
        await sleep(120);
      }
      expect(withStory(moduleOn(room.display), 'image')).toBe('image');

      note('---- the phone unlocks ----');
      room.phone.unmute();

      const peers = [room.config, room.phone, room.display];
      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${moduleOn(p)}`),
        10_000,
      );
      const want = 'CAM=image phone=image display=image';
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await room.stop();
    }
  }, 90_000);

  it('lets a phone set a setting BACK to its default in a room with 150 tuned knobs', async () => {
    /*
     * Skeptic 1's room trace, and there is nothing exotic in it: no blip, no
     * reorder, no duplicate, no clock skew, no concurrency. CAM tunes 150
     * config settings so every frame in the room is over the 8 kB cap, commits
     * `render.fit = 'contain'`, and the room agrees. A second and a half later
     * the phone commits `render.fit = 'cover'` — which happens to be the
     * built-in default, which is the whole of the crime.
     *
     * Before the fix the room never converged: the phone's `cover` register
     * carried a genuinely newer stamp so the phone never yielded, and CAM's
     * frames carried `contain` WITH its stamp (contain is not defaultish) so
     * CAM never yielded either. Measured at eleven seconds and ~700 frames past
     * the edit, still holding two values, stably.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      note('---- CAM tunes 150 config settings ----');
      buryUnderConfigEdits(room.config, 150);
      await sleep(3000);

      note('---- CAM commits fit=contain, and the room agrees ----');
      room.config.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
      const peers = [room.config, room.phone, room.display];
      const agreed = await settleWithin(() => peers.map((p) => `${p.name}=${fitOn(p)}`), 10_000);
      expect(withStory(agreed.join(' '), 'CAM=contain phone=contain display=contain')).toBe(
        'CAM=contain phone=contain display=contain',
      );

      await sleep(1500);
      note('---- 1.5 s later the phone commits fit=cover, which is the default ----');
      room.phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'cover' } }));

      const readings = await settleWithin(() => peers.map((p) => `${p.name}=${fitOn(p)}`), 10_000);
      const want = 'CAM=cover phone=cover display=cover';
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await room.stop();
    }
  }, 90_000);

  it('carries the stamp of a leaf nobody has touched for a hundred edits', () => {
    /*
     * The rule itself, asserted on the wire rather than through a room: after a
     * hundred config edits the frame still carries the stamp of the leaf that
     * was written FIRST. Under a fixed newest-N window it does not — the value
     * goes out bare, reads as `EPOCH`, and no amount of republishing brings the
     * stamp back, because the leaf can never climb.
     *
     * Read off the broker's RETAINED slot, which is the frame a peer coming back
     * from a locked screen actually bootstraps from.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    return (async () => {
      const display = await startDisplayPeer(broker);
      const phone = await startPhonePeer(broker, { name: 'phone', id: 'phonepeer001' });
      await sleep(HANDSHAKE_MS * 3);

      try {
        openThePublishWindow(phone);
        phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 270 } }));
        buryUnderConfigEdits(phone, 100);
        await sleep(600);

        const stamped = phone.sync.stampedLeaves().map((l) => l.path);
        expect(withStory(String(stamped.length > 100), 'true')).toBe('true');

        await retainedAuthoredBy(broker, 'phonepeer001');
        const env = decodeEnvelope(broker.retained.state ?? new Uint8Array());
        const onTheWire = Object.keys(env?.stamps ?? {});
        expect(
          withStory(
            `${String(onTheWire.length)} stamps, rotate stamped: ${String(onTheWire.includes('render.rotate'))}`,
            `${String(onTheWire.length)} stamps, rotate stamped: true`,
          ),
        ).toBe(`${String(onTheWire.length)} stamps, rotate stamped: true`);
        // Every leaf the body names that this page has a stamp for travels with
        // it: the frame is small, so the ladder never reaches its rotating rung.
        expect(withStory(String(onTheWire.length >= stamped.length), 'true')).toBe('true');

        const settled = await settleWithin(
          () => [`display=${rotateOn(display)}`, `phone=${rotateOn(phone)}`],
          10_000,
        );
        expect(withStory(settled.join(' '), 'display=270 phone=270')).toBe('display=270 phone=270');
      } finally {
        await phone.stop();
        await display.stop();
      }
    })();
  }, 60_000);
});
