/**
 * A page's own commit is durable in its own store, with nobody re-telling it.
 *
 * The bug this file pins was found underneath a performance change and is
 * nothing to do with performance. `src/app/config/useSync.ts` publishes on
 * every store notification; gating that on "the body actually changed" made the
 * phone lose a layer it had just added — not from the document, which still had
 * it, and not from the display, which still had it, but from the PHONE'S OWN
 * resolved snapshot, about half a second later. The editor's selection is
 * `look.layers.find(...)`, so the layer and its whole selection strip simply
 * went away under the user's thumb.
 *
 * The mechanism is completeness, not sync. `look` is carried as two kinds of
 * leaf — `look.order` and one `look.layer.<id>` per layer — and a page stamps
 * only what a commit CHANGED. The phone adding its first overlay therefore
 * writes a register for the order and for the new layer, and none for the base:
 * it has never had a reason to decide anything about the base. `leavesToPatch`
 * skips an ordered id it has no leaf for, `remote` outranks `persisted`, and
 * arrays are replaced wholesale — so the phone's remote layer claimed a look of
 * two layers, described one, and the first re-resolve after the commit deleted
 * the rest of the stack.
 *
 * Any inbound state frame refilled the hole (`mergeInto` creates a register for
 * every leaf in a body), which is why an endlessly chattering room never showed
 * it: the phone's own edit was durable only for as long as somebody kept
 * re-notifying it. See `fillOrderedLayers` in `src/sync/appSync.ts`.
 *
 * The gate is not part of either case below, and neither case needs it: both
 * publish on every notification exactly as the shipped hook does, and both fail
 * on the shipped build. The gate did not cause this, it removed the cover.
 *
 * Both cases below deliberately give the phone NO inbound state frame. What
 * they vary is the ordinary, unrelated event that provokes a re-resolve: the
 * Kraken's routine `persistRemote` save in the first, and CAM's Home screen
 * writing the document in the second.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, readState, resetStateCache } from '../state/storage';
import { createStore } from '../state/store';

import { startAppSync, stateToSyncBody } from './appSync';
import {
  brokerTransport,
  camHomeWrites,
  createBroker,
  note,
  resetClockSlots,
  resetTrace,
  sleep,
  startDisplayPeer,
  syncSettings,
  withStory,
  type Broker,
} from './roomHarness';

import type { AppSync } from './appSync';
import type { Layer } from '../state/look/types';
import type { AppState } from '../state/schema';
import type { Store } from '../state/store';

/** The overlay a thumb adds from the phone's Add sheet. */
const OVERLAY: Layer = {
  id: 'clockov1',
  kind: 'clock',
  on: true,
  frame: { w: 1, h: 1, shape: 'square' },
  t: { x: 0.4, y: 0.4, s: 1, r: 0, a: 1 },
  cfg: {},
  v: 1,
};

/**
 * The phone's page, on CAM's origin.
 *
 * `startPhonePeer` models a phone as a device of its own, which is the right
 * model for nearly everything in this directory and the wrong one here: the
 * subject is a page whose store is bound to a real localStorage document that
 * OTHER browsers also write, because that is what makes an unrelated save
 * re-resolve this page's snapshot. It is also what `tests/e2e` runs — the
 * remote and the display share one browser context there.
 */
async function startRemotePage(broker: Broker): Promise<{
  store: Store;
  sync: AppSync;
  stop: () => Promise<void>;
}> {
  const store = createStore(readState().state, 'remote', {
    commitBase: 'snapshot',
    writerId: 'phonepage01',
  });
  const sync = await startAppSync({
    role: 'remote',
    clientId: 'phonepage01',
    store,
    persisted: () => readState().state,
    url: {},
    settings: syncSettings(),
    clockSlot: { read: () => null, write: () => undefined },
    factories: {
      fake: () => brokerTransport(broker, 0),
      localstorage: () => brokerTransport(createBroker()),
    },
  });
  // What `useSync` does: publish this page's snapshot on every notification.
  const off = store.subscribe(() => {
    const next = store.getSnapshot();
    sync.service.publishState(stateToSyncBody(next), { rev: next.rev });
  });
  return {
    store,
    sync,
    async stop() {
      off();
      await sync.stop();
      store.dispose();
    },
  };
}

const layerIds = (s: AppState): string => s.look.layers.map((l) => l.id).join(',');

describe("a layer added on the phone stays in the phone's own view", () => {
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

  it('through five seconds of the Kraken saving, with nothing said back to it', async () => {
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const phone = await startRemotePage(broker);

    try {
      await sleep(1000);
      note('---- the phone adds a clock overlay ----');
      phone.store.commit((s) => ({ ...s, look: { layers: [...s.look.layers, OVERLAY] } }));
      note(`straight after the commit: ${layerIds(phone.store.getSnapshot())}`);

      /*
       * Watched rather than checked once. The loss lands on the first
       * re-resolve after the commit — about half a second later, which every
       * single-sample assertion made straight after the tap sails past.
       */
      let worst = layerIds(phone.store.getSnapshot());
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const ids = layerIds(phone.store.getSnapshot());
        if (ids !== 'base,clockov1' && worst === 'base,clockov1') {
          worst = ids;
          note(`DEVIATION at ${String(i * 100)} ms: the phone's look is [${ids}]`);
        }
      }

      // The document and the Kraken are the control: if they had lost it too,
      // this would be a sync bug, and it is not.
      expect(withStory(layerIds(readState().state), 'base,clockov1')).toBe('base,clockov1');
      expect(withStory(layerIds(display.store.getSnapshot()), 'base,clockov1')).toBe(
        'base,clockov1',
      );
      expect(withStory(worst, 'base,clockov1')).toBe('base,clockov1');
    } finally {
      await phone.stop();
      await display.stop();
    }
  }, 60_000);

  it('when the browser beside it writes the document and says nothing on the wire', async () => {
    const broker = createBroker();
    const phone = await startRemotePage(broker);

    try {
      await sleep(400);
      note('---- the phone adds a clock overlay ----');
      phone.store.commit((s) => ({ ...s, look: { layers: [...s.look.layers, OVERLAY] } }));
      expect(withStory(layerIds(phone.store.getSnapshot()), 'base,clockov1')).toBe('base,clockov1');

      note("---- CAM's Home screen rotates the panel, in the document only ----");
      camHomeWrites((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      await sleep(200);

      expect(withStory(layerIds(phone.store.getSnapshot()), 'base,clockov1')).toBe('base,clockov1');
    } finally {
      await phone.stop();
    }
  }, 30_000);
});
