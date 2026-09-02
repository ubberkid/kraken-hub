/**
 * The clock slot's caps, and the user edit they used to throw away.
 *
 * `saveClock` packs the register table into one localStorage slot under two
 * caps: `MAX_SLOT_REGISTERS` (32) and `MAX_SLOT_BYTES`. The contract in
 * `types.ts` used to say a dropped register "costs ordering after a reload and
 * nothing more — the leaf simply restores unstamped and cannot win an argument.
 * Nobody else is misled." Both halves were false.
 *
 * An unstamped leaf cannot win an argument it SHOULD win. So a write the room
 * has not heard yet — an offline edit — dropped from the slot across a reload
 * comes back at `EPOCH`, loses to the room's stale value, and is silently
 * reverted on every screen in the room. There is no `lastError`, no notice, and
 * no way for the person to tell which of their edits was undone.
 *
 * The trigger is one extra tap. A phone loses its radio, changes `render.fit`,
 * turns 31 other knobs, and reloads:
 *
 *     N=30 offline edits → 32 registers → render.fit present  → fit=contain ✓
 *     N=31 offline edits → 33 registers → render.fit EVICTED  → fit=cover   ✗
 *     N=35 offline edits → 37 registers → render.fit EVICTED  → fit=cover   ✗
 *
 * The boundary is exactly `MAX_SLOT_REGISTERS`, and the aggravating detail is
 * that the other 31 offline edits all LAND — the room holds no register for
 * them, so an unstamped value fills a gap unopposed. The single edit that is
 * lost is the first one, the only one the room already had an opinion about.
 * 33 stamped registers is not a stress figure: a settled room measures 21 after
 * twenty ordinary config writes.
 *
 * The repair is a rule rather than a bigger number: a cap may only evict a
 * register THE ROOM ALREADY HOLDS. `appSync`'s `unshipped` set tracks the rest
 * and `saveClock` packs it first. See `MAX_SLOT_REGISTERS` and `unshipped`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  videoCfg,
  withStory,
  type Peer,
} from './roomHarness';

/** Turn one module-config knob, the way the video panel's sliders do. */
function knob(peer: Peer, key: string, value: unknown): void {
  peer.store.commit((s) => ({
    ...s,
    modules: {
      ...s.modules,
      video: {
        v: s.modules['video']?.v ?? 1,
        cfg: { ...((s.modules['video']?.cfg ?? {}) as Record<string, unknown>), [key]: value },
      },
    },
  }));
}

describe('the clock slot never evicts a write the room has not heard', () => {
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

  for (const n of [30, 31, 35]) {
    it(`keeps an offline fit=contain through ${String(n)} later offline edits and a reload`, async () => {
      /*
       * Skeptic 3's Finding 1 verbatim. Readings before the repair:
       *
       *     N=30 → restored 32 registers, render.fit present=true  → contain
       *     N=31 → restored 32 registers, render.fit present=false → cover
       *     N=35 → restored 32 registers, render.fit present=false → cover
       *
       * `knob0` is the control: it lands on every run, broken or fixed, because
       * the room holds no register to argue with. That is what makes the loss so
       * hard to see from the outside — 31 of 32 offline edits arrive.
       */
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      const config = await startConfigPeer(broker, HANDSHAKE_MS);
      let phone = await startPhonePeer(broker, { device: 'ph' });

      try {
        await sleep(HANDSHAKE_MS * 3);

        note('---- CAM stamps render.fit=cover ----');
        config.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'cover' } }));
        await settleWithin(() => [fitOn(display), fitOn(config), fitOn(phone)], 6000);

        note('---- the phone loses its radio ----');
        phone.mute();
        await sleep(200);

        // The FIRST offline edit, and the only leaf the room already holds a
        // register for. Everything after it is a gap-filler.
        phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
        for (let i = 0; i < n; i += 1) knob(phone, `k${String(i)}`, i);
        await sleep(300);

        note('---- the phone reloads ----');
        const inherited = phone.doc();
        await phone.stop();
        phone = await startPhonePeer(broker, { device: 'ph', initial: inherited });
        await sleep(HANDSHAKE_MS * 4);

        const readings = await settleWithin(
          () => [fitOn(display), fitOn(config), fitOn(phone)],
          8000,
        );
        const raw = videoCfg(display)['k0'];
        const knob0 = typeof raw === 'number' ? String(raw) : 'missing';
        expect(
          withStory(
            `fit=${readings.join('/')} knob0=${knob0}`,
            'fit=contain/contain/contain knob0=0',
          ),
        ).toBe('fit=contain/contain/contain knob0=0');
      } finally {
        await phone.stop();
        await config.stop();
        await display.stop();
      }
    }, 60_000);
  }

  it('skips only the oversized register, never the older ones behind it', async () => {
    /*
     * Skeptic 3's Finding 2: `appSync.ts`'s byte rung was `break`, so ONE
     * register larger than the remaining budget discarded itself and every OLDER
     * register behind it — a whole slot wiped by a single fat module-config
     * value. `continue` makes it skip itself and nothing else.
     *
     * Measured at the slot rather than at the room, because a value this large
     * cannot cross an 8 kB wire at all: the frame is refused, the room never
     * hears any of it, and a room-level reading would be measuring the envelope
     * cap instead of the slot's. The register table after a reload is the thing
     * under test, and `stampedLeaves()` IS that table.
     *
     * `fat` is past `MAX_UNSHIPPED_SLOT_BYTES` on its own, so it cannot be kept
     * by any pass; `render.fit` and `k0` are written before it and must both
     * come back.
     */
    const broker = createBroker();
    let phone = await startPhonePeer(broker, { device: 'ph' });

    try {
      await sleep(HANDSHAKE_MS);
      phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
      knob(phone, 'k0', 0);
      knob(phone, 'fat', 'x'.repeat(200_000));
      await sleep(300);

      note('---- the phone reloads ----');
      const inherited = phone.doc();
      await phone.stop();
      phone = await startPhonePeer(broker, { device: 'ph', initial: inherited });
      await sleep(HANDSHAKE_MS);

      const paths = new Set(phone.sync.stampedLeaves().map((l) => l.path));
      const reading = [
        `fit=${String(paths.has('render.fit'))}`,
        `k0=${String(paths.has('modules.video.cfg.k0'))}`,
        `fat=${String(paths.has('modules.video.cfg.fat'))}`,
      ].join(' ');
      expect(withStory(reading, 'fit=true k0=true fat=false')).toBe('fit=true k0=true fat=false');
    } finally {
      await phone.stop();
    }
  }, 60_000);

  it('drops the register of a cfg key the document no longer has', async () => {
    /*
     * `onCommit` iterated the NEW leaf map only, so a register whose leaf had
     * been deleted stayed in the table for the life of the device — occupying a
     * capped slot on behalf of nothing, and helping push a live write off the
     * end. Deleting the key now deletes the register with it.
     *
     * Read through `stampedLeaves()`, which is the register table itself; the
     * document reading would only prove the delete, not the bookkeeping.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const phone = await startPhonePeer(broker, { device: 'ph' });

    try {
      await sleep(HANDSHAKE_MS * 2);
      knob(phone, 'doomed', 7);
      await sleep(200);
      const present = phone.sync.stampedLeaves().some((l) => l.path.endsWith('.doomed'));

      phone.store.commit((s) => {
        const cfg = { ...((s.modules['video']?.cfg ?? {}) as Record<string, unknown>) };
        delete cfg['doomed'];
        return {
          ...s,
          modules: { ...s.modules, video: { v: s.modules['video']?.v ?? 1, cfg } },
        };
      });
      await sleep(200);
      const after = phone.sync.stampedLeaves().some((l) => l.path.endsWith('.doomed'));

      expect(
        withStory(
          `written=${String(present)} afterDelete=${String(after)}`,
          'written=true afterDelete=false',
        ),
      ).toBe('written=true afterDelete=false');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);
});
