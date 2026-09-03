/**
 * "Clicking on stuff on the PC doesn't change anything; only my phone changes
 * the live display."
 *
 * The room every earlier suite was missing, and the reason it was missable: it
 * needs THREE seats, and two of them look redundant.
 *
 *  - a **display**, which folds frames and persists what it resolves;
 *  - a **phone**, which publishes stamped frames — one is enough;
 *  - **CAM's configuration window on `#/`**, which until this repair ran no
 *    sync layer at all and reached the LCD only by writing the shared
 *    localStorage document (`camHomeWrites` in the harness).
 *
 * With any one of the three missing the app is correct. `storage-sync` has the
 * display and CAM and no phone, so the display's register table stays empty and
 * the document is never masked. `threePeerConvergence` has all three, but its
 * CAM publishes frames like every other peer, so its edits never travel as a
 * bare document. Put a phone in the room with a CAM that only writes documents
 * and the display's `remote` layer covers every leaf of the synced body from
 * the first frame onward — masking the document unconditionally, and then
 * writing the mask back over it on the next `persistRemote` tick.
 *
 * What these pin is the repair: a document written by another browser on this
 * origin is a DECISION, stamped and published like one (`noteDocumentWrite` in
 * `src/sync/appSync.ts`), and this page's own write coming back through the
 * in-memory bus is not.
 *
 * The editor is the same defect with a second turn of the screw, and it has its
 * own case below: every add is built on the look the editing page is holding,
 * and the editing page reads that look back out of the document the display was
 * overwriting — so an overlay was not merely lost, the NEXT add started from a
 * look that had lost it, and three adds ended as one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit as commitToStorage, resetStateCache } from '../state/storage';

import { DOCUMENT_ADOPT_GRACE_MS } from './appSync';
import {
  HANDSHAKE_MS,
  camHomeWrites,
  createBroker,
  documentState,
  firstDeviation,
  moduleOn,
  note,
  resetClockSlots,
  resetTrace,
  seedEarlierSession,
  sleep,
  startConfigPeer,
  startDisplayPeer,
  startPhonePeer,
  withStory,
  type Peer,
} from './roomHarness';

import type { AppState } from '../state/schema';

/** One overlay, added on top — what the editor's add sheet commits. */
function withOverlay(id: string, kind: string) {
  return (s: AppState): AppState => ({
    ...s,
    look: {
      layers: [
        ...s.look.layers,
        {
          id,
          kind,
          on: true,
          frame: { w: 0.4, h: 0.4, shape: 'square' as const },
          t: { x: 0, y: 0, s: 1, r: 0, a: 1 },
        },
      ],
    },
  });
}

/** The look, as the kinds on the panel in z-order. */
function kindsOn(peer: Peer): string {
  return peer.store
    .getSnapshot()
    .look.layers.map((l) => l.kind)
    .join(',');
}

function kindsStored(): string {
  return documentState()
    .look.layers.map((l) => l.kind)
    .join(',');
}

/** Every leaf this page holds a REAL stamp for. `stampedLeaves` drops EPOCH ones. */
function stampedTable(peer: Peer): Map<string, string> {
  return new Map(
    peer.sync
      .stampedLeaves()
      .map((l) => [l.path, `${String(l.stamp.t)}.${String(l.stamp.c)}.${l.stamp.s}`] as const),
  );
}

/**
 * Poll until EVERY reading is `want`, then hold it quiet for a moment.
 *
 * `settleWithin` answers "have they agreed?", which is true the instant nothing
 * has happened yet — useless for a change that is deliberately delayed by
 * `DOCUMENT_ADOPT_GRACE_MS`. This asks the question the tests actually have.
 */
async function settleOn(read: () => string[], want: string, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (read().every((v) => v === want)) {
      await sleep(300);
      const again = read();
      if (again.every((v) => v === want)) return again.join(' ');
      continue;
    }
    await sleep(20);
  }
  return read().join(' ');
}

/** Long enough for a document write to clear its grace window and be published. */
const AFTER_A_DOCUMENT_WRITE = DOCUMENT_ADOPT_GRACE_MS + 600;

/** Which leaves' stamps MOVED — a re-stamp counts, which is the point. */
function restamped(was: Map<string, string>, now: Map<string, string>): string {
  const moved: string[] = [];
  for (const [path, stamp] of now) if (was.get(path) !== stamp) moved.push(path);
  return moved.sort().join(' ');
}

/**
 * A room whose ONLY talking peers are a display and a phone.
 *
 * The phone's tap is what arms the bug: one stamped frame gives the display a
 * register for every leaf of the body, EPOCH ones included.
 */
async function displayAndPhone(): Promise<{
  broker: ReturnType<typeof createBroker>;
  display: Peer;
  phone: Peer;
  stop: () => Promise<void>;
}> {
  const broker = createBroker();
  const display = await startDisplayPeer(broker);
  const phone = await startPhonePeer(broker);
  await sleep(HANDSHAKE_MS * 2);
  note('the phone taps rotate — one stamped frame is all it takes');
  phone.store.commit((s) => ({ ...s, render: { ...s.render, rotate: 90 } }));
  await sleep(HANDSHAKE_MS * 2);
  return {
    broker,
    display,
    phone,
    stop: async () => {
      await phone.stop();
      await display.stop();
    },
  };
}

describe("CAM's Home screen, in a room that has heard a phone", () => {
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

  it('carries a document write to the display, and on to the phone', async () => {
    const room = await displayAndPhone();
    try {
      expect(withStory(moduleOn(room.display), 'video')).toBe('video');

      note('CAM clicks Clock on Home');
      camHomeWrites((s) => ({ ...s, activeModuleId: 'clock' }));

      // The display, whose only evidence is the document — and the phone,
      // which shares no storage with CAM and can only have learned this from a
      // frame the display put on the wire.
      const settled = await settleOn(() => [moduleOn(room.display), moduleOn(room.phone)], 'clock');
      expect(withStory(settled, 'clock clock')).toBe('clock clock');
    } finally {
      await room.stop();
    }
  }, 40_000);

  it('does not let `persistRemote` write the old value back over it', async () => {
    const room = await displayAndPhone();
    try {
      camHomeWrites((s) => ({ ...s, activeModuleId: 'clock' }));
      await sleep(AFTER_A_DOCUMENT_WRITE);
      /*
       * The second half of the report, and the reason the config UI also looked
       * dead: the display re-resolved with the mask on and committed the result,
       * so CAM's own click was erased from storage about twice a second.
       */
      const deviation = await firstDeviation(() => documentState().activeModuleId, 'clock', 5000);
      expect(withStory(deviation, '')).toBe('');
    } finally {
      await room.stop();
    }
  }, 40_000);

  it("adopts exactly the leaves the write changed, and none of the page's own", async () => {
    const room = await displayAndPhone();
    try {
      /*
       * A `'sync'`-origin commit is the display WRITING DOWN what it holds —
       * the `persistRemote` path. It comes back through the in-memory bus into
       * the very resolver that adopts foreign writes, so without the `writerId`
       * check the display would re-stamp its own document twice a second and
       * own every leaf in the room.
       */
      const before = stampedTable(room.display);
      room.display.store.commit((s) => ({ ...s, render: { ...s.render, zoom: 1.5 } }), {
        origin: 'sync',
      });
      await sleep(100);
      expect(withStory(restamped(before, stampedTable(room.display)), '')).toBe('');

      // And a write by the OTHER browser stamps exactly what it changed.
      const was = stampedTable(room.display);
      camHomeWrites((s) => ({
        ...s,
        activeModuleId: 'clock',
        render: { ...s.render, rotate: 180 },
      }));
      await sleep(AFTER_A_DOCUMENT_WRITE);
      /*
       * `look.layer.base` is not a surprise: `activeModuleId` and the base
       * layer's `kind` are the same fact, forced to agree on the way out
       * (`withBaseKind`) and in the stored document. Nothing else moved —
       * `playback`, `look.order` and the whole module bank are untouched, even
       * though the document that arrived carried every one of them.
       */
      expect(
        withStory(
          restamped(was, stampedTable(room.display)),
          'activeModuleId look.layer.base render.rotate',
        ),
      ).toBe('activeModuleId look.layer.base render.rotate');
    } finally {
      await room.stop();
    }
  }, 40_000);

  it('outranks an older frame and loses to a newer one', async () => {
    const room = await displayAndPhone();
    try {
      note('CAM clicks Clock');
      camHomeWrites((s) => ({ ...s, activeModuleId: 'clock' }));
      await sleep(AFTER_A_DOCUMENT_WRITE);
      expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');

      /*
       * OLDER: an unstamped snapshot an earlier session left in the retained
       * slot, redelivered when the radio comes back — the exact shape of frame
       * that used to overturn a CAM click, because both registers read EPOCH and
       * the tie fell to whichever value sorted larger as JSON ("stats" beats
       * "clock", and that is the whole of why it won).
       */
      seedEarlierSession(room.broker, 'stats');
      room.display.mute();
      await sleep(200);
      room.display.unmute();
      const held = await firstDeviation(() => moduleOn(room.display), 'clock', 2500);
      expect(withStory(held, '')).toBe('');

      // NEWER: a genuine tap, after CAM's, from a peer that is in touch.
      note('the phone picks Stats');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      const settled = await settleOn(() => [moduleOn(room.display), moduleOn(room.phone)], 'stats');
      expect(withStory(settled, 'stats stats')).toBe('stats stats');
    } finally {
      await room.stop();
    }
  }, 40_000);

  it('resolves a CAM write against a phone edit on the same leaf by order', async () => {
    const room = await displayAndPhone();
    try {
      // The phone first, CAM second: CAM's is the later decision.
      note('the phone picks Stats');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'stats' }));
      await sleep(400);
      note('CAM clicks Clock a moment later');
      camHomeWrites((s) => ({ ...s, activeModuleId: 'clock' }));
      const first = await settleOn(
        () => [moduleOn(room.display), moduleOn(room.phone), documentState().activeModuleId],
        'clock',
      );
      expect(withStory(first, 'clock clock clock')).toBe('clock clock clock');

      // And the other way round, where the phone is the later decision.
      await sleep(300);
      note('the phone picks Video last');
      room.phone.store.commit((s) => ({ ...s, activeModuleId: 'video' }));
      const second = await settleOn(
        () => [moduleOn(room.display), moduleOn(room.phone), documentState().activeModuleId],
        'video',
      );
      expect(withStory(second, 'video video video')).toBe('video video video');
    } finally {
      await room.stop();
    }
  }, 40_000);

  it("survives the display's own reload", async () => {
    const room = await displayAndPhone();
    let reloaded: Peer | null = null;
    try {
      camHomeWrites((s) => ({ ...s, activeModuleId: 'clock' }));
      await sleep(AFTER_A_DOCUMENT_WRITE);
      expect(withStory(moduleOn(room.display), 'clock')).toBe('clock');

      note('the Kraken browser reloads');
      await room.display.stop();
      const fresh = await startDisplayPeer(room.broker);
      reloaded = fresh;
      await sleep(HANDSHAKE_MS * 3);

      const held = await firstDeviation(() => moduleOn(fresh), 'clock', 3000);
      expect(withStory(held, '')).toBe('');
    } finally {
      if (reloaded !== null) await reloaded.stop();
      await room.phone.stop();
    }
  }, 40_000);

  it('accumulates three overlays added one after another', async () => {
    /*
     * ── The editor's version of the same defect ────────────────────────────
     *
     * Each add is a document write, and each is built on the look the editing
     * page is CURRENTLY holding. On the broken build the display's routine
     * two-second save wrote the masked look — the one with no overlays — back
     * over the document about 1.2 s after every commit, and the editing page
     * reads its own snapshot back out of that document. So the second add was
     * built on a look that had lost the first one, and every add REPLACED its
     * predecessor: three adds ended as `video,date` with the rail dropping to
     * zero overlays between each one.
     *
     * The spacing is the measurement: 1.5 s apart is inside the save's throttle
     * and outside the adoption's grace window, which is exactly where the two
     * used to collide.
     */
    const room = await displayAndPhone();
    try {
      camHomeWrites(withOverlay('ovla', 'clock'));
      await sleep(1500);
      camHomeWrites(withOverlay('ovlb', 'text'));
      await sleep(1500);
      camHomeWrites(withOverlay('ovlc', 'date'));

      const want = 'video,clock,text,date';
      const settled = await settleOn(() => [kindsOn(room.display), kindsOn(room.phone)], want);
      expect(withStory(settled, `${want} ${want}`)).toBe(`${want} ${want}`);
      // And the document — which is what the editing page reads back — keeps
      // every one of them, rather than being rewritten to the masked look.
      const deviation = await firstDeviation(kindsStored, want, 5000);
      expect(withStory(deviation, '')).toBe('');
    } finally {
      await room.stop();
    }
  }, 40_000);

  it("does not let an older frame mask an editing page's own commit", async () => {
    /*
     * The third face of the same bug, on the page doing the editing rather than
     * on the display. A configuration window with a sync layer resolves every
     * document that arrives through its register table, so the question is
     * whether its OWN just-committed write outranks a frame that predates it —
     * and a retained snapshot from an earlier session, redelivered the moment
     * the radio comes back, is the oldest frame there is.
     *
     * The commit is stamped at the instant it is made (`onCommit`), and the
     * retained frame carries no stamp at all, so the adopted value is newer by
     * construction. This measures that rather than assuming it.
     */
    const broker = createBroker();
    const display = await startDisplayPeer(broker);
    const cam = await startConfigPeer(broker, HANDSHAKE_MS);
    const phone = await startPhonePeer(broker);
    await sleep(HANDSHAKE_MS * 3);

    try {
      note('CAM adds an overlay in the editor');
      cam.store.commit(withOverlay('ovla', 'clock'));
      await sleep(300);

      note('an earlier session’s retained snapshot is replayed on reconnect');
      seedEarlierSession(broker, 'video');
      cam.mute();
      await sleep(200);
      cam.unmute();

      const held = await firstDeviation(() => kindsOn(cam), 'video,clock', 4000);
      expect(withStory(held, '')).toBe('');
      // …and the room agrees, so this is not a page that merely refuses to listen.
      const settled = await settleOn(() => [kindsOn(display), kindsOn(phone)], 'video,clock', 8000);
      expect(withStory(settled, 'video,clock video,clock')).toBe('video,clock video,clock');
    } finally {
      await phone.stop();
      await cam.stop();
      await display.stop();
    }
  }, 40_000);
});
