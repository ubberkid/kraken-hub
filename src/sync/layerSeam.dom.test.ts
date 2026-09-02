/**
 * The two halves of a look, and the seam that pulled them apart.
 *
 * A look is carried on the wire as `look.order` — the z-order, one leaf — plus
 * one leaf per layer. That carving is right: adding and removing a layer is an
 * ordinary stamped write to the order, and moving a layer is a write to that
 * layer alone. What it means is that the two halves have to be RESTORED
 * together, because an order naming a layer whose leaf is missing is not a
 * smaller look, it is a look that contradicts itself.
 *
 * The restore used to keep a slot register only when the persisted DOCUMENT
 * still named the leaf. `look.order` is in every document (defaults have one);
 * `look.layer.<id>` for a layer the document has not learned yet is not — and
 * the document is written on a two-second trailing throttle, is switched off
 * entirely by `sync.persistRemote: false`, and can silently refuse a write on a
 * full quota. So a reload could restore the ORDER of a two-layer look without
 * the layer it names. The page then published a one-layer body under the
 * two-layer order's stamp; every receiver saw the same stamp against a
 * different value; `merge.ts` treats that as a corrupt register and prefers the
 * incoming one; and the two sides swapped the overlay on and off forever.
 * Measured: an overlay blinking on the actual LCD, with no clock skew, no blip
 * and no reorder.
 *
 * The gate is gone — since slot v2 the register carries its own value, so the
 * document has nothing to contribute — and `wireStamps()` now states the
 * converse invariant directly: a stamp travels only for a leaf whose value in
 * the outgoing body is the value that stamp describes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { stateToSyncBody } from './appSync';
import {
  HANDSHAKE_MS,
  createBroker,
  note,
  resetClockSlots,
  resetTrace,
  settleWithin,
  sleep,
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

/** The reading: which layers this peer believes are on the panel, in order. */
function lookOn(peer: Peer): string {
  return peer.store
    .getSnapshot()
    .look.layers.map((l) => l.id)
    .join('+');
}

const addOverlay = (s: AppState): AppState => ({
  ...s,
  look: {
    layers: [
      ...s.look.layers,
      {
        id: 'over1',
        kind: 'clock',
        on: true,
        frame: { w: 1, h: 1, shape: 'square' },
        t: { x: 0.25, y: -0.25, s: 1, r: 0, a: 1 },
        v: 1,
        cfg: { face: 'digital' },
      },
    ],
  },
});

/**
 * The phone announces its snapshot the moment its channel is usable — exactly
 * what `src/app/config/useSync.ts` does on start. It is the announce that puts
 * a contradictory body on the wire, so a harness without it cannot see this.
 */
function announce(peer: Peer): void {
  const snap = peer.store.getSnapshot();
  peer.sync.service.publishState(stateToSyncBody(snap), { rev: snap.rev, immediate: true });
}

describe('a phone that reloads while the room has a layer its document has not learned', () => {
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

  for (const variant of [
    { name: 'with persistRemote off', persistRemote: false, quota: false },
    {
      name: 'with a quota-refused document write on default settings',
      persistRemote: true,
      quota: true,
    },
  ]) {
    it(`keeps the overlay on every peer ${variant.name}`, async () => {
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      const cam = await startConfigPeer(broker, HANDSHAKE_MS);
      let phone = await startPhonePeer(broker, {
        name: 'phone',
        id: 'phonepeer001',
        device: 'phonedev',
        persistRemote: variant.persistRemote,
        quotaOnSyncWrites: variant.quota,
      });
      await sleep(HANDSHAKE_MS * 3);

      try {
        note('---- CAM adds an overlay layer ----');
        cam.store.commit(addOverlay);
        await sleep(HANDSHAKE_MS * 3);
        expect(withStory(lookOn(cam), 'base+over1')).toBe('base+over1');
        expect(withStory(lookOn(phone), 'base+over1')).toBe('base+over1');
        // The phone's snapshot has the overlay and its DOCUMENT does not: that
        // gap is the whole of the defect, and it is asserted rather than hoped.
        const inherited = phone.doc();
        expect(withStory(inherited.look.layers.map((l) => l.id).join('+'), 'base')).toBe('base');

        note('---- the phone reloads and announces what it booted with ----');
        await phone.stop();
        phone = await startPhonePeer(broker, {
          name: 'phoneB',
          id: 'phonepeer002',
          device: 'phonedev',
          initial: inherited,
          persistRemote: variant.persistRemote,
          quotaOnSyncWrites: variant.quota,
        });
        announce(phone);

        const peers = [cam, phone, display];
        const readings = await settleWithin(
          () => peers.map((p) => `${p.name}=${lookOn(p)}`),
          12_000,
        );
        const want = 'CAM=base+over1 phoneB=base+over1 display=base+over1';
        expect(withStory(readings.join(' '), want)).toBe(want);

        // Settled is not enough on its own: the failure was a BLINK, so the
        // reading has to hold still for a while after it agrees.
        await sleep(2000);
        expect(withStory(peers.map((p) => `${p.name}=${lookOn(p)}`).join(' '), want)).toBe(want);
      } finally {
        await phone.stop();
        await cam.stop();
        await display.stop();
      }
    }, 120_000);
  }
});

/**
 * A damaged clock slot must cost ordering and nothing else.
 *
 * Every one of these was a live probe against the v2 slot, and every one of
 * them held. They are pins now rather than probes: the restore reads BOTH
 * halves of a register from this string, so anything that can be wrong with the
 * string is a way to mis-pair a stamp with a value, and mis-pairing is the seam
 * that once laundered a superseded value across a whole room.
 *
 * The script is one per damage: the phone sets `render.fit = 'cover'`, CAM
 * supersedes it with `'contain'` inside the phone's persist window, and the
 * phone reloads with the damaged slot. The settled reading must be `contain`
 * everywhere — the room's newest write — however broken the slot was.
 */
describe('a phone that reloads with a damaged clock slot', () => {
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

  const damaged: { name: string; raw?: string; device?: string }[] = [
    // A device that never managed to write one: every slot write hit the quota.
    { name: 'no slot at all (every write hit the quota)', device: 'freshdev' },
    { name: 'a v1 slot from an older build', raw: '{"v":1,"clock":[1,0,"x"],"stamps":{}}' },
    {
      name: 'a half-paired register claiming the end of time',
      raw: '{"v":2,"clock":[4102444800000,99,"zzzzzzzzzzzz"],"offset":0,"stamps":{"render.fit":{"s":[4102444800000,99,"zzzzzzzzzzzz"]}}}',
    },
    { name: 'a slot that is not JSON', raw: 'not json at all {' },
    { name: 'a slot whose stamps is a string', raw: '{"v":2,"clock":[1,0,"x"],"stamps":"nope"}' },
  ];

  for (const damage of damaged) {
    it(`still lands the room's newest write: ${damage.name}`, async () => {
      const broker = createBroker();
      const display = await startDisplayPeer(broker);
      const cam = await startConfigPeer(broker, HANDSHAKE_MS);
      let phone = await startPhonePeer(broker, {
        name: 'phone',
        id: 'phonepeer001',
        device: 'phonedev',
      });
      await sleep(HANDSHAKE_MS * 3);

      try {
        note('---- the phone sets fit=cover ----');
        phone.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'cover' } }));
        await sleep(200);
        note('---- CAM supersedes it with contain, inside the phone’s persist window ----');
        cam.store.commit((s) => ({ ...s, render: { ...s.render, fit: 'contain' } }));
        await sleep(HANDSHAKE_MS * 3);

        const inherited = phone.doc();
        await phone.stop();
        note(`---- the phone reloads with a damaged slot: ${damage.name} ----`);
        phone = await startPhonePeer(broker, {
          name: 'phoneB',
          id: 'phonepeer002',
          initial: inherited,
          device: damage.device ?? 'phonedev',
          ...(damage.raw === undefined ? {} : { slotRaw: damage.raw }),
        });
        announce(phone);

        const peers = [phone, cam, display];
        const readings = await settleWithin(
          () => peers.map((p) => `${p.name}=${p.store.getSnapshot().render.fit}`),
          12_000,
        );
        const want = 'phoneB=contain CAM=contain display=contain';
        expect(withStory(readings.join(' '), want)).toBe(want);
      } finally {
        await phone.stop();
        await cam.stop();
        await display.stop();
      }
    }, 120_000);
  }
});
