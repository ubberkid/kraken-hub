/**
 * A page that has been told to stop does not write afterwards.
 *
 * `stop()` is the shutdown: it clears the persist timer, drops a document
 * adoption still waiting out its grace window, flushes the last write, and then
 * — the part this file is about — AWAITS the transport's `disconnect()`. That
 * await is not instantaneous by design: `MqttTransport.disconnect()` uses
 * `end(false, …)` with a 1.5 s ceiling so the last frame of a session is not
 * lost, and a frame already in flight when the page began closing is delivered
 * to a listener that is still attached.
 *
 * Nothing stopped that frame being FOLDED, and folding it ends in
 * `schedulePersist()` — so a page in the middle of closing merged somebody
 * else's snapshot and wrote the shared document one more time, after its last
 * word.
 *
 * What that costs is not theoretical. `tests/e2e/sync-remote.spec.ts`'s cold-boot
 * test closes the phone, deletes the state document, and asserts that the
 * retained wire message is the only surviving record — and about one run in four
 * under a fully parallel suite found the document back, rewritten by a
 * `writerRole: 'remote'`, `writerOrigin: 'sync'` save: the closed phone's, landing
 * after the delete. On CAM's own origin the same write is worse than a confusing
 * test, because the document is what the next cold boot reads: a page that was
 * closed gets a vote on what the machine wakes up as.
 *
 * The rule is the title. After `stop()` has been called, the only write this
 * layer makes is `stop()`'s own flush.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import {
  HANDSHAKE_MS,
  LATENCY_MS,
  createBroker,
  note,
  resetClockSlots,
  resetTrace,
  sleep,
  startPhonePeer,
  story,
  withStory,
} from './roomHarness';

import type { AppState } from '../state/schema';

/**
 * The modelled `disconnect()` flush, comfortably longer than the broker's
 * latency so a frame put on the wire as the page closes lands INSIDE it.
 */
const FLUSH_WINDOW_MS = 600;

/** Everything about a document that a write would move. */
function signature(doc: AppState): string {
  return `rev=${String(doc.rev)} at=${String(doc.updatedAt)} rotate=${String(doc.render.rotate)}`;
}

describe('a page that has been told to stop', () => {
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

  it('does not write its document for a frame that lands while it is closing', async () => {
    const broker = createBroker();
    const closing = await startPhonePeer(broker, {
      name: 'closing',
      id: 'closingphone',
      // The real flush window: over MQTT this page spends up to 1.5 s inside
      // `stop()` with its handlers still attached. See `PhoneOptions`.
      disconnectMs: FLUSH_WINDOW_MS,
    });
    const other = await startPhonePeer(broker, { name: 'other', id: 'otherphone01' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      /*
       * A frame is put on the wire and the page is closed inside its flight
       * time — which is the whole scenario, and the reason the broker's latency
       * is what the timing is written against rather than a round number. The
       * transport's `disconnect()` detaches the subscription, but a delivery
       * already scheduled for this listener still arrives: that is exactly what
       * a real `end(false, …)` flush window does.
       */
      note('---- the other phone speaks, and this one closes inside the flight ----');
      other.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 270 } }));

      /*
       * The page's own shutdown, and nothing else — `pagehide` calls exactly
       * this, and it does not dispose the store.
       *
       * The signature is read the instant `stop()` has been CALLED rather than
       * after it resolves, because `stop()`'s synchronous prefix contains the
       * one write this page is still entitled to make: the shutdown flush.
       * Everything the flush window does afterwards has to be nothing.
       */
      const stopping = closing.sync.stop();
      const settled = signature(closing.doc());
      note(`---- stop() called, document flushed at ${settled} ----`);

      await stopping;
      // Long enough for the frame to land and for any save it schedules to
      // fire — a save inside the throttle window is a timer two seconds out.
      await sleep(3000);

      expect(withStory(signature(closing.doc()), settled)).toBe(settled);
    } finally {
      note(story());
      await other.stop();
      await closing.stop();
    }
  }, 30_000);

  it('does not write its document for a save that was already pending', async () => {
    const broker = createBroker();
    const closing = await startPhonePeer(broker, {
      name: 'closing',
      id: 'closingphone',
      // The real flush window: over MQTT this page spends up to 1.5 s inside
      // `stop()` with its handlers still attached. See `PhoneOptions`.
      disconnectMs: FLUSH_WINDOW_MS,
    });
    const other = await startPhonePeer(broker, { name: 'other', id: 'otherphone01' });
    await sleep(HANDSHAKE_MS * 3);

    try {
      /*
       * Two frames inside one throttle window: the first save goes out
       * immediately and the second is left pending on a timer. `stop()` flushes
       * that pending write ONCE — deliberately, because the document is what a
       * cold boot reads — and the timer must not then fire a second one.
       */
      other.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
      await sleep(LATENCY_MS * 3);
      other.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 180 } }));
      await sleep(LATENCY_MS * 3);

      const stopping = closing.sync.stop();
      const settled = signature(closing.doc());
      await stopping;

      await sleep(3000);

      expect(withStory(signature(closing.doc()), settled)).toBe(settled);
    } finally {
      note(story());
      await other.stop();
      await closing.stop();
    }
  }, 30_000);
});
