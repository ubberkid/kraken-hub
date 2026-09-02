/**
 * "I change it on my phone, it goes green, and half a second later it is back."
 *
 * The THIRD report of the settings-revert class, and the first one the two-peer
 * harness in `roomConvergence.dom.test.ts` could not produce. That file models a
 * room with two windows in it and pins the four defects that report found; this
 * one adds the window that made the bug reappear — a phone, on its own device,
 * with CAM's configuration browser and the display both live.
 *
 * ## Why a third window changes the physics
 *
 * CAM's config browser and the Kraken display browser share one origin and
 * therefore one storage document. The display persists remote state to it about
 * every two seconds, and every one of those writes is a store notification in
 * CAM — which republishes its snapshot on every store notification. So in a
 * three-window room there is nearly always a CAM snapshot in flight, and a
 * snapshot in flight was taken BEFORE whatever you are about to tap.
 *
 * Under plain last-writer-wins BY ARRIVAL that frame won, because it landed
 * last. Under per-leaf last-writer-wins on a hybrid logical clock it loses,
 * because the leaf it is re-asserting carries an older stamp than the tap.
 *
 * The room itself lives in `./roomHarness.ts`: a broker with `LATENCY_MS` of
 * distance in it, a retained slot, radios that drop, and a phone with its own
 * document.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withModuleConfig } from '../state/selectors';
import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { stateToSyncBody } from './appSync';
import { encodeEnvelope } from './envelope';
import {
  HANDSHAKE_MS,
  HOLD_MS,
  LATENCY_MS,
  createBroker,
  firstDeviation,
  fitOn,
  moduleOn,
  note,
  nextPublish,
  openRoom,
  resetClockSlots,
  resetTrace,
  retainedAuthoredBy,
  rotateOn,
  seedEarlierSession,
  settleWithin,
  sleep,
  stamp,
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  videoCfg,
  withStory,
  type Peer,
} from './roomHarness';
import { PROTOCOL_VERSION } from './types';

describe('three windows in one room', () => {
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

  it('holds a module switched on the phone, on the phone and on the display', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      // The tap lands in the window where CAM's snapshot of the OLD state is
      // between the throttle and the wire. That frame is live, it is newer by
      // arrival and older by causality, and it used to win.
      await nextPublish();
      note('---- the user taps Clock on the phone ----');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      expect(moduleOn(room.phone)).toBe('clock');

      const drift = await firstDeviation(() => moduleOn(room.phone), 'clock', HOLD_MS);
      expect(withStory(drift, '')).toBe('');
      // …and the room agreed, so this is not a phone that has stopped listening.
      expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');
      expect(withStory(moduleOn(room.config), 'clock')).toBe('clock');
    } finally {
      await room.stop();
    }
  }, 30_000);

  it('holds a video config field changed on the phone', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      await nextPublish();
      note('---- the user picks Contain on the phone ----');
      room.phone.store.commit((s) =>
        withModuleConfig(s, 'video', 1, {
          ...(s.modules['video']?.cfg as Record<string, unknown> | undefined),
          render: { fit: 'contain' },
        }),
      );

      const read = (): string => {
        const render = videoCfg(room.phone)['render'] as { fit?: string } | undefined;
        return render?.fit ?? 'unset';
      };
      expect(withStory(await firstDeviation(read, 'contain', HOLD_MS), '')).toBe('');
      const onDisplay = videoCfg(room.display)['render'] as { fit?: string } | undefined;
      expect(withStory(onDisplay?.fit ?? 'unset', 'contain')).toBe('contain');
    } finally {
      await room.stop();
    }
  }, 30_000);

  it('holds a shelf tile played from the phone', async () => {
    // Playing a tile needs no command: it is a state commit, because state is a
    // full retained snapshot both windows already share. Which also means it is
    // exposed to exactly the revert this file is about — and it is the surface
    // the third report came in on.
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      await nextPublish();
      note('---- the user taps a clip on the phone shelf ----');
      room.phone.store.commit((s) =>
        withModuleConfig(s, 'video', 1, {
          ...(s.modules['video']?.cfg as Record<string, unknown> | undefined),
          source: { kind: 'library', id: 'clip-7' },
        }),
      );

      const read = (peer: Peer): string => {
        const source = videoCfg(peer)['source'] as { id?: string } | undefined;
        return source?.id ?? 'unset';
      };
      expect(withStory(await firstDeviation(() => read(room.phone), 'clip-7', HOLD_MS), '')).toBe(
        '',
      );
      expect(withStory(read(room.display), 'clip-7')).toBe('clip-7');
    } finally {
      await room.stop();
    }
  }, 30_000);

  it('holds a curation action taken on the phone while a stale snapshot is in flight', async () => {
    /*
     * Pin/rename/delete ride the `cmd` channel and never touch the precedence
     * layers, so what has to be proved here is that the two mechanisms do not
     * interfere: the command still reaches the display exactly once while a
     * stale state frame is in the air, and the state change the same tap made —
     * the shelf's own view of which clip is playing — survives it.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);
    const pins: unknown[] = [];
    room.display.sync.service.onCmd((body) => {
      if (body.op === 'setPinned') pins.push(body.arg);
    });

    try {
      await nextPublish();
      note('---- the user pins a clip on the phone ----');
      room.phone.sync.service.sendCmd('setPinned', { ids: ['clip-7'], pinned: true });
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));

      expect(
        withStory(await firstDeviation(() => moduleOn(room.phone), 'clock', HOLD_MS), ''),
      ).toBe('');
      expect(
        withStory(JSON.stringify(pins), JSON.stringify([{ ids: ['clip-7'], pinned: true }])),
      ).toBe(JSON.stringify([{ ids: ['clip-7'], pinned: true }]));
    } finally {
      await room.stop();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The three holes the first causal fix left open
// ---------------------------------------------------------------------------

describe('peers that arrive, blip and come back', () => {
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

  it('adopts a change made by a peer that has applied nothing yet', async () => {
    /*
     * THE NEWCOMER.
     *
     * Every peer in `openRoom` has already applied a frame before anybody taps,
     * so its acknowledgement map is populated and the causal rule has evidence
     * to work with. The normal condition of a phone the user has just unlocked
     * is the opposite one: `clientId()` is fresh per page load, nothing has been
     * applied, `seen` is empty — and a peer with no evidence to offer could
     * never dominate a stamped leaf, so the room refused its value outright.
     * Worse, the frames that refused it DID carry its seq, so they read as
     * acknowledgements, and the newcomer cleared the very layer that was
     * defending the tap. "The sender saw my frame" is not "the sender took my
     * value", and treating the two as the same thing lost the write.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);
    // Move the room off its default first, so the newcomer's tap has to displace
    // a value some LIVE peer is the stamped author of.
    room.config.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
    await sleep(HANDSHAKE_MS * 3);
    expect(withStory(moduleOn(room.phone), 'stats')).toBe('stats');

    // …and now a phone joins, with the bootstrap still in the air.
    const late = await startPhonePeer(broker, {
      name: 'new',
      id: 'phonelate001',
      handshakeMs: 700,
    });
    try {
      note('---- the user taps Clock before any frame has arrived ----');
      late.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      expect(moduleOn(late)).toBe('clock');

      expect(withStory(await firstDeviation(() => moduleOn(late), 'clock', HOLD_MS), '')).toBe('');
      expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');
      expect(withStory(moduleOn(room.config), 'clock')).toBe('clock');
      expect(withStory(moduleOn(room.phone), 'clock')).toBe('clock');
    } finally {
      await late.stop();
      await room.stop();
    }
  }, 40_000);

  it('lets a reloaded phone change a key its previous session set', async () => {
    /*
     * THE ORPHAN STAMP.
     *
     * `clientId()` is fresh on every page load, so a phone that is merely
     * reloaded — pull-to-refresh, a tab restored after the screen slept — is a
     * brand-new `src` that never heard the previous session's frames. Every key
     * that session was the last to change carried a stamp only IT could be
     * acknowledged for, and its author was gone; the reloaded phone was
     * permanently deaf on exactly the keys its owner had most recently used.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);
    let reloaded: Peer | null = null;

    try {
      /*
       * `render.rotate` rather than the module, because it is the one key in the
       * synced body that nothing else in this harness ever touches — the seeded
       * earlier session, CAM's opening publish and the display's persist all
       * leave it alone. So after this commit every peer in the room holds a stamp
       * on it naming THE PHONE as the author, which is the precondition the
       * orphan needs and the thing an incidental echo would otherwise blur.
       */
      await nextPublish();
      note('---- the phone rotates the panel, then the page is reloaded ----');
      room.phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(rotateOn(room.config), '90')).toBe('90');
      expect(withStory(rotateOn(room.display), '90')).toBe('90');

      await room.phone.stop();
      /*
       * Wait for CAM to own the retained slot before the reload.
       *
       * Otherwise the slot may still hold a frame the OLD phone published, and
       * the newcomer's bootstrap would name the departed author by accident —
       * which hides the hole roughly half the time. CAM republishes on every
       * store notification and the display persists about twice a second, so
       * this is the ordinary state of the room a few seconds after a phone
       * closes, not a contrivance.
       */
      await retainedAuthoredBy(broker, 'configpeer01');
      reloaded = await startPhonePeer(broker, {
        name: 'phone2',
        id: 'phonepeer002',
        device: 'phone',
        handshakeMs: HANDSHAKE_MS,
      });
      await sleep(HANDSHAKE_MS * 3);

      const after = reloaded;
      note('---- the reloaded phone rotates it again ----');
      after.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 180 } }));

      expect(withStory(await firstDeviation(() => rotateOn(after), '180', HOLD_MS), '')).toBe('');
      expect(withStory(rotateOn(room.display), '180')).toBe('180');
      expect(withStory(rotateOn(room.config), '180')).toBe('180');
    } finally {
      if (reloaded !== null) await reloaded.stop();
      await room.stop();
    }
  }, 40_000);

  it('does not launder a retained replay a blipped peer refused', async () => {
    /*
     * THE LAUNDERED ACKNOWLEDGEMENT.
     *
     * `seen` was recorded where a frame was RECEIVED, but `applyCausally`
     * deliberately refuses the leaves of a retained frame that land on a key
     * somebody already holds. So a peer coming back from an outage advertised
     * "I applied phoneB#9001" while its own snapshot still contradicted
     * phoneB#9001 — and that false claim is exactly the evidence `dominates()`
     * reads, so the stale body it published next won the argument on a third
     * window against a value that window's user had just set.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);
    const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
    const phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      /*
       * First, a rotation everybody hears — which is what puts a STAMP on the
       * leaf. A leaf nobody has ever changed is unstamped, and a retained replay
       * is allowed to fill it; the laundering only has something to launder once
       * the key has a live author on it.
       */
      note('---- phoneB rotates the panel, with everyone listening ----');
      phoneB.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 180 } }));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(rotateOn(phoneA), '180')).toBe('180');

      note('---- phoneA loses its radio ----');
      phoneA.mute();

      note('---- phoneB rotates again while phoneA is deaf ----');
      phoneB.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(rotateOn(config), '90')).toBe('90');
      expect(withStory(rotateOn(display), '90')).toBe('90');
      // phoneA missed all of it, and still believes the older value.
      expect(withStory(rotateOn(phoneA), '180')).toBe('180');

      /*
       * The retained slot, pinned to a frame phoneB authored.
       *
       * A real broker's slot holds whichever frame landed last, which in a room
       * this chatty is a coin toss. Seeding it makes the replay phoneA is about
       * to receive a fact rather than a race — and it is the same fact: the last
       * thing the broker heard, replayed to whoever subscribes next.
       */
      broker.seedRetained(
        encodeEnvelope({
          v: PROTOCOL_VERSION,
          ch: 'state',
          ts: Date.now(),
          src: 'phonepeerb01',
          role: 'remote',
          seq: 9001,
          rev: 90_001,
          body: stateToSyncBody(config.store.getSnapshot()),
        }),
      );

      note('---- phoneA comes back and is handed the retained slot ----');
      phoneA.unmute();
      await sleep(40);
      // …and its user changes something of their own, which republishes the
      // whole stale snapshot along with whatever `seen` phoneA now claims.
      phoneA.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));

      expect(withStory(await firstDeviation(() => rotateOn(phoneB), '90', HOLD_MS), '')).toBe('');
      expect(withStory(rotateOn(config), '90')).toBe('90');
      expect(withStory(rotateOn(display), '90')).toBe('90');
      // phoneA's own change still reached the room — the fix is not a mute.
      expect(withStory(config.store.getSnapshot().render.fit, 'contain')).toBe('contain');
    } finally {
      await phoneB.stop();
      await phoneA.stop();
      await config.stop();
      await display.stop();
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------
// The property: nobody's own change ever goes backwards
// ---------------------------------------------------------------------------

/**
 * A seeded generator, so a failing schedule is a number somebody can re-run
 * rather than a story about a bad afternoon.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MODULES = ['video', 'clock', 'stats'];
const FITS = ['cover', 'contain', 'contain-circle'];
const ROTATIONS = [0, 90, 180, 270] as const;

describe('random interleavings of three peers', () => {
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

  /*
   * Three peers, three keys, one rule.
   *
   * Each peer owns a key nobody else writes, so "did this peer's own change
   * revert?" has an unambiguous answer at every instant: after a peer commits a
   * value, its own reading of its own key may never show anything else until it
   * commits again. That is the property the user is actually reporting when they
   * say "it flips back", and it is stronger than eventual convergence — a room
   * that ends up right after flickering through two wrong values is still a room
   * that lied to somebody.
   *
   * Convergence is asserted too, at the end, once the wire is quiet.
   */
  for (const seed of [1, 7, 13, 29]) {
    it(`converges without any peer's own change reverting (seed ${String(seed)})`, async () => {
      const random = mulberry32(seed);
      // Jitter, and reordering with it: two frames published in order can arrive
      // out of order, which is a thing a real broker with two transports does.
      const broker = createBroker(() => 60 + Math.floor(random() * 140));
      seedEarlierSession(broker, 'video');

      const display = await startDisplayPeer(broker);
      const config = await startConfigPeer(broker, HANDSHAKE_MS);
      const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
      const phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
      await sleep(HANDSHAKE_MS * 3);

      const owners = [
        {
          peer: config,
          set: (value: number) => {
            config.store.commit((s) => ({
              ...s,
              activeModuleId: MODULES[value % MODULES.length] ?? 'video',
            }));
          },
          read: (peer: Peer) => peer.store.getSnapshot().activeModuleId,
          want: (value: number) => MODULES[value % MODULES.length] ?? 'video',
        },
        {
          peer: phoneA,
          set: (value: number) => {
            phoneA.store.commit((s) => ({
              ...s,
              render: { ...s.render, fit: (FITS[value % FITS.length] ?? 'cover') as 'cover' },
            }));
          },
          read: (peer: Peer) => peer.store.getSnapshot().render.fit,
          want: (value: number) => FITS[value % FITS.length] ?? 'cover',
        },
        {
          peer: phoneB,
          set: (value: number) => {
            phoneB.store.commit((s) => ({
              ...s,
              render: { ...s.render, rotate: ROTATIONS[value % ROTATIONS.length] ?? 0 },
            }));
          },
          read: (peer: Peer) => String(peer.store.getSnapshot().render.rotate),
          want: (value: number) => String(ROTATIONS[value % ROTATIONS.length] ?? 0),
        },
      ];

      // The last value each owner committed, and therefore the only value its
      // own window is allowed to be showing from that moment on.
      const expected = new Map<number, string>();
      const violations: string[] = [];

      const watchdog = setInterval(() => {
        for (const [index, owner] of owners.entries()) {
          const want = expected.get(index);
          if (want === undefined) continue;
          const got = owner.read(owner.peer);
          if (got !== want) {
            violations.push(`${stamp()} ${owner.peer.name} own key: ${got}, committed ${want}`);
            note(`  stamps=${JSON.stringify(owner.peer.sync.stampedLeaves())}`);
            note(`  remote=${JSON.stringify(owner.peer.sync.remoteLayer())}`);
            note(`DEVIATION: ${owner.peer.name} own key reverted to ${got}, committed ${want}`);
            expected.delete(index);
          }
        }
      }, 20);

      try {
        for (let step = 0; step < 9; step += 1) {
          const index = Math.floor(random() * owners.length);
          const owner = owners[index];
          if (owner === undefined) continue;
          const value = Math.floor(random() * 4);
          // Half the commits are timed to the publish beat — the window this
          // whole file exists for — and half land wherever they land.
          if (random() < 0.5) await nextPublish();
          else await sleep(Math.floor(random() * 250));
          owner.set(value);
          expected.set(index, owner.want(value));
          note(`${owner.peer.name} committed ${owner.want(value)}`);
        }

        // Let the wire go quiet: two persist cycles is longer than any frame can
        // stay in flight.
        await sleep(5000);
        clearInterval(watchdog);

        expect(withStory(violations.join('\n'), '')).toBe('');
        for (const [index, owner] of owners.entries()) {
          const want = expected.get(index);
          if (want === undefined) continue;
          for (const peer of [config, phoneA, phoneB, display]) {
            expect(withStory(`${peer.name}=${owner.read(peer)}`, `${peer.name}=${want}`)).toBe(
              `${peer.name}=${want}`,
            );
          }
        }
      } finally {
        clearInterval(watchdog);
        await phoneB.stop();
        await phoneA.stop();
        await config.stop();
        await display.stop();
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// …and the same property, in a room people keep arriving at and leaving
// ---------------------------------------------------------------------------

describe('random interleavings with joins, reloads and blips', () => {
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

  /*
   * The seeds above hold every peer fixed for the length of the run, which is
   * the one shape a real room never has. A phone is unlocked and tapped before
   * its first frame lands; a page is pulled to refresh and comes back with a
   * brand-new `clientId()`; a radio drops for a couple of seconds and the broker
   * hands over its retained slot on the way back in. All three broke the first
   * causal fix, none of them was reachable from the fixed-cast schedule, and
   * that is the whole reason they shipped green.
   *
   * Same property, same disjoint owned keys: after a peer commits a value, its
   * own reading of its own key may never show anything else until it commits
   * again — with one honest exception, which is a page that has RELOADED. That
   * is a new page with its own document and no memory, so its expectation is
   * dropped at the moment of the reload rather than carried across it.
   */
  for (const seed of [3, 11, 23]) {
    it(`converges through joins, reloads and blips (seed ${String(seed)})`, async () => {
      const random = mulberry32(seed);
      const broker = createBroker(() => 60 + Math.floor(random() * 140));
      seedEarlierSession(broker, 'video');

      const display = await startDisplayPeer(broker);
      const config = await startConfigPeer(broker, HANDSHAKE_MS);
      const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
      let phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
      /** The newcomer, which joins mid-run and taps before it has heard anything. */
      let joiner: Peer | null = null;
      await sleep(HANDSHAKE_MS * 3);

      interface Owner {
        peer: Peer | null;
        set: (value: number) => void;
        read: (peer: Peer) => string;
        want: (value: number) => string;
      }

      const ZOOMS = [1, 1.25, 1.5, 2];
      const owners: Owner[] = [
        {
          peer: config,
          set: (value) => {
            config.store.commit((s) => ({
              ...s,
              activeModuleId: MODULES[value % MODULES.length] ?? 'video',
            }));
          },
          read: (peer) => peer.store.getSnapshot().activeModuleId,
          want: (value) => MODULES[value % MODULES.length] ?? 'video',
        },
        {
          peer: phoneA,
          set: (value) => {
            phoneA.store.commit((s) => ({
              ...s,
              render: { ...s.render, fit: (FITS[value % FITS.length] ?? 'cover') as 'cover' },
            }));
          },
          read: (peer) => peer.store.getSnapshot().render.fit,
          want: (value) => FITS[value % FITS.length] ?? 'cover',
        },
        {
          peer: phoneB,
          set: (value) => {
            phoneB.store.commit((s) => ({
              ...s,
              render: { ...s.render, rotate: ROTATIONS[value % ROTATIONS.length] ?? 0 },
            }));
          },
          read: (peer) => String(peer.store.getSnapshot().render.rotate),
          want: (value) => String(ROTATIONS[value % ROTATIONS.length] ?? 0),
        },
        {
          // Owned by nobody until the newcomer arrives.
          peer: null,
          set: (value) => {
            joiner?.store.commit((s) => ({
              ...s,
              render: { ...s.render, zoom: ZOOMS[value % ZOOMS.length] ?? 1 },
            }));
          },
          read: (peer) => String(peer.store.getSnapshot().render.zoom),
          want: (value) => String(ZOOMS[value % ZOOMS.length] ?? 1),
        },
      ];

      const expected = new Map<number, string>();
      const violations: string[] = [];
      const live = (): Peer[] =>
        [config, phoneA, phoneB, display, joiner].filter((p): p is Peer => p !== null);

      const watchdog = setInterval(() => {
        for (const [index, owner] of owners.entries()) {
          const want = expected.get(index);
          const peer = owner.peer;
          if (want === undefined || peer === null) continue;
          const got = owner.read(peer);
          if (got !== want) {
            violations.push(`${stamp()} ${peer.name} own key: ${got}, committed ${want}`);
            note(`DEVIATION: ${peer.name} own key reverted to ${got}, committed ${want}`);
            expected.delete(index);
          }
        }
      }, 20);

      /** Peers whose radio is currently cut, and the step they come back on. */
      const muted = new Map<Peer, number>();

      try {
        for (let step = 0; step < 10; step += 1) {
          for (const [peer, until] of [...muted]) {
            if (step < until) continue;
            note(`---- ${peer.name} gets its radio back ----`);
            peer.unmute();
            muted.delete(peer);
            /*
             * Let the returning peer's first republish land before anybody taps
             * again.
             *
             * A radio that has just come back is holding a snapshot of the room
             * as it was two seconds ago, and it republishes that snapshot before
             * it has applied anything new. Whether a commit made in the middle
             * of THAT exchange survives is a genuinely open question — neither
             * writer has seen the other, so it is the concurrent case, and the
             * arbitration's answer is "the incumbent holds", which is a coin
             * toss from the user's point of view. The property these seeds
             * assert is the one the design does promise: once the room has
             * heard the returning peer, nobody's committed value goes backwards.
             */
            await sleep(HANDSHAKE_MS + LATENCY_MS * 2);
          }

          if (step === 2) {
            /*
             * A phone unlocked mid-run, tapping before its first inbound frame.
             * `handshakeMs` holds the retained bootstrap back long enough for the
             * commit below to happen with an empty acknowledgement map, which is
             * the newcomer case the fixed-cast seeds cannot reach.
             */
            note('---- a phone joins and taps immediately ----');
            joiner = await startPhonePeer(broker, {
              name: 'joiner',
              id: 'phonejoin0001',
              handshakeMs: 700,
            });
            const zoomOwner = owners[3];
            if (zoomOwner !== undefined) {
              zoomOwner.peer = joiner;
              zoomOwner.set(1);
              expected.set(3, zoomOwner.want(1));
            }
          }

          if (step === 6) {
            // The reload: same device, same user, brand-new `clientId()`.
            note('---- phoneB reloads ----');
            expected.delete(2);
            await phoneB.stop();
            phoneB = await startPhonePeer(broker, {
              name: 'phoneB2',
              id: 'phonepeerb02',
              device: 'phoneB',
            });
            const rotateOwner = owners[2];
            if (rotateOwner !== undefined) {
              const reloaded = phoneB;
              rotateOwner.peer = reloaded;
              rotateOwner.set = (value) => {
                reloaded.store.commit((s) => ({
                  ...s,
                  render: { ...s.render, rotate: ROTATIONS[value % ROTATIONS.length] ?? 0 },
                }));
              };
            }
            await sleep(HANDSHAKE_MS * 2);
          }

          // A radio drop, for two steps.
          if (random() < 0.35 && muted.size === 0) {
            const candidates = live().filter((p) => p.name !== 'display');
            const victim = candidates[Math.floor(random() * candidates.length)];
            if (victim !== undefined) {
              note(`---- ${victim.name} loses its radio ----`);
              victim.mute();
              muted.set(victim, step + 2);
            }
          }

          const index = Math.floor(random() * owners.length);
          const owner = owners[index];
          const actor = owner?.peer;
          if (owner === undefined || actor === null || actor === undefined) continue;
          const value = Math.floor(random() * 4);
          if (random() < 0.5) await nextPublish();
          else await sleep(Math.floor(random() * 250));
          // A muted peer's commit cannot be published, so it is not a promise
          // the room can be asked to keep — only its own reading is.
          owner.set(value);
          expected.set(index, owner.want(value));
          note(`${actor.name} committed ${owner.want(value)}`);
        }

        for (const [peer] of [...muted]) {
          note(`---- ${peer.name} gets its radio back ----`);
          peer.unmute();
        }
        muted.clear();

        // Longer than `STAMP_TTL_MS`, so this also proves the last-resort floor
        // under the causal rule actually delivers: a room that cannot establish
        // an order still agrees in the end, it does not split.
        await sleep(9000);
        clearInterval(watchdog);

        expect(withStory(violations.join('\n'), '')).toBe('');
        for (const [index, owner] of owners.entries()) {
          const want = expected.get(index);
          if (want === undefined) continue;
          for (const peer of live()) {
            expect(withStory(`${peer.name}=${owner.read(peer)}`, `${peer.name}=${want}`)).toBe(
              `${peer.name}=${want}`,
            );
          }
        }
      } finally {
        clearInterval(watchdog);
        if (joiner !== null) await joiner.stop();
        await phoneB.stop();
        await phoneA.stop();
        await config.stop();
        await display.stop();
      }
    }, 90_000);
  }
});

// ---------------------------------------------------------------------------
// The four schedules the ack design could not survive
// ---------------------------------------------------------------------------

/**
 * These are not new attacks. They are the exact reproductions four independent
 * skeptics ran against the acknowledgement-map design, each of which it failed
 * deterministically, and each of which its own patches reopened somewhere else:
 *
 *  - **S1** a frame this page OVERRULED still contributed its `seen` map
 *    wholesale, so a peer coming back from a blip advertised a value it was
 *    itself contradicting, and a third window then dropped a fresh commit.
 *  - **S2 / S3** two live, chatty peers writing the same leaf deadlocked
 *    forever: `acknowledgesUs` was measured against `lastRequestedStateSeq`,
 *    which moves on every publish, so it could never become true between two
 *    peers that both republish on every store notification.
 *  - **S4** lives in `twoPeerDisplayOnly.dom.test.ts`, because it needs the
 *    room with no CAM in it.
 *
 * Under per-leaf registers ordered by a hybrid logical clock none of them has a
 * mechanism left: there is no acknowledgement to launder, no refusal to
 * deadlock on, and a retained replay is just a frame with old stamps.
 */
describe('the schedules that defeated the acknowledgement design', () => {
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

  it('does not launder a fresh value through a retained replay a blipped peer overruled (S1)', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);
    const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
    const phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- phoneA picks Contain, with everyone listening ----');
      phoneA.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(fitOn(phoneB), 'contain')).toBe('contain');

      note('---- phoneA loses its radio ----');
      phoneA.mute();

      note('---- phoneB picks Cover while phoneA is deaf ----');
      phoneB.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'cover' } }));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(fitOn(config), 'cover')).toBe('cover');
      expect(withStory(fitOn(display), 'cover')).toBe('cover');
      expect(withStory(fitOn(phoneA), 'contain')).toBe('contain');

      // The retained slot, pinned to CAM — so the replay phoneA is handed is a
      // fact rather than a race, and it carries CAM's account of the room.
      await retainedAuthoredBy(broker, 'configpeer01');

      note('---- phoneA comes back and commits something of its own ----');
      phoneA.unmute();
      await sleep(40);
      phoneA.store.commit((s) => ({ ...s, render: { ...s.render, zoom: 1.5 } }));

      expect(withStory(await firstDeviation(() => fitOn(phoneB), 'cover', HOLD_MS), '')).toBe('');
      expect(withStory(fitOn(config), 'cover')).toBe('cover');
      expect(withStory(fitOn(display), 'cover')).toBe('cover');
      expect(withStory(fitOn(phoneA), 'cover')).toBe('cover');
      // …and phoneA's own change still reached the room: the fix is not a mute.
      expect(withStory(String(config.store.getSnapshot().render.zoom), '1.5')).toBe('1.5');
    } finally {
      await phoneB.stop();
      await phoneA.stop();
      await config.stop();
      await display.stop();
    }
  }, 60_000);

  /**
   * The contended write, at four gaps.
   *
   * `0` is genuinely simultaneous and the room may legitimately land on either
   * value — all that is required is that it lands on ONE of them, everywhere.
   * From `150` ms the two taps are further apart than a one-way delivery, so a
   * user watching both screens would call the second one later, and the room has
   * to agree with them.
   */
  const GAPS = [0, 60, 150, 300];

  for (const gap of GAPS) {
    it(`settles a same-key contest between CAM and the phone at ${String(gap)} ms (S2)`, async () => {
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      const room = await openRoom(broker);

      try {
        await nextPublish();
        note(`---- CAM rotates to 180, the phone to 90, ${String(gap)} ms later ----`);
        room.config.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 180 } }));
        if (gap > 0) await sleep(gap);
        room.phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));

        const peers = [room.phone, room.config, room.display];
        const readings = await settleWithin(
          () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
          10_000,
        );
        const values = new Set(readings.map((r) => r.split('=')[1] ?? ''));
        expect(withStory(readings.join(' '), readings.join(' '))).toBe(readings.join(' '));
        expect(
          withStory(`${String(values.size)} ${readings.join(' ')}`, `1 ${readings.join(' ')}`),
        ).toBe(`1 ${readings.join(' ')}`);
        const agreed = [...values][0] ?? '';
        expect(withStory(agreed, ['90', '180'].includes(agreed) ? agreed : 'one of 90|180')).toBe(
          agreed,
        );
        /*
         * Far enough apart to be sequential in wall time: the later tap wins.
         * Below 150 ms the two are inside one delivery of each other and either
         * answer is legitimate, so the requirement is only the agreement above.
         */
        const wanted = gap >= 150 ? '90' : agreed;
        expect(withStory(agreed, wanted)).toBe(wanted);
      } finally {
        await room.stop();
      }
    }, 60_000);

    it(`settles a same-key contest between two phones at ${String(gap)} ms (S3)`, async () => {
      const broker = createBroker();
      seedEarlierSession(broker, 'video');
      const display = await startDisplayPeer(broker);
      const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
      const phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
      await sleep(HANDSHAKE_MS * 3);

      try {
        await nextPublish();
        note(`---- phoneA picks Stats, phoneB picks Clock, ${String(gap)} ms later ----`);
        phoneA.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
        if (gap > 0) await sleep(gap);
        phoneB.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));

        const peers = [phoneA, phoneB, display];
        const readings = await settleWithin(
          () => peers.map((p) => `${p.name}=${moduleOn(p)}`),
          10_000,
        );
        const values = new Set(readings.map((r) => r.split('=')[1] ?? ''));
        expect(
          withStory(`${String(values.size)} ${readings.join(' ')}`, `1 ${readings.join(' ')}`),
        ).toBe(`1 ${readings.join(' ')}`);
        const agreed = [...values][0] ?? '';
        expect(
          withStory(agreed, ['stats', 'clock'].includes(agreed) ? agreed : 'one of stats|clock'),
        ).toBe(agreed);
        const wanted = gap >= 150 ? 'clock' : agreed;
        expect(withStory(agreed, wanted)).toBe(wanted);
      } finally {
        await phoneB.stop();
        await phoneA.stop();
        await display.stop();
      }
    }, 60_000);
  }

  it('lets the phone win the key CAM changed while it was locked (S2, contended)', async () => {
    /*
     * The physical script: the owner taps Clock on the phone, the screen locks
     * (radio cut), CAM picks Stats while the phone is away, and the moment the
     * phone comes back its owner picks Video. Two live peers, one leaf, and a
     * retained replay in the air at the same time.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

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
        10_000,
      );
      expect(withStory(readings.join(' '), `phone=video CAM=video display=video`)).toBe(
        'phone=video CAM=video display=video',
      );
    } finally {
      await room.stop();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Out-of-order delivery, duplicates and replays
// ---------------------------------------------------------------------------

describe('a wire that reorders, duplicates and replays', () => {
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

  for (const seed of [5, 17, 31]) {
    it(`converges through reordering, duplicates and replays (seed ${String(seed)})`, async () => {
      /*
       * The merge is commutative, associative and idempotent, so the order
       * frames arrive in cannot change where the room ends up — see the proof
       * sketch in `src/sync/merge.ts`. This asserts exactly that property
       * against a wire that alternates 320 ms and 40 ms delivery (so frames
       * overtake each other), duplicates every frame, and replays the retained
       * slot at every reconnection.
       */
      const random = mulberry32(seed);
      let slow = true;
      const broker = createBroker(() => {
        slow = !slow;
        return slow ? 320 : 40;
      });
      seedEarlierSession(broker, 'video');

      const display = await startDisplayPeer(broker);
      const config = await startConfigPeer(broker, HANDSHAKE_MS);
      const phoneA = await startPhonePeer(broker, { name: 'phoneA', id: 'phonepeera01' });
      const phoneB = await startPhonePeer(broker, { name: 'phoneB', id: 'phonepeerb01' });
      await sleep(HANDSHAKE_MS * 3);

      const actors = [
        {
          peer: config,
          set: (v: number) => {
            config.store.commit((s) => ({
              ...s,
              activeModuleId: MODULES[v % MODULES.length] ?? 'video',
            }));
          },
          read: (p: Peer) => p.store.getSnapshot().activeModuleId,
        },
        {
          peer: phoneA,
          set: (v: number) => {
            phoneA.store.commit((s) => ({
              ...s,
              render: { ...s.render, fit: (FITS[v % FITS.length] ?? 'cover') as 'cover' },
            }));
          },
          read: (p: Peer) => p.store.getSnapshot().render.fit,
        },
        {
          peer: phoneB,
          set: (v: number) => {
            phoneB.store.commit((s) => ({
              ...s,
              render: { ...s.render, rotate: ROTATIONS[v % ROTATIONS.length] ?? 0 },
            }));
          },
          read: (p: Peer) => String(p.store.getSnapshot().render.rotate),
        },
      ];

      try {
        for (let step = 0; step < 12; step += 1) {
          const actor = actors[Math.floor(random() * actors.length)];
          if (actor === undefined) continue;
          if (random() < 0.5) await nextPublish();
          else await sleep(Math.floor(random() * 200));
          actor.set(Math.floor(random() * 4));
          // A blip on a random peer, healed immediately: the return path replays
          // the retained slot, which is the duplicate/replay half of the test.
          if (random() < 0.3) {
            const victim = [config, phoneA, phoneB][Math.floor(random() * 3)];
            victim?.mute();
            await sleep(150);
            victim?.unmute();
          }
        }

        /*
         * Three seconds, not nine. A merge that is a pure comparison of stamps
         * settles as fast as the last frame can be delivered — there is no
         * liveness timeout to wait out any more, and asserting a short window is
         * what keeps a regression to a "wait and hope" design honest.
         */
        const peers = [config, phoneA, phoneB, display];
        for (const actor of actors) {
          const readings = await settleWithin(
            () => peers.map((p) => `${p.name}=${actor.read(p)}`),
            3000,
          );
          const values = new Set(readings.map((r) => r.split('=')[1] ?? ''));
          expect(
            withStory(`${String(values.size)} ${readings.join(' ')}`, `1 ${readings.join(' ')}`),
          ).toBe(`1 ${readings.join(' ')}`);
        }
      } finally {
        await phoneB.stop();
        await phoneA.stop();
        await config.stop();
        await display.stop();
      }
    }, 90_000);
  }
});

// ---------------------------------------------------------------------------
// The look, across the room (§6.1, W1c)
// ---------------------------------------------------------------------------

describe('the arrangement travels', () => {
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

  it('carries a look with three overlays from CAM to the display and the phone', async () => {
    /*
     * Before §6 the wire carried a base kind and nothing else, so a stack built
     * in the editor existed only in the window that built it. The look is now a
     * set of leaves like any other — one per layer plus one for the z-order —
     * so it merges, survives a partial body, and cannot disagree with
     * `activeModuleId` about what the base is.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      await nextPublish();
      note('---- CAM composes a stack of three overlays ----');
      room.config.store.commit((s) => ({
        ...s,
        activeModuleId: 'video',
        look: {
          layers: [
            { ...s.look.layers[0]!, kind: 'video' },
            {
              id: 'lclock01',
              kind: 'clock',
              on: true,
              frame: { w: 1, h: 1, shape: 'square' as const },
              t: { x: 0.4, y: -0.4, s: 1, r: 0, a: 1 },
              cfg: { face: 'analog' },
            },
            {
              id: 'lstats01',
              kind: 'stats',
              on: true,
              frame: { w: 1.5, h: 0.5, shape: 'square' as const },
              t: { x: 0, y: 0.6, s: 1, r: 0, a: 0.9 },
              cfg: { layout: 'strip' },
            },
            {
              id: 'ltext001',
              kind: 'text',
              on: false,
              frame: { w: 1, h: 0.4, shape: 'square' as const },
              t: { x: 0, y: -0.7, s: 1, r: 0, a: 1 },
              cfg: { text: 'hello' },
            },
          ],
        },
      }));

      const read = (peer: Peer): string =>
        peer.store
          .getSnapshot()
          .look.layers.map((l) => `${l.id}:${l.kind}:${l.on ? 'on' : 'off'}`)
          .join(' ');

      const wanted = 'base:video:on lclock01:clock:on lstats01:stats:on ltext001:text:off';
      const readings = await settleWithin(
        () => [room.config, room.display, room.phone].map((p) => read(p)),
        6000,
      );
      for (const got of readings) expect(withStory(got, wanted)).toBe(wanted);
    } finally {
      await room.stop();
    }
  }, 40_000);
});
