/**
 * The first frame of a local commit, and the false claim it used to carry.
 *
 * `store.commit` writes through `commitToStorage`, which fires the in-memory
 * bus SYNCHRONOUSLY — so this page's own write came straight back through
 * `watchState`, re-resolved the snapshot, and NOTIFIED, all from inside the
 * commit. `src/app/config/useSync.ts` publishes on every notification and
 * `appSync` stamps in an `onCommit` listener that runs afterwards, so the order
 * on a plain tap was:
 *
 *     commit → storage bus → notify → PUBLISH (value, no stamp) → stamp → notify → publish
 *
 * The first frame of every local commit therefore carried the new value with no
 * stamp for it. A missing stamp is not "less information": it reads as `EPOCH`,
 * the beginning of time — the strongest possible claim that nobody has ever
 * written that leaf. Convergence survived because the very next frame was
 * stamped, which is why no reading ever disagreed; but it is the same torn read
 * that produced the phone's undo bug, and `lookHistoryStore` still carries the
 * microtask flush it needed to work around it.
 *
 * The repair is at the root: a re-entrancy guard in `src/state/store.ts` that
 * suppresses the notification a commit provokes through its own storage write.
 * The commit path then runs its commit listeners — where `appSync` stamps — and
 * notifies ONCE, stamped.
 *
 * Measured here from both sides: the wire (every first frame carries the stamp
 * of the leaf just written) and the store (one notification per commit, and
 * other stores on the same bus still hear it).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, readState, resetStateCache } from '../state/storage';
import { createStore } from '../state/store';

import { decodeEnvelope } from './envelope';
import {
  HANDSHAKE_MS,
  createBroker,
  installDeviceClocks,
  note,
  resetClockSlots,
  resetTrace,
  restoreDeviceClocks,
  sleep,
  startConfigPeer,
  startDisplayPeer,
  withStory,
  type Broker,
} from './roomHarness';

/** Every `state` frame `src` put on the wire, decoded, in order. */
function watchWire(broker: Broker, src: string): { stamps: string[]; rotate: unknown }[] {
  const frames: { stamps: string[]; rotate: unknown }[] = [];
  const publish = broker.publish.bind(broker);
  broker.publish = (ch, frame): void => {
    if (ch === 'state') {
      const env = decodeEnvelope(frame);
      if (env !== null && env.src === src) {
        const body = env.body as { render?: { rotate?: unknown } };
        frames.push({
          stamps: Object.keys(env.stamps ?? {}),
          rotate: body.render?.rotate,
        });
      }
    }
    publish(ch, frame);
  };
  return frames;
}

describe('the first frame of a local commit carries the stamp of what changed', () => {
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

  it('never publishes the new value before its stamp', async () => {
    /*
     * Skeptic 4's wire invariant. Before the repair every one of these taps
     * produced a first frame whose body carried the new `render.rotate` and
     * whose `stamps` map did not mention `render.rotate` at all — a leaf claimed
     * as never-written by the very page that had just written it.
     *
     * The reading is deliberately narrow: for each tap, the FIRST frame CAM puts
     * on the wire that already carries the new value must also carry its stamp.
     * A frame that predates the commit is not evidence either way.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const config = await startConfigPeer(broker, HANDSHAKE_MS);
    const frames = watchWire(broker, 'configpeer01');

    try {
      await sleep(HANDSHAKE_MS * 3);

      const unstamped: string[] = [];
      for (const rotate of [90, 180, 270, 90, 180] as const) {
        const from = frames.length;
        note(`CAM taps rotate=${String(rotate)}`);
        config.store.commit((s) => ({ ...s, render: { ...s.render, rotate } }));
        await sleep(600);
        const first = frames.slice(from).find((f) => f.rotate === rotate);
        if (first === undefined) {
          unstamped.push(`rotate=${String(rotate)} never shipped`);
          continue;
        }
        if (!first.stamps.includes('render.rotate')) {
          unstamped.push(`rotate=${String(rotate)} shipped with no stamp`);
        }
      }

      expect(withStory(`falseEpochClaims=${String(unstamped.length)}`, 'falseEpochClaims=0')).toBe(
        'falseEpochClaims=0',
      );
    } finally {
      await config.stop();
      await display.stop();
    }
  }, 60_000);

  it('notifies once per commit, and still tells the other window', () => {
    /*
     * The guard, from the store's own side, in the shape that made it delicate:
     * two stores on ONE localStorage, which is exactly CAM's configuration
     * browser and the Kraken browser.
     *
     * `committing` is per-store, so the display's watcher is a different closure
     * with its own flag — it must keep firing for CAM's writes, or the display
     * stops following the configuration page altogether. And CAM's own commit
     * must notify exactly once, not twice, and the once must be AFTER the commit
     * listeners have run.
     */
    const cam = createStore(readState().state, 'config', { commitBase: 'snapshot' });
    const display = createStore(readState().state, 'display');
    try {
      let camNotifications = 0;
      let displayNotifications = 0;
      const seenByCam: string[] = [];
      let stampedBeforeNotify = false;
      let committed = false;

      cam.subscribe(() => {
        camNotifications += 1;
        seenByCam.push(cam.getSnapshot().activeModuleId);
        if (committed) stampedBeforeNotify = true;
      });
      display.subscribe(() => {
        displayNotifications += 1;
      });
      cam.onCommit(() => {
        committed = true;
      });

      cam.commit((s) => ({ ...s, activeModuleId: 'clock' }));

      expect(
        [
          `camNotified=${String(camNotifications)}`,
          `camSaw=${seenByCam.join(',')}`,
          `commitListenerRanFirst=${String(stampedBeforeNotify)}`,
          `displayNotified=${String(displayNotifications)}`,
        ].join(' '),
      ).toBe('camNotified=1 camSaw=clock commitListenerRanFirst=true displayNotified=1');
    } finally {
      cam.dispose();
      display.dispose();
    }
  });

  it('still re-resolves its snapshot from the storage write it made itself', () => {
    /*
     * The half the guard must NOT break. `store.ts`'s comment protects the
     * re-resolution the storage bus performs during a commit — the sync layer's
     * `setResolve` puts the room's leaves back on top — and only the
     * NOTIFICATION is suppressed. A guard that skipped the assignment as well
     * would leave the snapshot behind the document.
     */
    const store = createStore(readState().state, 'config', { commitBase: 'snapshot' });
    try {
      const seen: string[] = [];
      store.setResolve((persisted) => {
        seen.push(persisted.activeModuleId);
        return persisted;
      });
      store.commit((s) => ({ ...s, activeModuleId: 'clock' }));
      expect(`resolved=${seen.join(',')} snapshot=${store.getSnapshot().activeModuleId}`).toBe(
        'resolved=clock snapshot=clock',
      );
    } finally {
      store.dispose();
    }
  });
});
