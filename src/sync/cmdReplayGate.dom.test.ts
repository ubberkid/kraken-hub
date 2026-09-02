/**
 * The `cmd` channel against a broker that hands out old messages.
 *
 * Round 7 made the staleness gate self-referential — a sender's `ts` compared
 * only to the newest `ts` that same sender delivered — which closed every skew
 * cliff and opened one word wide: FIRST. A `src` with no history here was
 * accepted unconditionally, at any age.
 *
 * That is not a corner. `clientId()` is minted fresh on every page load and
 * deliberately not persisted, so a display that reboots — or whose `EventSource`
 * is torn down and rebuilt after `NTFY_LIVENESS_MS` — meets every peer in the
 * room as a stranger, and every command still sitting in a broker's replay cache
 * is a first sighting. `meta.retained` was never consulted on this path either,
 * though `CmdOp` has always said a command is NEVER retained.
 *
 * Measured on a cold display, one hand-built `seekBy(+10)` per row, `src` nobody
 * has heard from, fresh `seq` so `(src, seq)` dedup has nothing to say:
 *
 *     20 s old      -> executed   FAIL
 *     6 h old       -> executed   FAIL
 *     3 days old    -> executed   FAIL
 *
 * `seekBy` is the exact op `CmdOp` names as the hazard — "replaying `seekBy(+10)`
 * twice is a bug, not a no-op" — and `deleteMedia`, `renameMedia` and `setPinned`
 * ride the same channel.
 *
 * The safety argument at the time was prose: "no shipped transport replays `cmd`
 * at all". Nothing asserted it, the capability model contradicted it
 * (`TransportCaps.replayMs` was transport-WIDE and ntfy declared 600 000 ms), and
 * `NtfyTransport`'s own comment still promised a defence round 7 had removed.
 *
 * The repair is three gates and one honest capability — see `CMD_MAX_AGE_MS`,
 * `FrameMeta.ts` and `TransportCaps.cmdReplayMs`. The gate that closes this file
 * is BROKER time against BROKER time: one server's clock against itself, which a
 * receiver with no history of the sender can still read.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { encodeEnvelope } from './envelope';
import {
  HANDSHAKE_MS,
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
  type Broker,
  type Peer,
} from './roomHarness';
import { PROTOCOL_VERSION, type CmdBody, type Envelope } from './types';

const AN_HOUR = 3_600_000;
const A_DAY = 24 * AN_HOUR;

/**
 * One `seekBy(+10)`, from a peer this display has never heard from, delivered as
 * a message the broker accepted `ageMs` ago.
 *
 * `ts` and the broker stamp move together, because that is what a replay IS: the
 * sender wrote it then, the server accepted it then, and the cache is handing
 * over the same message now.
 */
function replayCachedSeek(
  broker: Broker,
  o: { seq: number; ageMs: number; src?: string; retained?: boolean },
): void {
  const at = Date.now() - o.ageMs;
  const env: Envelope<CmdBody> = {
    v: PROTOCOL_VERSION,
    ch: 'cmd',
    ts: at,
    src: o.src ?? 'ghostpeer001',
    role: 'remote',
    seq: o.seq,
    body: { op: 'seekBy', arg: 10 },
  };
  note(
    `broker hands over a ${String(Math.round(o.ageMs / 1000))} s old seekBy from ${env.src}` +
      (o.retained === true ? ' (flagged retained)' : ''),
  );
  broker.publish('cmd', encodeEnvelope(env), {
    ts: at,
    ...(o.retained === undefined ? {} : { retained: o.retained }),
  });
}

/** Every command the display executed, so a drop is a number rather than a mood. */
function countCmds(display: Peer): () => number {
  let heard = 0;
  display.sync.service.onCmd(() => {
    heard += 1;
  });
  return () => heard;
}

describe('a command out of a broker replay cache', () => {
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

  for (const ageMs of [20_000, 6 * AN_HOUR, 3 * A_DAY]) {
    it(`ATTACK A: refuses a ${String(Math.round(ageMs / 1000))} s old cmd from an unseen src`, async () => {
      /*
       * The display has been up long enough to have a reading of the broker's
       * clock — its own telemetry echoes back on `tele` every 120 ms, which is
       * what feeds `newestBrokerTs`. It has never heard a COMMAND from anybody,
       * so `lastCmdTsBySrc` is empty and this is a first sighting in every sense.
       */
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      const heard = countCmds(display);

      try {
        await sleep(HANDSHAKE_MS * 2);
        replayCachedSeek(broker, { seq: 7, ageMs });
        await sleep(1500);
        expect(withStory(`heard=${String(heard())}`, 'heard=0')).toBe('heard=0');
      } finally {
        await display.stop();
      }
    }, 60_000);
  }

  it('ATTACK A control: a FRESH cmd from an unseen src is executed', async () => {
    /*
     * The control that says the gate measures age and not strangeness. Without
     * it every row above passes on a build that simply drops the channel — and a
     * phone somebody has just picked up is, by construction, a stranger.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const heard = countCmds(display);

    try {
      await sleep(HANDSHAKE_MS * 2);
      replayCachedSeek(broker, { seq: 7, ageMs: 0 });
      await sleep(1500);
      expect(withStory(`heard=${String(heard())}`, 'heard=1')).toBe('heard=1');
    } finally {
      await display.stop();
    }
  }, 60_000);

  it('refuses a RETAINED cmd frame however fresh it is', async () => {
    /*
     * `CmdOp` has always said a command is never retained, and `handleFrame`'s
     * cmd branch never read `meta.retained`. A transport that flags a stored
     * last-value or a recovery-poll delivery is telling the truth about it, and
     * a rule nothing enforces is not a rule. Fresh on purpose: the age gates must
     * not be what saves this one.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const heard = countCmds(display);

    try {
      await sleep(HANDSHAKE_MS * 2);
      replayCachedSeek(broker, { seq: 9, ageMs: 0, retained: true });
      await sleep(1500);
      expect(withStory(`heard=${String(heard())}`, 'heard=0')).toBe('heard=0');
    } finally {
      await display.stop();
    }
  }, 60_000);

  it('still refuses a stale cmd from a src it HAS heard from', async () => {
    /*
     * The round-7 contract, kept: one device's clock against itself. The broker
     * hands both frames over fresh, so only the sender's own history can tell
     * them apart — which is why the broker-time gate cannot replace this one.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const heard = countCmds(display);

    try {
      await sleep(HANDSHAKE_MS * 2);
      replayCachedSeek(broker, { seq: 1, ageMs: 0 });
      await sleep(600);
      const before = heard();
      // Fresh at the broker, twenty seconds behind the sender's own newest.
      const env: Envelope<CmdBody> = {
        v: PROTOCOL_VERSION,
        ch: 'cmd',
        ts: Date.now() - 20_000,
        src: 'ghostpeer001',
        role: 'remote',
        seq: 2,
        body: { op: 'seekBy', arg: 10 },
      };
      broker.publish('cmd', encodeEnvelope(env));
      await sleep(1200);
      expect(
        withStory(`before=${String(before)} after=${String(heard())}`, 'before=1 after=1'),
      ).toBe('before=1 after=1');
    } finally {
      await display.stop();
    }
  }, 60_000);

  it('hears a phone three days fast that reloads with a corrected clock', async () => {
    /*
     * Skeptic 2's secondary finding, and the case a broker-time gate has to get
     * right or it is just a second way to go deaf.
     *
     * A phone three days ahead taps once. It reloads — a real page load, so a
     * FRESH `clientId`, which is what `src/platform/env.ts` mints and why every
     * peer is a stranger after a reboot — with its clock corrected, and taps
     * twice more. Reading before the repair: `before=1 after=1`. All three taps
     * are live messages the broker accepted moments ago, and a gate that reads
     * the broker's clock says so; a gate that reads the phone's says nothing
     * useful, because the phone's clock is exactly what changed.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const heard = countCmds(display);
    let phone = await startPhonePeer(broker, {
      id: 'aheadphone01',
      device: 'ph',
      offsetMs: 3 * A_DAY,
    });

    try {
      await sleep(HANDSHAKE_MS * 3);
      withAmbient(phone.clock.offset(), () => {
        note('phone (+3 d) sends play');
        phone.sync.service.sendCmd('play');
      });
      await sleep(800);
      const before = heard();

      note('---- the phone reloads, clock corrected ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, {
        id: 'aheadphone02',
        device: 'ph',
        initial: inherited,
      });
      await sleep(HANDSHAKE_MS * 3);

      for (const op of ['play', 'pause'] as const) {
        note(`phone (corrected) sends ${op}`);
        phone.sync.service.sendCmd(op);
        await sleep(500);
      }
      await sleep(1500);

      expect(
        withStory(`before=${String(before)} after=${String(heard())}`, 'before=1 after=3'),
      ).toBe('before=1 after=3');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);
});
