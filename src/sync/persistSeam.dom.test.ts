/**
 * The seam between the two halves of a persisted register.
 *
 * A register is a VALUE and the STAMP of the write that put it there, and for
 * three releases this page wrote those two things through two different acts:
 * stamps into the clock slot on every commit and on `stop()`, values into the
 * state document only through `persistNow()` — throttled to two seconds, and
 * switched off entirely by `sync.persistRemote: false`. Any page that closed
 * inside that gap left a slot whose stamps described values its document did
 * not contain, and the restore loop paired them anyway.
 *
 * What that costs is not a lost frame. The reloaded page then holds the ROOM'S
 * NEWEST STAMP against a SUPERSEDED VALUE, so when the true value arrives the
 * two registers tie on stamp and the tie-break — written for two leaves NOBODY
 * has stamped — settles a real argument by JSON string order. Half the time the
 * stale value wins, and it wins again on every subsequent frame, forever, on
 * every peer. Measured: a display showing 90 while the phone showed 270 for as
 * long as anyone watched, and a three-peer room reverting the author's own edit.
 *
 * Every case here is asserted in BOTH value orders, because the defect is
 * invisible in one of them — `"cover" > "contain"` and `"90" > "270"` as JSON —
 * and a seed that happened to pick the harmless order is what let this ship.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, readState, resetStateCache } from '../state/storage';

import { PERSIST_REMOTE_THROTTLE_MS } from './appSync';
import {
  HANDSHAKE_MS,
  createBroker,
  fitOn,
  moduleOn,
  note,
  openRoom,
  resetClockSlots,
  resetTrace,
  rotateOn,
  seedEarlierSession,
  settleWithin,
  sleep,
  startDisplayPeer,
  startPhonePeer,
  withStory,
} from './roomHarness';

/** Long enough for a throttled persist to have fired and its window to reopen. */
const PAST_THE_THROTTLE_MS = 2600;

describe('a page that reloads between the value write and the stamp write', () => {
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

  for (const [first, second] of [
    [90, 270],
    [270, 90],
  ] as const) {
    it(`keeps a tap the display had applied when it reboots mid-persist (${String(first)} then ${String(second)})`, async () => {
      /*
       * The display-only room, which is the one that cannot heal itself: a
       * display never publishes state, so a value it holds wrongly has no
       * return traffic to correct it. The script is the one that lost a tap
       * permanently — a tap, then a second tap inside the persist window the
       * first one opened, then a reboot with that write still pending.
       */
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      let display = await startDisplayPeer(broker);
      const phone = await startPhonePeer(broker, { name: 'phone', id: 'phonepeer001' });
      await sleep(HANDSHAKE_MS * 3);

      try {
        note(`---- tap A: rotate ${String(first)} ----`);
        phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: first } }));
        await sleep(PAST_THE_THROTTLE_MS);
        expect(withStory(rotateOn(display), String(first))).toBe(String(first));
        expect(withStory(String(readState().state.render.rotate), String(first))).toBe(
          String(first),
        );

        note('---- tap B: fit contain, which opens a fresh persist window ----');
        phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
        await sleep(300);
        note(`---- tap C: rotate ${String(second)}, INSIDE that window ----`);
        phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: second } }));
        await sleep(400);
        expect(withStory(rotateOn(display), String(second))).toBe(String(second));

        note('---- the Kraken reboots, the persist still pending ----');
        await display.stop();
        display = await startDisplayPeer(broker);

        const settled = await settleWithin(
          () => [`display=${rotateOn(display)}`, `phone=${rotateOn(phone)}`],
          10_000,
        );
        expect(
          withStory(settled.join(' '), `display=${String(second)} phone=${String(second)}`),
        ).toBe(`display=${String(second)} phone=${String(second)}`);
      } finally {
        await phone.stop();
        await display.stop();
      }
    }, 60_000);
  }

  for (const [mine, theirs] of [
    ['cover', 'contain'],
    ['contain', 'cover'],
  ] as const) {
    it(`does not launder a stale document when a phone reloads inside the throttle (${mine} then ${theirs})`, async () => {
      /*
       * Three peers, default settings, no blip and no reorder. The phone sets
       * a value and its document is written; CAM changes the same leaf inside
       * the two seconds that follow; the phone reloads before its trailing
       * persist fires. The stamp it restores belongs to CAM's write and the
       * value it restores is its own superseded one — and because the phone
       * republishes, the room follows it.
       */
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      const room = await openRoom(broker);
      let phone = room.phone;

      try {
        await sleep(PAST_THE_THROTTLE_MS);
        note(`---- the phone sets fit=${mine}; its document is written ----`);
        phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: mine } }));
        await sleep(500);

        note(`---- CAM sets fit=${theirs}, inside the phone's persist window ----`);
        room.config.store.commit((s) => ({ ...s, render: { ...s.render, fit: theirs } }));
        await sleep(400);
        note(
          `phone register fit=${fitOn(phone)} but its DOCUMENT still says ${phone.store.getSnapshot().render.fit}`,
        );

        note('---- the phone reloads, still inside the persist throttle ----');
        const inherited = phone.doc();
        note(`the document this page load inherits says fit=${inherited.render.fit}`);
        await phone.stop();
        phone = await startPhonePeer(broker, {
          name: 'phoneB',
          id: 'phonepeerb02',
          device: 'phone',
          initial: inherited,
        });

        const peers = [phone, room.config, room.display];
        const settled = await settleWithin(() => peers.map((p) => `${p.name}=${fitOn(p)}`), 10_000);
        expect(
          withStory(settled.join(' '), `phoneB=${theirs} CAM=${theirs} display=${theirs}`),
        ).toBe(`phoneB=${theirs} CAM=${theirs} display=${theirs}`);
      } finally {
        await phone.stop();
        await room.config.stop();
        await room.display.stop();
      }
    }, 60_000);
  }

  for (const [mine, theirs] of [
    ['cover', 'contain'],
    ['contain', 'cover'],
  ] as const) {
    it(`restores what it decided, not what its document holds, with persistRemote off (${mine} then ${theirs})`, async () => {
      /*
       * `sync.persistRemote: false` is a shipped user toggle, and with it there
       * is no race to win at all: the document is never written from remote
       * state, so EVERY stamp such a page restored was paired with whatever its
       * document happened to hold.
       *
       * The flag governs whether REMOTE state is authoritative on a cold boot.
       * It has never meant "do not remember what this page decided", and the
       * clock slot is written either way — which is why this now passes.
       */
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      const room = await openRoom(broker);
      await room.phone.stop();
      let phone = await startPhonePeer(broker, {
        name: 'phone',
        id: 'phonepeer001',
        persistRemote: false,
      });
      await sleep(HANDSHAKE_MS * 3);

      try {
        note(`---- the phone sets fit=${mine} ----`);
        phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: mine } }));
        await sleep(600);
        note(`---- CAM sets fit=${theirs}; nothing writes the phone's document ----`);
        room.config.store.commit((s) => ({ ...s, render: { ...s.render, fit: theirs } }));
        await sleep(600);

        const inherited = phone.doc();
        note(`phone register fit=${fitOn(phone)} document fit=${inherited.render.fit}`);
        note('---- the phone reloads ----');
        await phone.stop();
        phone = await startPhonePeer(broker, {
          name: 'phoneB',
          id: 'phonepeerb02',
          device: 'phone',
          persistRemote: false,
          initial: inherited,
        });

        const peers = [phone, room.config, room.display];
        const settled = await settleWithin(() => peers.map((p) => `${p.name}=${fitOn(p)}`), 10_000);
        expect(
          withStory(settled.join(' '), `phoneB=${theirs} CAM=${theirs} display=${theirs}`),
        ).toBe(`phoneB=${theirs} CAM=${theirs} display=${theirs}`);
      } finally {
        await phone.stop();
        await room.config.stop();
        await room.display.stop();
      }
    }, 60_000);
  }

  for (const [first, second] of [
    [90, 270],
    [270, 90],
  ] as const) {
    it(`does not let a THIRD peer's reload revert the author's write (${String(first)} then ${String(second)})`, async () => {
      /*
       * The corollary that makes this a room-wide defect rather than a local
       * one: the peer that reloads need not be the one that wrote anything.
       * Phone A makes both writes; phone B reloads 400 ms after the second and
       * republishes the first under the second's stamp — and A's own edit is
       * gone from every screen in the room, including A's.
       */
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      const display = await startDisplayPeer(broker);
      const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
      let phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
      await sleep(HANDSHAKE_MS * 3);

      try {
        note(`---- A sets rotate=${String(first)}; the room settles ----`);
        phoneA.store.commit((s) => ({ ...s, render: { ...s.render, rotate: first } }));
        /*
         * Twice the throttle, so B's last persist is certainly more than one
         * window old and the NEXT frame it receives opens a fresh one. Without
         * that the window B is in when the second tap lands is a coin toss, and
         * a test of a race that only sometimes stages the race is not a test.
         */
        await sleep(PAST_THE_THROTTLE_MS + PERSIST_REMOTE_THROTTLE_MS);

        note("---- A touches an UNRELATED leaf, which opens B's persist window ----");
        phoneA.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
        await sleep(500);
        note(`---- A sets rotate=${String(second)}, inside that window ----`);
        phoneA.store.commit((s) => ({ ...s, render: { ...s.render, rotate: second } }));
        await sleep(400);

        note('---- B reloads, inside its own persist window ----');
        const inherited = phoneB.doc();
        note(`B's document says rotate=${String(inherited.render.rotate)}`);
        await phoneB.stop();
        phoneB = await startPhonePeer(broker, {
          name: 'phoneB2',
          id: 'phonepeerb02',
          device: 'phoneB',
          initial: inherited,
        });

        const peers = [display, phoneA, phoneB];
        const settled = await settleWithin(
          () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
          10_000,
        );
        const want = `display=${String(second)} phoneA=${String(second)} phoneB2=${String(second)}`;
        expect(withStory(settled.join(' '), want)).toBe(want);
        // And the module nobody touched is not collateral damage.
        expect(withStory(moduleOn(display), 'video')).toBe('video');
      } finally {
        await phoneB.stop();
        await phoneA.stop();
        await display.stop();
      }
    }, 60_000);
  }
});
