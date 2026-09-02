/**
 * The `cmd` and `tele` channels under a wrong clock — the half of the layer the
 * room-clock work never reached.
 *
 * Everything about `state` was made skew-proof: a room offset, an HLC floor, a
 * monotone stamping base, an intent layer, and four suites that measure them.
 * `cmd` and `tele` were left on raw wall clocks, and `cmd` carries EVERYTHING
 * that is not a setting — play, pause, toggle, seekTo, seekBy, previewSeek,
 * setRate, setLoop, clearLoop, next, prev, setModule, reinit, reload,
 * requestState, requestDiag, requestLibrary, setPinned, renameMedia,
 * deleteMedia. In a display-only room the display is the only peer that answers
 * any of them.
 *
 * Two defects, both silent, both measured here before they were fixed:
 *
 *  - **the age gate subtracted two raw wall clocks** (`Date.now() - env.ts >
 *    CMD_MAX_AGE_MS`), so a phone more than fifteen seconds BEHIND had every
 *    command it ever sent dropped on arrival. A clean cliff at exactly 15 s and
 *    one-directional — ahead was harmless, because the subtraction is signed.
 *    `sendCmd` returns void and the status line reads online, so `useSync`'s
 *    cold library pull retried forever into the void and the shelf stayed blank
 *    for the life of the device, across every reload. −90 s is not exotic: it is
 *    the canonical phone in `displayOnlyClock.dom.test.ts`.
 *  - **the send-side throttles were `Date.now() - lastAt`**, seeded `0`. One
 *    backward NTP step put `lastAt` an hour in the future, so every subsequent
 *    command — and every telemetry packet — returned early for the length of
 *    the step. In a display-only room the display's telemetry is the phone's
 *    ONLY inbound frame, hence its only source of `heard` and of the room
 *    offset, so an hour of silence there takes the phone's clock with it.
 *
 * The first repair was one number on both ends: `appSync`'s `roomNow()` writes
 * the envelope `ts` and answered the age gate, and both throttles moved onto
 * `monotonicNow()` exactly as `publishState`'s already had.
 *
 * ## Round 7: room time was not enough, and could not have been
 *
 * Two peers' room times agree only when the sender has folded at least one frame
 * AND its skew fits `MAX_ROOM_OFFSET_MS`. `noteRoomTime` CLAMPS at 24 h, so a
 * phone 25 h behind keeps a residual hour of error by design — and the gate,
 * still a subtraction across two devices, still killed every command it sent.
 * The cliff had not closed; it had moved from 15 s to 24 h, exactly on
 * `MAX_ROOM_OFFSET_MS` and still one-directional, and the sampling in this file
 * (0 / ±14 s / ±16 s / ±90 s) could not see it. Three shipped losses fell out of
 * that, all measured below before the repair:
 *
 *  - a phone more than 24 h behind is deaf FOREVER — reload does not help, an
 *    outage does not help, correcting nothing in the room helps;
 *  - a phone with a PERFECT clock goes deaf for its first command after a peer
 *    three days fast has joined, written and LEFT, because the poison is in this
 *    receiver's persisted `roomOffset`;
 *  - any phone that taps before its first inbound frame loses that command at
 *    −16 s or worse, because `cmd` has no equivalent of the state channel's
 *    intent layer.
 *
 * The repair is to stop comparing two devices at all: the gate is now
 * self-referential per sender (`lastCmdTsBySrc`), so it measures one device's
 * clock against itself and no skew of any magnitude can reach it. The last test
 * here pins what it still refuses — a peer re-sending a command out of its own
 * past.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { encodeEnvelope } from './envelope';
import {
  HANDSHAKE_MS,
  HOLD_MS,
  createBroker,
  installDeviceClocks,
  note,
  resetClockSlots,
  resetTrace,
  restoreDeviceClocks,
  sleep,
  startDisplayPeer,
  startPhonePeer,
  withAmbient,
  withStory,
  type Peer,
} from './roomHarness';
import { PROTOCOL_VERSION, type Envelope, type CmdBody } from './types';

const AN_HOUR = 3_600_000;
const A_DAY = 24 * AN_HOUR;

/** Every command the display heard, so a drop is a number rather than a mood. */
function countCmds(display: Peer): () => number {
  let heard = 0;
  display.sync.service.onCmd(() => {
    heard += 1;
  });
  return () => heard;
}

/** A tap made by the PHONE, on the phone's own clock. */
function tap(phone: Peer, op: 'play' | 'pause' | 'requestLibrary'): void {
  withAmbient(phone.clock.offset(), () => {
    note(`phone sends ${op}`);
    phone.sync.service.sendCmd(op);
  });
}

describe('the control channel on a device whose clock is wrong', () => {
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

  for (const behind of [
    0,
    90_000,
    -14_000,
    -16_000,
    -90_000,
    // Round 7: past the 24 h clamp, in both directions. `−24 h 20 s` is the
    // first reading on the far side of the boundary; `−25 h` and `−3 d` are the
    // skeptics' figures; `+3 d` is the control that says the cliff was signed.
    -(24 * AN_HOUR + 20_000),
    -25 * AN_HOUR,
    -3 * A_DAY,
    3 * A_DAY,
  ]) {
    it(`delivers all three commands from a phone ${String(behind / 1000)} s off`, async () => {
      /*
       * Skeptic 1's P1 verbatim. Readings before the repair:
       *
       *     0 s -> 3    +90 s -> 3    −14 s -> 3    −16 s -> 0    −90 s -> 0
       *
       * The cliff is exactly `CMD_MAX_AGE_MS`, which is what says the mechanism
       * is the two-wall-clock subtraction rather than anything about the room.
       */
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      const phone = await startPhonePeer(broker, { offsetMs: behind });
      const heard = countCmds(display);

      try {
        // Settled: the phone has folded the display's telemetry, so it knows
        // what time the room thinks it is before it says anything.
        await sleep(HANDSHAKE_MS * 3);

        tap(phone, 'play');
        await sleep(400);
        tap(phone, 'pause');
        await sleep(400);
        tap(phone, 'requestLibrary');
        await sleep(2000);

        expect(withStory(`heard=${String(heard())}`, 'heard=3')).toBe('heard=3');
      } finally {
        await phone.stop();
        await display.stop();
      }
    }, 60_000);
  }

  for (const behind of [0, -14_000, -16_000, -90_000, -25 * AN_HOUR]) {
    it(`hears the tap a phone ${String(behind / 1000)} s off makes BEFORE its first frame`, async () => {
      /*
       * Skeptic 2's Defect 2. Readings before the repair:
       *
       *     0 s -> 1    −14 s -> 1    −16 s -> 0    −90 s -> 0    −25 h -> 0
       *
       * A cliff at exactly `CMD_MAX_AGE_MS` again, because a phone that has
       * folded nothing has an offset of zero and stamps in its own skewed past.
       * The `state` channel covers this with the intent layer (`appSync`'s
       * `intents`); `cmd` has no such thing and cannot have one — a command is
       * not a value that can be re-stamped later, it is an act with a moment.
       * So the gate has to survive it instead.
       *
       * The tap is issued SYNCHRONOUSLY after `startPhonePeer` — unlock, tap —
       * with the retained bootstrap held back 1.2 s, which is what makes "before
       * the first inbound frame" a fact rather than a hope. The 0 s and −14 s
       * rows are the controls that say the mechanism is the gate and not an
       * unconnected transport.
       */
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      const phone = await startPhonePeer(broker, { offsetMs: behind, handshakeMs: 1200 });
      const heard = countCmds(display);

      try {
        tap(phone, 'requestLibrary');
        await sleep(3000);
        expect(withStory(`heard=${String(heard())}`, 'heard=1')).toBe('heard=1');
      } finally {
        await phone.stop();
        await display.stop();
      }
    }, 60_000);
  }

  it('hears a correct-clock phone that joins after a three-day liar has left', async () => {
    /*
     * Skeptic 1's B2, and the case that says the defect does not need a wrong
     * clock on the affected device at all.
     *
     * A phone three days fast joins, writes, and LEAVES. Its `ts` samples are
     * folded into the DISPLAY's `roomOffset`, which saturates at the 24 h clamp
     * and is persisted there. A brand-new phone with a perfect clock then
     * unlocks — `handshakeMs: 4000`, so it is tapping before its own first frame,
     * the shipped window — and taps play, then pause.
     *
     * Readings before the repair: `liar=3d heard=1` against a control run with
     * an honest visitor at `liar=0d heard=2`. The `play` was swallowed by a
     * device that had done nothing wrong, and only the departed peer's residue
     * in this receiver could explain it.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const liar = await startPhonePeer(broker, {
      id: 'liarpeer0001',
      name: 'liar',
      device: 'liar',
      offsetMs: 3 * A_DAY,
    });
    try {
      await sleep(HANDSHAKE_MS * 3);
      withAmbient(liar.clock.offset(), () => {
        note('liar taps module=clock');
        liar.store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      });
      await sleep(600);
    } finally {
      await liar.stop();
    }

    const phone = await startPhonePeer(broker, {
      id: 'goodphone001',
      name: 'good',
      device: 'good',
      handshakeMs: 4000,
    });
    const heard = countCmds(display);
    try {
      tap(phone, 'play');
      await sleep(400);
      tap(phone, 'pause');
      await sleep(2500);
      expect(withStory(`heard=${String(heard())}`, 'heard=2')).toBe('heard=2');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);

  it('still hears a phone 25 h behind after it reloads', async () => {
    /*
     * Skeptic 2's recovery probe E: `heard=[] 0 of 2`. A reload changes nothing,
     * because what is wrong is the device's clock and the room does not correct
     * it — the new page load boots from the same slot, re-settles, and is deaf
     * again. That is what "permanent" meant.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    let phone = await startPhonePeer(broker, { offsetMs: -25 * AN_HOUR, device: 'ph' });
    try {
      await sleep(HANDSHAKE_MS * 3);
      note('---- the phone reloads ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, {
        offsetMs: -25 * AN_HOUR,
        device: 'ph',
        initial: inherited,
      });
      const heard = countCmds(display);
      await sleep(HANDSHAKE_MS * 3);

      tap(phone, 'play');
      await sleep(400);
      tap(phone, 'pause');
      await sleep(2000);
      expect(withStory(`heard=${String(heard())}`, 'heard=2')).toBe('heard=2');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);

  it('still hears a phone 25 h behind after its radio drops and comes back', async () => {
    /*
     * Skeptic 2's recovery probe F: `heard=[] 0 of 1`. A lock screen, a lift, a
     * tunnel — the outage every other suite in this directory is about — and the
     * retained replay on the way back taught the phone nothing that could help,
     * because the clamp was already saturated.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const phone = await startPhonePeer(broker, { offsetMs: -25 * AN_HOUR });
    const heard = countCmds(display);
    try {
      await sleep(HANDSHAKE_MS * 3);
      note('---- the phone loses its radio ----');
      phone.mute();
      await sleep(HOLD_MS / 2);
      phone.unmute();
      await sleep(HANDSHAKE_MS * 2);

      tap(phone, 'play');
      await sleep(2000);
      expect(withStory(`heard=${String(heard())}`, 'heard=1')).toBe('heard=1');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);

  it('still refuses a command a peer re-sends out of its OWN past', async () => {
    /*
     * The gate's remaining job, pinned so the round-7 widening cannot quietly
     * become "accept everything".
     *
     * One `src`, two envelopes, hand-built so the only difference that matters is
     * the `ts`: the first at room time, the second twenty seconds behind the
     * first — further back than `CMD_MAX_AGE_MS` — with a fresh `seq`, so
     * `(src, seq)` dedup has nothing to say about it. `seekBy` is the reason the
     * rule exists: replaying it twice is a bug, not a no-op.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const ops: string[] = [];
    display.sync.service.onCmd((body) => {
      ops.push(body.op);
    });

    try {
      await sleep(HANDSHAKE_MS * 2);
      const at = Date.now();
      const send = (seq: number, ts: number, arg: number): void => {
        const env: Envelope<CmdBody> = {
          v: PROTOCOL_VERSION,
          ch: 'cmd',
          ts,
          src: 'ghostpeer001',
          role: 'remote',
          seq,
          body: { op: 'seekBy', arg },
        };
        broker.publish('cmd', encodeEnvelope(env));
      };

      send(1, at, 10);
      await sleep(600);
      send(2, at - 20_000, 10);
      await sleep(1200);

      expect(withStory(`heard=${String(ops.length)}`, 'heard=1')).toBe('heard=1');
    } finally {
      await display.stop();
    }
  }, 60_000);

  it('keeps taking commands after the phone corrects its clock by an hour', async () => {
    /*
     * Skeptic 1's P2. Reading before the repair: `before=1 after=1` — one play
     * landed, the clock stepped back one ordinary NTP hour, and the next four
     * taps produced nothing at all for the length of the step. Two independent
     * causes stacked and either alone was fatal: `sendCmd`'s throttle held a
     * reading an hour in the future, and the receive-side gate compared two raw
     * wall clocks.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const phone = await startPhonePeer(broker);
    const heard = countCmds(display);

    try {
      await sleep(HANDSHAKE_MS * 3);
      tap(phone, 'play');
      await sleep(800);
      const before = heard();

      note("---- the phone's clock steps back one hour ----");
      phone.clock.jump(-AN_HOUR);

      for (let i = 0; i < 4; i += 1) {
        tap(phone, 'play');
        await sleep(400);
      }
      await sleep(1500);

      expect(
        withStory(`before=${String(before)} after=${String(heard())}`, 'before=1 after=5'),
      ).toBe('before=1 after=5');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);

  it('keeps telemetry flowing after the DISPLAY steps its clock back an hour', async () => {
    /*
     * The sibling skeptic 1 could not isolate, and the reason it could not:
     * `installDeviceClocks` captures the ambient offset when an interval is
     * CREATED, so a jump never reached the beats `startDisplayPeer` had already
     * scheduled. The harness now reads the device clock at fire time, which is
     * what a real device does, and the case becomes measurable.
     *
     * It matters because of what telemetry IS to a phone alone with a display:
     * the only inbound frame it will ever see, so the only evidence of room
     * time and the only thing that ever sets `heard`. Before the repair
     * `lastTeleAt` held a reading an hour in the future and the display went
     * silent for the whole hour.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const phone = await startPhonePeer(broker);
    let packets = 0;
    phone.sync.service.onTele(() => {
      packets += 1;
    });

    try {
      await sleep(HANDSHAKE_MS * 2);
      const before = packets;
      expect(before).toBeGreaterThan(0);

      note("---- the display's clock steps back one hour ----");
      display.clock.jump(-AN_HOUR);
      await sleep(1500);

      const after = packets - before;
      expect(withStory(`kept flowing: ${String(after > 0)}`, 'kept flowing: true')).toBe(
        'kept flowing: true',
      );
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);
});
