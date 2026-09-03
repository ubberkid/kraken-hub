/**
 * The stamp of a write made while the radio was OFF, on the first frame back.
 *
 * Round 8 gave the wire an unshipped head — the stamps the room has not heard
 * ride ahead of everything else — and ordered that head by stamp RECENCY, which
 * is the same mistake `RESERVED_NEWEST_STAMPS` made one round earlier, one level
 * down. Recency answers "what did somebody just touch?"; the question a
 * reconnecting phone asks is "which of my writes has been waiting longest to
 * travel?", and those are opposite ends of the same list.
 *
 * An ONLINE peer never noticed, because its head drains a few stamps per frame
 * as they ship. A peer that is offline while writing has nothing draining, so
 * when the radio returns the head is the whole write set — and an offline tap
 * made BEFORE a multi-leaf config commit sits at the very back of it.
 *
 * Measured before the repair, deterministically, on the shipped eight-layer
 * look: the phone taps 90 offline, tunes 400 knobs, and comes back for six
 * seconds. Twenty-nine state frames leave it in that window and NOT ONE carries
 * `render.rotate`'s stamp. Every one carries the value BARE, which reads as
 * EPOCH and loses to the room's stamped 270 — so the tap is reverted on the
 * Kraken and on CAM, permanently, with `lastError` null and the status line
 * reading online. That is the settings-revert bug report verbatim, on a build
 * that had already been sealed against it twice.
 *
 * The same mechanism as prolonged non-convergence, with the phone tapping LAST
 * so it must win the merge: 150 knobs 0.66 s, 300 knobs 1.50 s, 350 knobs
 * 3.94 s, 400 knobs 10.4 s, 450 knobs 13.3 s, 470 knobs 32.0 s. Above 500 the
 * frame is refused whole and the transport re-asserts the PRE-tune frame, which
 * did carry the stamp, so the room converges in ~100 ms — the failure peaks
 * exactly where the frame still fits but the stamp does not.
 *
 * The repair is `appSync`'s `unshippedSeq`: a monotonic counter recorded when a
 * path enters the unshipped set, so `wireStamps` hands the head over oldest-wait
 * first and `fitStateEnvelope` reserves BOTH ends of it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { decodeEnvelope } from './envelope';
import {
  HANDSHAKE_MS,
  createBroker,
  installDeviceClocks,
  note,
  openRoom,
  resetClockSlots,
  resetTrace,
  restoreDeviceClocks,
  rotateOn,
  sleep,
  withStory,
  type Broker,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

const setRotate =
  (deg: AppState['render']['rotate']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

/** The eight-layer look the trim ladder may never truncate. */
const fatLook = (s: AppState): AppState => ({
  ...s,
  look: {
    layers: [
      { ...s.look.layers[0]!, kind: 'video' },
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `layer${String(i).padStart(3, '0')}`,
        kind: 'effect' as const,
        on: true,
        name: 'A layer name of the max',
        frame: { w: 1.25, h: 0.75, shape: 'square' as const },
        t: { x: 0.321, y: -0.654, s: 1.875, r: 137, a: 0.625 },
        locked: true,
        v: 3,
        cfg: {
          preset: 'aurora',
          speed: 0.875,
          intensity: 0.625,
          palette: ['#112233', '#445566', '#778899', '#aabbcc'],
          blend: 'screen',
          seed: 987_654,
        },
      })),
    ],
  },
});

/** Tune `count` knobs on the ACTIVE module — the leaves `trim` may never drop. */
const tuneKnobs =
  (count: number) =>
  (s: AppState): AppState => {
    const cfg: Record<string, unknown> = { ...(s.modules['video']?.cfg ?? {}) };
    for (let i = 0; i < count; i += 1) cfg[`k${String(i).padStart(3, '0')}`] = i;
    return { ...s, modules: { ...s.modules, video: { v: 1, cfg } } };
  };

interface FrameNote {
  seq: number;
  rotateStamped: boolean;
  nStamps: number;
}

/** Every `state` frame a given peer puts on the wire, and what it carried. */
function watchFrames(broker: Broker, src: string): FrameNote[] {
  const seen: FrameNote[] = [];
  broker.subs.add({
    ch: 'state',
    cb: (frame) => {
      const env = decodeEnvelope(frame);
      if (env?.src !== src) return;
      const stamps = env.stamps ?? {};
      seen.push({
        seq: env.seq,
        rotateStamped: 'render.rotate' in stamps,
        nStamps: Object.keys(stamps).length,
      });
    },
  });
  return seen;
}

/** How long, from now, until this peer reads `want`. `Infinity` if it never does. */
async function msUntil(peer: Peer, want: string, deadlineMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (rotateOn(peer) === want) return Date.now() - started;
    await sleep(20);
  }
  return Infinity;
}

describe('a phone that wrote while its radio was off', () => {
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

  for (const knobs of [400, 470]) {
    it(`TRACE A: lands an offline tap made before ${String(knobs)} knobs, in a 6 s window`, async () => {
      /*
       * Lens 1/4's schedule verbatim. The phone is locked for the whole of its
       * own editing, comes back for six seconds — a glance at a notification —
       * and locks again. Everything it has to say has to fit in that window.
       */
      const broker = createBroker();
      const room = await openRoom(broker);
      const frames = watchFrames(broker, 'phonepeer001');

      try {
        note('---- CAM arranges an eight-layer look and taps 270 ----');
        room.config.store.commit(fatLook);
        await sleep(HANDSHAKE_MS * 2);
        room.config.store.commit(setRotate(270));
        await sleep(HANDSHAKE_MS * 4);
        expect(withStory(rotateOn(room.phone), '270')).toBe('270');
        expect(withStory(rotateOn(room.display), '270')).toBe('270');

        note('---- the phone locks ----');
        room.phone.mute();
        await sleep(300);

        note('---- offline: the user taps 90, THEN tunes the video module ----');
        room.phone.store.commit(setRotate(90));
        await sleep(400);
        room.phone.store.commit(tuneKnobs(knobs));
        await sleep(400);

        note('---- the phone is unlocked for six seconds, then locked again ----');
        frames.length = 0;
        room.phone.unmute();
        await sleep(6000);
        room.phone.mute();

        note('---- and the room is watched for a further 15 s ----');
        await sleep(15_000);

        const carried = frames.filter((f) => f.rotateStamped).length;
        note(
          `phone frames=${String(frames.length)} withRotateStamp=${String(carried)} ` +
            `first=${JSON.stringify(frames[0])}`,
        );
        /*
         * The stamp on the FIRST frame back, not merely within the window: a
         * convergence assertion alone passes on a build where the tap only
         * arrives late, and "late" is unbounded here by construction.
         */
        expect(
          withStory(
            `first frame back carried render.rotate: ${String(frames[0]?.rotateStamped === true)}`,
            'first frame back carried render.rotate: true',
          ),
        ).toBe('first frame back carried render.rotate: true');

        const peers = [room.display, room.config, room.phone];
        const want = peers.map((p) => `${p.name}=90`).join(' ');
        expect(withStory(peers.map((p) => `${p.name}=${rotateOn(p)}`).join(' '), want)).toBe(want);
      } finally {
        await room.stop();
      }
    }, 180_000);
  }

  for (const knobs of [150, 300, 350, 400, 450, 470]) {
    it(`TRACE B: converges within 2 s with ${String(knobs)} knobs tuned offline`, async () => {
      /*
       * The same mechanism read as convergence TIME. The phone taps last, so it
       * must win the merge on any build; what the broken order costs is how long
       * the room spends holding a value nobody chose. Before the repair: 0.66 s
       * at 150 knobs, 1.50 s at 300, 3.94 s at 350, 10.4 s at 400, 13.3 s at
       * 450, 32.0 s at 470.
       */
      const broker = createBroker();
      const room = await openRoom(broker);

      try {
        room.config.store.commit(fatLook);
        await sleep(HANDSHAKE_MS * 2);
        room.config.store.commit(setRotate(270));
        await sleep(HANDSHAKE_MS * 4);
        expect(withStory(rotateOn(room.phone), '270')).toBe('270');

        note('---- the phone locks, taps 90, and tunes the module ----');
        room.phone.mute();
        await sleep(300);
        room.phone.store.commit(setRotate(90));
        await sleep(400);
        room.phone.store.commit(tuneKnobs(knobs));
        await sleep(400);

        note('---- everybody returns to a quiet room ----');
        room.phone.unmute();
        const learned = await msUntil(room.config, '90', 40_000);
        note(`CAM learned 90 after ${String(learned)} ms`);
        expect(
          withStory(
            `${String(knobs)} knobs: ${String(learned <= 2000)}`,
            `${String(knobs)} knobs: true`,
          ),
        ).toBe(`${String(knobs)} knobs: true`);
      } finally {
        await room.stop();
      }
    }, 180_000);
  }
});
