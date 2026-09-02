/**
 * How long a passive display waits to learn a sequential edit, once the sender
 * is at the 8 kB cap.
 *
 * The trim ladder's last rung rotates a slice of the stamp map through each
 * frame, and the argument for it was that "every stamped leaf carries its stamp
 * within at most `n` frames for `n` stamps — in practice one or two, since the
 * budget only bites on a snapshot near the 8 kB cap". Both halves were wrong in
 * the same direction. Measured on a config peer with a full look and 300 tuned
 * knobs, the rung fires on 96-101 % of frames, and 336 leaves at 29 stamps to a
 * frame is a full turn of the window every twelve seconds.
 *
 * Twelve seconds is not a wobble, because of what a DISPLAY is: it applies
 * state and never publishes it, so there is no ping-pong to make the writer emit
 * faster than its ~2 s persist tick. The just-made tap rode on one frame in
 * seven, and until one of those arrived the display kept its own older stamp
 * and showed the old value — no race, no reorder, no clock skew, one writer.
 *
 * The repair reserves the newest few stamps on EVERY frame
 * (`RESERVED_NEWEST_STAMPS`) and rotates the remaining budget over the rest, so
 * the leaf somebody just touched is orderable from the next frame while a leaf
 * buried under newer edits still climbs back.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

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
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

const setRotate =
  (deg: AppState['render']['rotate']) =>
  (s: AppState): AppState => ({ ...s, render: { ...s.render, rotate: deg } });

/**
 * The eight-layer look the ladder may never truncate, so every frame is close
 * to the cap before a single knob is tuned. This is the shape the measured
 * numbers came from: a full look plus tuned settings, not a bare document.
 */
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

/** How long, from now, until this peer reads `want`. `Infinity` if it never does. */
async function msUntil(peer: Peer, want: string, deadlineMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (rotateOn(peer) === want) return Date.now() - started;
    await sleep(20);
  }
  return Infinity;
}

describe('a sender at the wire cap, and the display waiting on it', () => {
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

  it('DECISIVE-300: a display that rejoins learns the last tap within two seconds', async () => {
    /*
     * Skeptic 4's decisive schedule, deterministic before the repair (5/5 runs,
     * 10.18 / 10.23 / 10.24 / 10.24 / 12.20 s):
     *
     *  1. the phone taps 90; the room agrees, so the DISPLAY now holds a real,
     *     non-EPOCH stamp for that leaf;
     *  2. the display and the phone both drop off; CAM is alone;
     *  3. CAM tunes 300 knobs on the active module, putting every frame it will
     *     ever send at the cap, and then taps 270 — a plain sequential edit;
     *  4. the room goes quiet: nobody taps anything again;
     *  5. the display comes back.
     *
     * The retained bootstrap and the six frames after it carried `rotate=270`
     * BARE. Bare reads as EPOCH, and EPOCH loses to the real stamp the display
     * was still holding for 90.
     */
    const broker = createBroker();
    const room = await openRoom(broker);

    try {
      note('---- CAM arranges an eight-layer look ----');
      room.config.store.commit(fatLook);
      await sleep(HANDSHAKE_MS * 2);

      note('---- the phone taps 90 and the room agrees ----');
      room.phone.store.commit(setRotate(90));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(rotateOn(room.display), '90')).toBe('90');

      note('---- the display and the phone drop off; CAM is alone ----');
      room.display.mute();
      room.phone.mute();
      await sleep(300);

      note('---- CAM tunes 300 knobs, then taps 270 ----');
      room.config.store.commit(tuneKnobs(300));
      await sleep(1200);
      room.config.store.commit(setRotate(270));
      await sleep(1200);

      note('---- the room goes quiet ----');
      await sleep(1500);

      note('---- the display comes back ----');
      room.display.unmute();
      const learned = await msUntil(room.display, '270', 15_000);
      note(`display learned 270 after ${String(learned)} ms`);
      expect(
        withStory(
          `display learned 270 within 2 s: ${String(learned <= 2000)}`,
          'display learned 270 within 2 s: true',
        ),
      ).toBe('display learned 270 within 2 s: true');
    } finally {
      await room.stop();
    }
  }, 120_000);

  it('QUIET-ROOM: a phone that rejoins learns it too', async () => {
    /*
     * The same failure with the PHONE as the returning peer — non-deterministic
     * before the repair, 2 runs in 5 still reading `CAM=270 phone=90` at the
     * 10 s deadline, with nine consecutive CAM frames over twelve seconds and
     * `rotate` never stamped once.
     */
    const broker = createBroker();
    const room = await openRoom(broker);

    try {
      room.config.store.commit(fatLook);
      await sleep(HANDSHAKE_MS * 2);
      room.phone.store.commit(setRotate(90));
      await sleep(HANDSHAKE_MS * 4);
      expect(withStory(rotateOn(room.phone), '90')).toBe('90');

      note('---- the phone drops off ----');
      room.phone.mute();
      await sleep(300);

      note('---- CAM tunes 300 knobs, then taps 270 ----');
      room.config.store.commit(tuneKnobs(300));
      await sleep(1200);
      room.config.store.commit(setRotate(270));
      await sleep(2500);

      note('---- the phone comes back ----');
      room.phone.unmute();
      const learned = await msUntil(room.phone, '270', 15_000);
      expect(learned).toBeLessThanOrEqual(2000);
    } finally {
      await room.stop();
    }
  }, 120_000);

  for (const knobs of [150, 300, 400]) {
    it(`UNSHIPPED-FIRST: learns a tap made BEFORE ${String(knobs)} knobs`, async () => {
      /*
       * The same script with its two acts SWAPPED — tap first, then tune the
       * module's settings, which is the order a person actually works in.
       *
       * `RESERVED_NEWEST_STAMPS` is a RECENCY window, so the original order
       * flattered it: the tapped leaf was the newest stamp by construction and
       * rode every frame for free. Tap first and one ordinary multi-leaf commit
       * issues a stamp per leaf, all of them newer, and the tap is out of the
       * newest eight before the next frame goes out. Measured before the
       * repair, deterministically: 150 knobs converged, 300 knobs left the
       * returning display showing the old value for 20.2 s, 400 knobs for
       * 96.2 s — a plain sequential edit, one writer, no race and no skew.
       */
      const broker = createBroker();
      const room = await openRoom(broker);

      try {
        room.config.store.commit(fatLook);
        await sleep(HANDSHAKE_MS * 2);
        room.phone.store.commit(setRotate(90));
        await sleep(HANDSHAKE_MS * 4);
        expect(withStory(rotateOn(room.display), '90')).toBe('90');

        note('---- the display and the phone drop off; CAM is alone ----');
        room.display.mute();
        room.phone.mute();
        await sleep(300);

        note('---- CAM taps 270 FIRST ----');
        room.config.store.commit(setRotate(270));
        await sleep(1200);
        note(`---- then tunes ${String(knobs)} knobs ----`);
        room.config.store.commit(tuneKnobs(knobs));
        await sleep(1200);

        note('---- the room goes quiet ----');
        await sleep(1500);

        note('---- the display comes back ----');
        room.display.unmute();
        const learned = await msUntil(room.display, '270', 15_000);
        note(`display learned 270 after ${String(learned)} ms`);
        expect(
          withStory(
            `${String(knobs)} knobs, tap first: ${String(learned <= 2000)}`,
            `${String(knobs)} knobs, tap first: true`,
          ),
        ).toBe(`${String(knobs)} knobs, tap first: true`);
      } finally {
        await room.stop();
      }
    }, 180_000);
  }

  for (const knobs of [150, 200, 250, 300]) {
    it(`learns the sequential edit in under a second with ${String(knobs)} knobs`, async () => {
      /*
       * The scaling law, re-measured. Before the repair, time for the display
       * to see the edit: 150 knobs → 26 ms (the spec's own ceiling, safe), 200
       * → 176 ms, 250 → 4199 ms, 300 → 10.2-12.2 s. The cliff sat just above
       * the documented ceiling, which is why nothing shipped ever saw it.
       */
      const broker = createBroker();
      const room = await openRoom(broker);

      try {
        room.config.store.commit(fatLook);
        await sleep(HANDSHAKE_MS * 2);
        room.phone.store.commit(setRotate(90));
        await sleep(HANDSHAKE_MS * 4);
        room.display.mute();
        await sleep(300);
        room.config.store.commit(tuneKnobs(knobs));
        await sleep(1200);
        room.config.store.commit(setRotate(270));
        await sleep(1500);
        room.display.unmute();
        const learned = await msUntil(room.display, '270', 15_000);
        expect(
          withStory(
            `${String(knobs)} knobs: ${String(learned < 1000)}`,
            `${String(knobs)} knobs: true`,
          ),
        ).toBe(`${String(knobs)} knobs: true`);
      } finally {
        await room.stop();
      }
    }, 120_000);
  }
});
