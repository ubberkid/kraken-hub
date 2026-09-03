/**
 * A phone that opened the remote with NO connectivity, tapped, closed, and came
 * back.
 *
 * The intent layer's claim — "a page that has heard NOTHING yet holds its writes
 * as intents and re-stamps them against the first inbound frame's clock" — was
 * true for exactly one page load. `heard` is persisted in the v2 slot and so is
 * the register table, but the `intents` SET was in-memory only: `startAppSync`'s
 * restore rebuilt the registers, seeded `unshipped`, and seeded nothing into
 * `intents`. So a session that ended having heard nothing came back with its
 * offline writes carrying the skewed stamps they were born with, and
 * `foldRoomFrame` had an empty set to drain. The write was ordered by the
 * phone's own wrong clock, forever, across every subsequent reload.
 *
 * This is NOT the documented residue. That one needs a peer more than
 * `MAX_ROOM_OFFSET_MS` — a day — out. This fires at THREE SECONDS.
 *
 * The repair needs no new slot key and no version bump: a page whose previous
 * session never heard the room has, by construction, only its OWN writes in the
 * table (`heard` is set by the first inbound frame on any channel, so a restored
 * register cannot have come from a merge), so the set is DERIVED from `heard`
 * plus the restored paths — both of which the v2 slot already carries.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAppState } from '../state/defaults';
import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  HANDSHAKE_MS,
  createBroker,
  fitOn,
  installDeviceClocks,
  note,
  resetClockSlots,
  resetTrace,
  restoreDeviceClocks,
  settleWithin,
  sleep,
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

type Fit = AppState['render']['fit'];

const setFit =
  (fit: Fit) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, fit } });

const A_SECOND = 1000;
const AN_HOUR = 60 * 60 * 1000;

/** The skews the table sweeps, with `−1 s` as the row that passed before. */
const SKEWS: { name: string; ms: number }[] = [
  { name: '−1 s', ms: -A_SECOND },
  { name: '−3 s', ms: -3 * A_SECOND },
  { name: '−10 s', ms: -10 * A_SECOND },
  { name: '−90 s', ms: -90 * A_SECOND },
  { name: '−1 h', ms: -AN_HOUR },
];

/** Both value orders, because a tie in the merge is broken by JSON order. */
const ORDERS: { room: Fit; phone: Fit }[] = [
  { room: 'cover', phone: 'contain' },
  { room: 'contain', phone: 'cover' },
];

/**
 * The phone's own document before it has ever heard anybody — a device that
 * shares no storage with CAM or the display, holding whatever it booted with.
 */
function virginPhoneDoc(): AppState {
  return { ...defaultAppState(), render: { ...defaultAppState().render, fit: 'contain-circle' } };
}

describe('a phone whose previous session never reached the room', () => {
  beforeEach(() => {
    installDeviceClocks();
    resetTrace();
    resetClockSlots();
    localStorage.clear();
    resetStateCache();
    commitToStorage(
      (s) => ({ ...s, activeModuleId: 'video', render: { ...s.render, fit: 'fill' } }),
      {
        role: 'config',
      },
    );
  });

  afterEach(() => {
    localStorage.clear();
    resetStateCache();
  });

  afterAll(() => {
    restoreDeviceClocks();
  });

  /**
   * One row of the table.
   *
   * `heardFirst` decides which broker the phone's FIRST session opens on: the
   * room's (so it hears telemetry and folds an offset) or an empty one (a phone
   * that opened the remote in a lift).
   */
  async function runRow(o: {
    skewMs: number;
    room: Fit;
    phone: Fit;
    heardFirst: boolean;
  }): Promise<{ got: string; want: string }> {
    const broker = createBroker();
    const lonely = createBroker();
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);
    await sleep(HANDSHAKE_MS * 3);

    let phone: Peer | null = null;
    try {
      note(`---- CAM commits fit=${o.room} ----`);
      const t0 = Date.now();
      config.store.commit(setFit(o.room));
      await sleep(800);
      expect(withStory(fitOn(display), o.room)).toBe(o.room);

      note(`---- the phone opens ${o.heardFirst ? 'ON the room' : 'with no connectivity'} ----`);
      phone = await startPhonePeer(o.heardFirst ? broker : lonely, {
        name: 'phone',
        id: 'phonepeer001',
        device: 'phone',
        offsetMs: o.skewMs,
        initial: virginPhoneDoc(),
      });
      if (o.heardFirst) await sleep(HANDSHAKE_MS * 2);
      const wait = 1230 - (Date.now() - t0);
      if (wait > 0) await sleep(wait);

      note(`---- and its owner taps fit=${o.phone} ----`);
      phone.store.commit(setFit(o.phone));
      await sleep(300);

      note('---- the page closes and reloads onto the room ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, {
        name: 'phone2',
        id: 'phonepeer002',
        device: 'phone',
        offsetMs: o.skewMs,
        initial: inherited,
      });

      const peers = [display, config, phone];
      const readings = await settleWithin(() => peers.map((p) => `${p.name}=${fitOn(p)}`), 10_000);
      const want = peers.map((p) => `${p.name}=${o.phone}`).join(' ');
      return { got: withStory(readings.join(' '), want), want };
    } finally {
      await phone?.stop();
      await config.stop();
      await display.stop();
    }
  }

  for (const skew of SKEWS) {
    for (const order of ORDERS) {
      it(`keeps its offline fit=${order.phone} at ${skew.name}, room=${order.room}`, async () => {
        const { got, want } = await runRow({
          skewMs: skew.ms,
          room: order.room,
          phone: order.phone,
          heardFirst: false,
        });
        expect(got).toBe(want);
      }, 90_000);
    }
  }

  for (const order of ORDERS) {
    it(`CONTROL skew 0: room=${order.room}, phone=${order.phone}`, async () => {
      const { got, want } = await runRow({
        skewMs: 0,
        room: order.room,
        phone: order.phone,
        heardFirst: false,
      });
      expect(got).toBe(want);
    }, 90_000);

    it(`CONTROL −90 s but it HEARD the room first: room=${order.room}, phone=${order.phone}`, async () => {
      /*
       * The control that says the fix is about the intent layer and not about
       * the skew: a phone this far behind that folded ONE telemetry packet
       * before its tap already stamps in room time, and always did.
       */
      const { got, want } = await runRow({
        skewMs: -90 * A_SECOND,
        room: order.room,
        phone: order.phone,
        heardFirst: true,
      });
      expect(got).toBe(want);
    }, 90_000);
  }
});
