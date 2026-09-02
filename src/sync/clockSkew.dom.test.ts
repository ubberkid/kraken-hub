/**
 * Room time, and why the wall-clock floor was not enough.
 *
 * `tick`'s floor is `t = max(now, seen.t)`: a device whose clock is behind
 * still stamps after everything it has RECEIVED. That is exactly the right rule
 * for a peer that stayed connected, and it says nothing at all about a peer that
 * did not — every write made during an outage is a write it never heard, so
 * `seen.t` is still its own pre-outage stamp and its first tap back stamps in
 * the past.
 *
 * The threshold is not exotic: the failure appears the moment the device's skew
 * exceeds the length of the radio gap. Measured on the shipped S2-contended
 * script (phone locks, CAM changes a module, phone unlocks and taps at once,
 * gap 6.5 s): fine at 3 s behind, lost at 10 s, lost at 90 s. A phone off by a
 * minute lost its first tap after every lift, tunnel and screen lock — the tap
 * went green and came back, which is the original bug report verbatim.
 *
 * So a page now keeps a ROOM-CLOCK OFFSET beside its HLC and stamps with
 * `Date.now() + offset`; see `appSync.ts`. This suite skews the devices to prove
 * it, and keeps the cases that were already green so they stay that way.
 *
 * The harness models a device clock the only way that is honest: `Date.now()` is
 * shifted for the whole window a peer's own code runs in — its taps, its
 * publishes, its inbound deliveries — with `setTimeout`/`setInterval` capturing
 * the ambient offset, so the peer's own throttle arithmetic stays internally
 * consistent exactly as it is on a real device.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { MAX_ROOM_OFFSET_MS } from './appSync';
import { decodeEnvelope } from './envelope';
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
  type Broker,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

const BEHIND_10_S = -10_000;
const BEHIND_90_S = -90_000;
const AHEAD_40_S = 40_000;
const AN_HOUR = 3_600_000;
const THREE_DAYS = 3 * 24 * AN_HOUR;

/**
 * A broker that counts the `state` frames each peer actually puts on the wire.
 *
 * The backward-step defect is invisible from a settled reading — the room is
 * silent, not wrong — so the discriminating measurement is the count of frames,
 * not the value they carry.
 */
function countingBroker(): { broker: Broker; framesFrom: (src: string) => number } {
  const broker = createBroker();
  const counts = new Map<string, number>();
  const inner = broker.publish.bind(broker);
  broker.publish = (ch, frame) => {
    if (ch === 'state') {
      const env = decodeEnvelope(frame);
      if (env !== null) counts.set(env.src, (counts.get(env.src) ?? 0) + 1);
    }
    inner(ch, frame);
  };
  return { broker, framesFrom: (src) => counts.get(src) ?? 0 };
}

/** display + CAM + two phones, each on its own wall clock. */
async function openSkewedRoom(
  broker: Broker,
  offsets: { camMs: number; phoneAMs: number; phoneBMs: number },
): Promise<{ peers: Peer[]; display: Peer; cam: Peer; phoneA: Peer; phoneB: Peer }> {
  const display = await startDisplayPeer(broker);
  const cam = await startConfigPeer(broker, HANDSHAKE_MS, offsets.camMs);
  const phoneA = await startPhonePeer(broker, {
    name: 'phoneA',
    id: 'phonepeera01',
    offsetMs: offsets.phoneAMs,
  });
  const phoneB = await startPhonePeer(broker, {
    name: 'phoneB',
    id: 'phonepeerb01',
    offsetMs: offsets.phoneBMs,
  });
  await sleep(HANDSHAKE_MS * 3);
  return { peers: [display, cam, phoneA, phoneB], display, cam, phoneA, phoneB };
}

type Rotation = AppState['render']['rotate'];
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

const setRotate =
  (deg: Rotation) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

describe('a room whose devices disagree about what time it is', () => {
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

  for (const behind of [0, BEHIND_10_S, BEHIND_90_S, AHEAD_40_S]) {
    it(`lets the phone win the key CAM changed while it was locked (S2 contended, phone ${String(behind / 1000)} s off)`, async () => {
      /*
       * The shipped S2-contended script, parametrized over the phone's clock.
       * At 0 and +40 s it always passed; at −10 s and −90 s it lost the tap,
       * because the phone was deaf for the whole 6.5 s outage and its `seen.t`
       * was still its own pre-outage stamp — so `max(now, seen.t)` floored it
       * at ten or ninety seconds in the past, under CAM's write.
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
          10_000,
        );
        expect(withStory(readings.join(' '), 'phone=video CAM=video display=video')).toBe(
          'phone=video CAM=video display=video',
        );
      } finally {
        await room.stop();
      }
    }, 90_000);
  }

  it('orders every sequential pair by the finger, not by the clock', async () => {
    /*
     * All six ordered pairs of three devices a minute and a half apart, on one
     * leaf, 1.2 s between the taps. The SECOND tap has to win on all four peers
     * every time — this is the property the wall-clock floor already gave, and
     * it must survive the offset being added on top of it.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openSkewedRoom(broker, {
      camMs: 0,
      phoneAMs: BEHIND_90_S,
      phoneBMs: AHEAD_40_S,
    });

    try {
      const writers = [room.cam, room.phoneA, room.phoneB];
      let step = 0;
      for (const first of writers) {
        for (const second of writers) {
          if (first === second) continue;
          // Always two fresh values, so neither tap is a no-op commit.
          step += 1;
          const firstValue = ROTATIONS[step % 4]!;
          step += 1;
          const secondValue = ROTATIONS[step % 4]!;
          note(`---- ${first.name} taps ${String(firstValue)} ----`);
          first.store.commit(setRotate(firstValue));
          await sleep(1200);
          note(`---- ${second.name} taps ${String(secondValue)}, 1.2 s later ----`);
          second.store.commit(setRotate(secondValue));

          const readings = await settleWithin(
            () => room.peers.map((p) => `${p.name}=${rotateOn(p)}`),
            10_000,
          );
          const want = room.peers.map((p) => `${p.name}=${String(secondValue)}`).join(' ');
          expect(withStory(readings.join(' '), want)).toBe(want);
        }
      }
    } finally {
      for (const p of room.peers.slice().reverse()) await p.stop();
    }
  }, 180_000);

  it('lands a seven-tap chain that alternates all three clocks on the last tap', async () => {
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openSkewedRoom(broker, {
      camMs: 0,
      phoneAMs: BEHIND_90_S,
      phoneBMs: AHEAD_40_S,
    });

    try {
      const chain = [
        room.cam,
        room.phoneA,
        room.phoneB,
        room.cam,
        room.phoneB,
        room.phoneA,
        room.cam,
      ];
      let last: Rotation = 0;
      for (const [i, peer] of chain.entries()) {
        last = ROTATIONS[(i + 1) % 4]!;
        note(`---- tap ${String(i + 1)}: ${peer.name} -> ${String(last)} ----`);
        peer.store.commit(setRotate(last));
        await sleep(900);
      }
      const readings = await settleWithin(
        () => room.peers.map((p) => `${p.name}=${rotateOn(p)}`),
        10_000,
      );
      const want = room.peers.map((p) => `${p.name}=${String(last)}`).join(' ');
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      for (const p of room.peers.slice().reverse()) await p.stop();
    }
  }, 120_000);

  it('survives a device whose clock jumps an hour mid-session', async () => {
    /*
     * The jumper's tap wins — and, crucially, a correct-clock peer can still
     * make the NEXT decision. A design that let one bad clock freeze the room
     * for an hour would be worse than the bug it fixed, so both halves are
     * asserted, along with the bound on where the clock ends up.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openSkewedRoom(broker, { camMs: 0, phoneAMs: 0, phoneBMs: 0 });

    try {
      note("---- phoneA's clock jumps an hour forward ----");
      room.phoneA.clock.jump(AN_HOUR);
      room.phoneA.store.commit(setRotate(90));
      let readings = await settleWithin(
        () => room.peers.map((p) => `${p.name}=${rotateOn(p)}`),
        10_000,
      );
      expect(withStory(readings.join(' '), room.peers.map((p) => `${p.name}=90`).join(' '))).toBe(
        room.peers.map((p) => `${p.name}=90`).join(' '),
      );

      note('---- CAM, whose clock is right, makes the next decision ----');
      room.cam.store.commit(setRotate(180));
      readings = await settleWithin(
        () => room.peers.map((p) => `${p.name}=${rotateOn(p)}`),
        10_000,
      );
      expect(withStory(readings.join(' '), room.peers.map((p) => `${p.name}=180`).join(' '))).toBe(
        room.peers.map((p) => `${p.name}=180`).join(' '),
      );

      // The clock tracks the worst clock in the room and no further, and the
      // counter only ever moves inside one millisecond.
      const now = Date.now();
      for (const peer of room.peers) {
        for (const { path, stamp } of peer.sync.stampedLeaves()) {
          expect(
            withStory(
              `${peer.name} ${path} bounded: ${String(stamp.t <= now + AN_HOUR + 10_000)}`,
              `${peer.name} ${path} bounded: true`,
            ),
          ).toBe(`${peer.name} ${path} bounded: true`);
          expect(withStory(`${path} c<100: ${String(stamp.c < 100)}`, `${path} c<100: true`)).toBe(
            `${path} c<100: true`,
          );
        }
      }
    } finally {
      for (const p of room.peers.slice().reverse()) await p.stop();
    }
  }, 120_000);

  for (const step of [-1000, -10_000, -AN_HOUR]) {
    it(`keeps publishing after the device clock steps back ${String(step / 1000)} s`, async () => {
      /*
       * Skeptic 3's T-probe, and the measurement that isolates the mechanism.
       *
       * Both throttles used to compute `elapsed = Date.now() - lastRunAt`.
       * After a backward step that is NEGATIVE, so the immediate branch was
       * skipped and the trailing flush was scheduled `|step|` into the future,
       * where `if (timer !== null) return` swallowed every publish until it
       * fired. Measured: one state frame in the ten seconds after a one-hour
       * step, and the silence scaled linearly with the size of the step. No
       * outage, no error, no status change — a room split in two in silence.
       *
       * A throttle wants a monotonic clock, so it has one; see
       * `src/lib/monotonic.ts`. The count of frames is what proves it, because
       * the failure is silence rather than a wrong value.
       */
      const { broker, framesFrom } = countingBroker();
      seedEarlierSession(broker, 'video');
      const room = await openRoom(broker);

      try {
        const before = framesFrom('phonepeer001');
        note(`---- the phone's clock steps back ${String(step / 1000)} s ----`);
        room.phone.clock.jump(step);
        room.phone.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
        await sleep(1200);
        room.phone.store.commit((s) => ({ ...s, activeModuleId: 'video' }));
        await sleep(8800);

        const published = framesFrom('phonepeer001') - before;
        expect(
          withStory(
            `${String(published > 0)} frames in 10 s, CAM=${moduleOn(room.config)}`,
            'true frames in 10 s, CAM=video',
          ),
        ).toBe('true frames in 10 s, CAM=video');
      } finally {
        await room.stop();
      }
    }, 90_000);
  }

  it('lands a sequential tap made after the phone’s clock steps back an hour', async () => {
    /*
     * Skeptic 3's D2, the damning one: no outage, no contention, no race. CAM
     * taps Stats; the phone — which has SEEN Stats and is looking at it — steps
     * its clock back an hour; 1.2 s later its owner taps Video. Before the fix
     * the phone's state channel was dead for the length of the step, so CAM and
     * the display sat on Stats for thirty seconds while the phone showed Video
     * and both sides believed they were online.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      note('---- CAM taps Stats ----');
      room.config.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      await sleep(HANDSHAKE_MS * 3);
      expect(withStory(moduleOn(room.phone), 'stats')).toBe('stats');

      note("---- the phone's clock steps back an hour ----");
      room.phone.clock.jump(-AN_HOUR);
      await sleep(1200);
      note('---- and 1.2 s later its owner taps Video ----');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'video' }));

      const peers = [room.phone, room.config, room.display];
      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${moduleOn(p)}`),
        12_000,
      );
      const want = 'phone=video CAM=video display=video';
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await room.stop();
    }
  }, 90_000);

  it('lets the phone win the key CAM changed while it was locked, after a −10 s step', async () => {
    /*
     * Skeptic 3's R3: the shipped S2-contended script, but with the skew
     * arriving as a STEP mid-session rather than as a starting offset. The
     * static version is green above; this one failed, because a phone that was
     * correct at start-up has an offset of zero, and during the outage there is
     * nothing inbound to relearn from. The repair is that the stamping BASE is
     * monotone — `stampBase = max(stampBase, Date.now() + roomOffset)` — so a
     * backward step is a no-op for stamping instead of a regression.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openRoom(broker);

    try {
      note('---- the phone taps Clock ----');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      await sleep(HANDSHAKE_MS * 3);
      expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');

      note("---- the phone's clock steps back 10 s ----");
      room.phone.clock.jump(BEHIND_10_S);

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
      const want = 'phone=video CAM=video display=video';
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      await room.stop();
    }
  }, 90_000);

  it('does not let a peer three days fast own every setting in the room', async () => {
    /*
     * Skeptic 3's kill 3, and the honest version of what it costs.
     *
     * `MAX_ROOM_OFFSET_MS` used to be a CLIFF: a sample further than 24 h was
     * IGNORED, so a peer three days fast contributed nothing to anybody's
     * offset. It is a BOUND now — everything over 24 h counts as 24 h — because
     * ignoring the sample only stops everybody else tracking the liar while its
     * own stamps keep riding on every frame.
     *
     * What this pins is the property that matters and that a reader will
     * assume: a CONNECTED room converges on whoever tapped last, whatever any
     * device's clock says. That holds because of the HLC floor rather than
     * because of the bound — once you have absorbed a stamp three days out,
     * your own next write is ordered after it — and it is measured here in both
     * directions, so a change that broke it would be caught. The residue the
     * bound cannot remove is a peer that has heard nothing recently, and that
     * is stated in `docs/remote-control.md` rather than pretended away.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openSkewedRoom(broker, {
      camMs: THREE_DAYS,
      phoneAMs: 0,
      phoneBMs: 0,
    });

    try {
      note('---- CAM, three days fast, taps 90 ----');
      room.cam.store.commit(setRotate(90));
      await sleep(HANDSHAKE_MS * 4);

      note('---- 1.5 s later a phone with a correct clock taps 180 ----');
      await sleep(1500);
      room.phoneA.store.commit(setRotate(180));

      const readings = await settleWithin(
        () => room.peers.map((p) => `${p.name}=${rotateOn(p)}`),
        12_000,
      );
      const want = room.peers.map((p) => `${p.name}=180`).join(' ');
      expect(withStory(readings.join(' '), want)).toBe(want);

      note('---- and the far-future peer is not muted: its own next tap still lands ----');
      room.cam.store.commit(setRotate(270));
      const all = await settleWithin(
        () => room.peers.map((p) => `${p.name}=${rotateOn(p)}`),
        12_000,
      );
      const wantAll = room.peers.map((p) => `${p.name}=270`).join(' ');
      expect(withStory(all.join(' '), wantAll)).toBe(wantAll);

      // And nobody's clock ran away past the worst clock in the room.
      const ceiling = Date.now() + THREE_DAYS + 10 * 60_000;
      for (const peer of room.peers)
        for (const { path, stamp } of peer.sync.stampedLeaves())
          expect(
            withStory(
              `${peer.name} ${path} bounded: ${String(stamp.t <= ceiling)}`,
              `${peer.name} ${path} bounded: true`,
            ),
          ).toBe(`${peer.name} ${path} bounded: true`);
    } finally {
      for (const p of room.peers.slice().reverse()) await p.stop();
    }
  }, 120_000);

  it('still tracks a peer just PAST the offset bound, instead of ignoring it', async () => {
    /*
     * The difference between a cliff and a bound, in one schedule.
     *
     * CAM's clock is three seconds past `MAX_ROOM_OFFSET_MS`. Under the old
     * CLIFF that sample was discarded whole, so the phone's offset stayed at
     * zero and it stamped in its own present — under everything CAM wrote while
     * it was locked. Under the BOUND the phone tracks CAM to within those three
     * seconds, and the 6.5 s outage is longer than the residue, so the tap on
     * unlock lands. Cliff: `stats`. Bound: `video`.
     *
     * The general shape: a bound turns "a badly-wrong peer owns the room" into
     * "a badly-wrong peer wins by however far past the bound it is", which any
     * outage longer than that erases.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const room = await openSkewedRoom(broker, {
      camMs: MAX_ROOM_OFFSET_MS + 3000,
      phoneAMs: 0,
      phoneBMs: 0,
    });

    try {
      note('---- the phone taps Clock, with everyone listening ----');
      room.phoneA.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      await sleep(HANDSHAKE_MS * 3);
      expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');

      note('---- the screen locks ----');
      room.phoneA.mute();
      await sleep(200);
      note('---- CAM, a day and three seconds fast, picks Stats ----');
      room.cam.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      await sleep(6500);
      expect(withStory(moduleOn(room.display), 'stats')).toBe('stats');

      note('---- the phone is unlocked and its owner picks Video at once ----');
      room.phoneA.unmute();
      room.phoneA.store.commit((s) => ({ ...s, activeModuleId: 'video' }));

      const readings = await settleWithin(
        () => room.peers.map((p) => `${p.name}=${moduleOn(p)}`),
        12_000,
      );
      const want = room.peers.map((p) => `${p.name}=video`).join(' ');
      expect(withStory(readings.join(' '), want)).toBe(want);
    } finally {
      for (const p of room.peers.slice().reverse()) await p.stop();
    }
  }, 120_000);

  it('keeps a reloaded phone winning while its clock is still 90 s behind', async () => {
    /*
     * The offset is persisted in the clock slot for the same reason the stamps
     * are: a page that reloads during an outage has heard nothing since, and
     * without the stored offset the hole reopens on exactly the device that
     * already knew better.
     */
    const broker = createBroker();
    seedEarlierSession(broker, 'video');
    const display = await startDisplayPeer(broker);
    const cam = await startConfigPeer(broker, HANDSHAKE_MS, 0);
    let phone = await startPhonePeer(broker, {
      name: 'phone',
      id: 'phonepeer001',
      offsetMs: BEHIND_90_S,
    });
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('---- the 90-s-behind phone sets rotate=90 ----');
      phone.store.commit(setRotate(90));
      await sleep(HANDSHAKE_MS * 3);
      expect(withStory(rotateOn(display), '90')).toBe('90');

      note('---- the phone reloads: new client id, same slot, still 90 s behind ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, {
        name: 'phone2',
        id: 'phonepeer002',
        device: 'phone',
        offsetMs: BEHIND_90_S,
        initial: inherited,
      });
      phone.store.commit(setRotate(180));

      const peers = [phone, cam, display];
      const readings = await settleWithin(
        () => peers.map((p) => `${p.name}=${rotateOn(p)}`),
        10_000,
      );
      expect(withStory(readings.join(' '), 'phone2=180 CAM=180 display=180')).toBe(
        'phone2=180 CAM=180 display=180',
      );
    } finally {
      await phone.stop();
      await cam.stop();
      await display.stop();
    }
  }, 90_000);
});
