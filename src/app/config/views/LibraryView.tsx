import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  COPY_HOME,
  IN_YOUR_LIBRARY,
  KEEPING_A_COPY_NOW,
  KEPT_SAFELY,
  KEPT_VERB,
  NOTHING_KEPT,
  OFFLINE_PROMISE,
} from '../../../config/vocabulary';
import { formatBytes } from '../../../lib/bytes';
import { imageModule } from '../../../modules/image';
import {
  deleteImage,
  getImageBlob,
  listImages,
  renameImage,
  setImagePinned,
  setImageThumb,
  type ImageRecord,
} from '../../../modules/image/imageStore';
import { ingestImageBlob } from '../../../modules/image/ingest';
import { localImageId, validateImageConfig } from '../../../modules/image/schema';
import { makeImageThumbnail } from '../../../modules/image/thumbnail';
import { videoModule } from '../../../modules/video';
import {
  deleteClip,
  getClipBlob,
  publishClipIndex,
  readQuota,
  renameClip,
  setClipThumb,
  setPinned,
  listClips,
  type ClipRecord,
  type QuotaInfo,
} from '../../../modules/video/local/clipStore';
import {
  abortDownload,
  downloadToClip,
  listDownloads,
  progressPct,
  readMirroredDownloads,
  subscribeDownloads,
  type DownloadEntry,
} from '../../../modules/video/local/downloadManager';
import { ingestFile, makeThumbnail } from '../../../modules/video/local/ingest';
import { detect } from '../../../modules/video/routing/detect';
import { validateVideoConfig } from '../../../modules/video/types';
import { Button, Chip, Meter, Notice } from '../../../ui';
import { withBaseKind } from '../../state/switchBase';
import { hasDisplayBeenSeen } from '../displaySeen';
import { RECEIPT_LINGER_MS, failureLine } from '../homeState';
import { buildLibraryTiles, tileDetail, type LibraryTile } from '../libraryItems';
import { linkReceipt, nowShowingBadge, showingTile } from '../panelClaims';
import { panelPresence } from '../panelPresence';
import { pasteAction } from '../pasteLink';
import { activeTileKey, showTile } from '../showTile';
import { ownsBytes } from '../surface';
import { PHONE_QUERY, useNarrow } from '../useNarrow';
import { useSync } from '../useSync';

import { ConfirmSheet } from './ConfirmSheet';
import { RemoteAdd } from './RemoteAdd';
import { RemoteLibrary } from './RemoteLibrary';
import { TreatedArt } from './TileArt';

import type { PanelPresence } from '../panelPresence';
import type { ConfigRuntime } from '../runtime';

/**
 * Library — **your library, and nothing else**.
 *
 * The page this replaces was organised like the code rather than like a shelf:
 * "Add a video" at the top, "Downloading now" as its own section, "Your clips"
 * under that, and "Add a file by hand" at the bottom. A clip you had just asked
 * for therefore lived in a different section from the clips you already had,
 * and jumped between them the moment it finished. Two of the four sections were
 * ways of PUTTING something here, which is not what a library is.
 *
 * So: one grid of what you have — clips and pictures together, badged by kind —
 * and one **+** in the corner for adding. A download in flight is a tile in that
 * grid with its progress drawn on it, and when it completes it becomes an
 * ordinary tile in the same slot (`libraryItems.buildLibraryTiles` keeps the
 * ordering stable across the transition). A download that could not be kept is
 * a tile too, in the same honest words the home screen uses — a missing copy is
 * never a video that failed to play.
 *
 * The add panel's link path goes through `pasteAction` — the ONE mapping every
 * link field in the product reads (round 6, C1). It called `submitVideoLink`
 * directly until then, which is the same defect on a different screen: with
 * **Image** on the panel, a `.jpg` pasted here landed in `modules.video.cfg.url`
 * and silently switched the active module to video. Going through the mapping
 * also keeps what the round-5 note below was about — both surfaces honour
 * `downloadMode` and the display does the fetching (CAM's two browsers share
 * one storage partition; a phone and an ordinary tab do not —
 * design-videoEngine.md §5.1).
 *
 * The FILE path stays local to this window, because the bytes are here, and it
 * keeps its own kind-routing: what a file IS is a question about its bytes, not
 * about what the panel happens to be showing.
 */

const PCT = 100;
const PCT_DECIMALS = 0;
/** The quota warning earns its orange above this much of the budget in use. */
const QUOTA_WARN_PCT = 50;
const POLL_MS = 1000;

/**
 * How much room something takes, in the quota meter's own sentence.
 *
 * The number comes from `lib/bytes` — the ONE formatter (round 5, minors); this
 * function is only the prose around it. An empty library reported "0.0 MB of
 * 4096.0 MB used", which is false precision in both halves (design audit, F10):
 * nothing stored says *nothing*, and it says it in a word rather than in a
 * quantity that rounds to zero.
 */
function mb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'nothing';
  return formatBytes(bytes);
}

/**
 * The object URL is created during render and revoked when the blob changes or
 * the tile unmounts. Creating it in an effect instead would need a `setState`
 * inside that effect, which cascades a render for every tile in the library.
 *
 * `null` is not a hole: it is the treated card `TreatedArt` draws, which is the
 * same fallback language the home screen's halo uses for a source with no
 * poster. A grey rectangle is what the audit found on more than half the shelf.
 */
function ClipThumb({ blob, name }: { blob: Blob | null; name: string }) {
  const url = useMemo(() => (blob === null ? null : URL.createObjectURL(blob)), [blob]);
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url === null) return <TreatedArt name={name} />;
  return <img className="kh-tile__thumb" src={url} alt="" />;
}

/**
 * Clips whose thumbnail we have already tried to generate, this page load.
 *
 * Module-level rather than component state on purpose: `refresh()` re-reads
 * IndexedDB and rebuilds every tile, so per-component state would re-arm the
 * generation on every poll for a clip whose frame genuinely cannot be drawn —
 * which is a decoder spun up once a second, forever.
 */
const thumbAttempted = new Set<string>();

/**
 * Focus the rename input the moment it appears.
 *
 * A stable module-level callback ref rather than `autoFocus`: the prop is a
 * blunt instrument the a11y lint rightly refuses (it steals focus on page load,
 * where nobody asked for it), while this only ever runs when the input is
 * mounted — which happens exactly because somebody pressed **Rename**.
 */
function focusOnMount(el: HTMLInputElement | null): void {
  el?.focus();
}

/**
 * A clip stored without a thumbnail, thumbnailed on first sight (R7).
 *
 * Two paths leave `thumbBlob: null` behind — "Add anyway" after a probe
 * timeout, and a download whose bytes arrived before a frame could be drawn —
 * and the tile was a grey rectangle for the life of the clip. The frame is
 * generated here with the same `makeThumbnail` both ingest paths use, so a
 * backfilled tile is pixel-identical to one that worked first time, and it is
 * written back through `setClipThumb` so the next visit costs nothing.
 *
 * A failure is not retried and not an error: some files simply have no frame
 * this decoder can draw, and the treated card is a perfectly good answer.
 */
function GeneratedThumb({
  id,
  name,
  durationSec,
}: {
  id: string;
  name: string;
  durationSec: number;
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    if (thumbAttempted.has(id)) return undefined;
    thumbAttempted.add(id);
    // Read through a function so TypeScript cannot narrow it across an await —
    // the same trick `useSync` and `ModuleHost` use for their teardown flags.
    // A plain boolean (or a cell) narrows to `true` after the first check and
    // every guard after it becomes dead code the linter is right to flag.
    let gone = false;
    const isGone = (): boolean => gone;
    void (async () => {
      const bytes = await getClipBlob(id);
      if (isGone() || bytes === null) return;
      const thumb = await makeThumbnail(bytes, durationSec);
      if (isGone() || thumb === null) return;
      setBlob(thumb);
      await setClipThumb(id, thumb);
    })();
    return () => {
      gone = true;
    };
  }, [id, durationSec]);
  return <ClipThumb blob={blob} name={name} />;
}

/**
 * A picture stored before C3, thumbnailed on first sight — the exact mirror of
 * `GeneratedThumb`, and now for the exact same reason.
 *
 * "A picture is its own thumbnail" was true and cheap in one window with a short
 * shelf; it is a full decode of a multi-megapixel file per tile, on every visit,
 * once the shelf is long. Pictures ingested from C3 onwards carry a 320-edge
 * WebP and never reach this component at all — this is the backfill for the ones
 * already on disk, done once per picture and written back.
 */
function ImageThumb({ id, name }: { id: string; name: string }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    // Read through a function so TypeScript cannot narrow it across an await.
    let gone = false;
    const isGone = (): boolean => gone;
    void (async () => {
      const bytes = await getImageBlob(id);
      if (isGone() || bytes === null) return;
      const thumb = await makeImageThumbnail(bytes);
      // A picture this decoder cannot draw still shows: the full blob is a
      // perfectly good `<img>` source, it is only an expensive one.
      setBlob(thumb ?? bytes);
      if (thumb === null || thumbAttempted.has(id)) return;
      thumbAttempted.add(id);
      await setImageThumb(id, thumb);
    })();
    return () => {
      gone = true;
    };
  }, [id]);
  return <ClipThumb blob={blob} name={name} />;
}

/**
 * A line under the head — and, for the ones that are receipts, a claim.
 *
 * Round 5's S4. *"Added “dunes.mp4”."* is not a status, it is an ASSERTION
 * about the shelf: that shelf now contains a thing called dunes.mp4. The page
 * printed it and then never revisited it, so deleting the file left the
 * assertion standing directly above **Nothing kept here** — and a delete
 * performed from the PHONE left it standing in CAM for the rest of the session,
 * with nobody in the room who could have known it was wrong.
 *
 * A receipt therefore retires two ways, and it needs both:
 *
 *  - **it lingers**, on `RECEIPT_LINGER_MS`, the home screen's number, because
 *    narration that never ends becomes furniture (round 2's R11);
 *  - **it is void the moment its subject leaves the shelf**, which no timer can
 *    know. `claim` names that subject, and it is reconciled against the tiles
 *    themselves — the same list the grid draws, refreshed by the same
 *    `storage` event a remote delete arrives on — rather than against a
 *    guess about how long a delete takes.
 *
 * `claim` is absent for the messages that are not receipts: an error the user
 * may want to act on, and the link receipt, whose subject does not exist yet
 * (the display has not fetched it).
 */
interface Message {
  tone: 'error' | 'warn' | 'ok';
  text: string;
  /** The shelf entry this message asserts something about, by name. */
  claim?: string;
}

/**
 * The Library, for a window that cannot reach one — round 11's M-c.
 *
 * There is exactly one Kraken and exactly one library, and it lives where the
 * bytes are (`surface.ts`). A window that neither owns those bytes nor is
 * paired to the window that does has no shelf to draw: `LibraryView`'s unowned
 * branch renders `RemoteLibrary` off the WIRE, and with no room there is no
 * wire.
 *
 * What used to happen was a redirect: `#/library` mounted `RemoteView` and
 * rewrote the hash to `#/remote` a tick later. So the route lied twice over —
 * the breadcrumb read "Your Kraken / Remote" over a page the user had asked for
 * by another name, the address they had bookmarked was silently replaced, and
 * the remote screen's own composition (a ring, a pairing card, a QR) overflowed
 * a 866x537 window by 234 px, because it was never laid out to arrive there.
 *
 * A route that exists answers for itself. This is that answer: the shelf's own
 * page, saying where the shelf is and offering the one thing that would put it
 * within reach. The breadcrumb stays "Library", the hash stays `#/library`, and
 * the composition is three lines and a button — page-fit 0 at CAM's window.
 */
export function LibraryElsewhere() {
  return (
    <section className="kh-library" data-testid="library" data-owns="false" data-reach="none">
      <div className="kh-library__head">
        <p className="kh-hint" data-testid="library-lede">
          Your library lives on your Kraken.
        </p>
      </div>
      <div className="kh-panel" data-testid="library-unreachable">
        <p>
          The shelf is a property of the machine, not of this window: the clips and pictures{' '}
          {IN_YOUR_LIBRARY} are kept beside the Kraken, on the PC with CAM on it, so that the
          network can be unplugged.
        </p>
        {/*
          One way forward, and it is the real one: this window is not CAM's, so
          the only route to that shelf is a pairing. `Remote` is where a pairing
          is made, and it is the page the redirect used to dump people on
          without telling them why.
        */}
        <p className="kh-hint">
          This window is not paired with one yet. Pair it and the same shelf appears here, over the
          wire.
        </p>
        <a className="kh-btn kh-btn--primary" href="#/remote" data-testid="library-pair">
          Pair with your Kraken
        </a>
      </div>
    </section>
  );
}

export function LibraryView({ runtime }: { runtime: ConfigRuntime }) {
  /**
   * The gate — A1, and the one item in this wave that is a BUG rather than a
   * design change.
   *
   * `#/library` was routed with no surface check at all, so a phone reached this
   * page and it read the PHONE's IndexedDB: an empty grid, a phone-storage quota
   * meter, a drop target, and a `Browse…` that really did ingest — into a store
   * the Kraken can never open. Two libraries, two databases, both reachable,
   * and the one with a working Add button was the wrong one.
   *
   * So one boolean decides two things, and only two:
   *
   *  - **where the shelf comes from** — this window's database when it owns the
   *    bytes, the wire when it does not. Same builder, same tiles either way;
   *  - **which controls exist** — a window that cannot hold bytes renders no
   *    file picker, no drop target, no quota meter and no persistence chip,
   *    because every one of them is a promise it cannot keep.
   *
   * Everything else on this page is deliberately identical between the two.
   */
  const owns = ownsBytes(runtime);
  const sync = useSync(runtime);
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [downloads, setDownloads] = useState<DownloadEntry[]>(() => [
    ...listDownloads(),
    ...readMirroredDownloads(),
  ]);
  /** Failed jobs the user has waved away. Local to this view, by design: the
   * mirror is a ring the display owns, and dismissing a card here must not
   * rewrite the other window's record of what happened. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState('');
  /** The module this draft belongs to — see `RemoteAdd`'s note on the rule. */
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  /**
   * The file behind an "Add anyway" offer.
   *
   * `ingest.ts` has always said *"use 'Add anyway' to store it as-is"* when a
   * file's metadata does not arrive inside eight seconds, and for the whole of
   * the design audit that button did not exist anywhere in the product (F5.1):
   * a real error naming an unreachable remedy. `ingestBlob` already takes
   * `force`, so the remedy was one button away — and storing as-is is genuinely
   * useful, because a file whose duration `<video>` refuses to report usually
   * plays perfectly well.
   */
  const [forceable, setForceable] = useState<File | null>(null);
  /** The tile whose name is being edited, and the name so far. */
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  /**
   * The tile a Delete press is asking about — round 6's CAM parity.
   *
   * This shelf deleted on the press for three waves while the phone's shelf
   * asked first, on the argument that in CAM the row and the finger are in the
   * same room. They are; the undo is not. See `./ConfirmSheet`.
   */
  const [confirming, setConfirming] = useState<LibraryTile | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const addInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    // Never on a window that does not own the bytes: reading this browser's
    // IndexedDB there is what produced the second, empty library.
    if (!owns) return;
    void listClips().then(setClips);
    void listImages().then(setImages);
    void readQuota().then(setQuota);
  }, [owns]);

  /**
   * A signature of what the jobs ARE, ignoring how many bytes have landed.
   *
   * The grid re-reads IndexedDB when a job changes state, never on every
   * progress tick: `listClips()` hands back freshly structured-cloned `Blob`s,
   * so re-reading at 1 Hz would mint and revoke an object URL per thumbnail per
   * second and the whole shelf would flicker while one video downloaded.
   */
  const jobSig = useRef('');
  const syncJobs = useCallback(
    (all: readonly DownloadEntry[]) => {
      const merged = mergeDownloads(all, readMirroredDownloads());
      setDownloads(merged);
      const sig = merged.map((d) => `${d.id}:${d.state}:${d.clipId ?? ''}`).join('|');
      if (sig !== jobSig.current) {
        jobSig.current = sig;
        refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!owns) return undefined;
    refresh();
    // Live progress for a download running in the OTHER window (the display
    // does the downloading) plus anything started from this page.
    const stop = subscribeDownloads(syncJobs);
    const poll = setInterval(() => {
      syncJobs(listDownloads());
    }, POLL_MS);
    // The other window publishes both indexes through localStorage when it
    // stores or deletes something.
    const onStorage = (): void => {
      refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      stop();
      clearInterval(poll);
      window.removeEventListener('storage', onStorage);
    };
  }, [owns, refresh, syncJobs]);

  const state = runtime.store.getSnapshot();
  const videoCfg = validateVideoConfig(state.modules[videoModule.id]?.cfg);
  const imageCfg = validateImageConfig(state.modules[imageModule.id]?.cfg);
  const activeKey = activeTileKey(state.activeModuleId, videoCfg.url, localImageId(imageCfg.url));

  /**
   * The add panel's link row, in the ACTIVE module's own noun — C1.
   *
   * `null` for Clock and Stats: the row becomes the quiet switch every other
   * link surface shows, rather than a field asking for a video link with a
   * clock on the panel.
   */
  const action = pasteAction(runtime, state.activeModuleId);
  if (draftOwner !== state.activeModuleId) {
    setDraftOwner(state.activeModuleId);
    setDraft(action === null || action.clearOnAccept ? '' : action.value);
    /*
      The MESSAGE is deliberately left alone.

      Pressing a tile commits `activeModuleId` — that is what showing a picture
      after a video IS — so clearing the notice here would delete the receipt
      the same gesture had just produced. The draft belongs to a module; the
      receipt belongs to the act.
    */
  }

  /**
   * What this window may claim about the Kraken — C5.
   *
   * Two sources, whichever this window has: the latch CAM writes when the
   * display page publishes anything, and — for a window driving the shelf over
   * a room — the telemetry that has actually arrived.
   *
   * The clock is deliberately `0` ("not sampled"). This page makes no claim in
   * the present tense — the only thing it asks presence is whether a Kraken has
   * ever been on the other end, which `panelIsKnown` answers without one — and
   * calling `Date.now()` during render would make this component
   * non-idempotent for a number nothing here reads.
   */
  const presence = panelPresence(
    {
      everSeen: hasDisplayBeenSeen() || sync.lastTele !== null,
      lastSeenAt: sync.lastTele?.at ?? null,
    },
    0,
  );

  /**
   * The remote branch mounts the same **Add** panel the phone remote does, so it
   * hands it the same two page-level facts: the window's width (for the
   * placeholder) and the panel's open state, which this page already tracked for
   * its own `+` button.
   */
  const narrow = useNarrow(PHONE_QUERY);

  /**
   * ONE shelf, from whichever source this window can actually see — A2.
   *
   * `buildLibraryTiles` is the same pure function on both branches, fed the same
   * structural shape, so a tile drawn on a phone and the tile drawn in CAM for
   * the same clip are the same tile by construction rather than by discipline.
   * The display has published this packet for two milestones; the remote used to
   * latch it and render exactly one string out of it.
   */
  const wireLibrary = sync.library?.body ?? null;
  const tiles = useMemo(
    () => buildLibraryTiles({ clips, images, downloads, dismissed }),
    [clips, images, downloads, dismissed],
  );

  /**
   * A receipt is void the moment its subject leaves the shelf — S4.
   *
   * The reconciliation is against `tiles`, the list the grid itself draws, so
   * every route a row can disappear by is covered by construction: a delete in
   * this window, a delete performed from the phone (which arrives as the
   * display's `storage` write and lands here through `refresh()`), and an
   * eviction. There is no timer racing a database here — the claim is simply
   * checked against what is true.
   */
  const standing =
    message?.claim === undefined || tiles.some((t) => t.name === message.claim) ? message : null;

  /**
   * …and it lingers, on the home screen's clock, even while it stays true.
   *
   * Only `ok`. A warning or an error is something the user may still want to
   * act on — "Add anyway" is literally rendered underneath one — and a remedy
   * that vanishes after four seconds is worse than no remedy. The timer is what
   * finally clears the *state*; the derivation above is what clears the
   * *claim*, on the render after the shelf changed, with no timer in between.
   */
  useEffect(() => {
    if (message?.tone !== 'ok') return undefined;
    const timer = setTimeout(() => {
      setMessage(null);
    }, RECEIPT_LINGER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [message]);

  const show = (tile: LibraryTile): void => {
    if (tile.id === null) return;
    // The shared commit (`showTile`), so a tile does the same thing whichever
    // window it was tapped in — see A3.
    showTile(runtime.store, tile);
    /*
      The receipt asks before it claims a screen — round 6, the C2 family.

      *"“dunes.mp4” is on your Kraken."* was printed on the strength of a state
      commit, which is evidence that the app decided something and none at all
      that a Kraken heard it. Same question, same answer, as the ladder on the
      home screen: `panelPresence`.
    */
    setMessage({ tone: 'ok', text: showingTile(presence, tile.name), claim: tile.name });
  };

  const togglePin = (tile: LibraryTile): void => {
    if (tile.id === null) return;
    const id = tile.id;
    if (tile.kind === 'clip') void setPinned(id, !tile.pinned).then(refresh);
    else void setImagePinned(id, !tile.pinned).then(refresh);
  };

  const remove = (tile: LibraryTile): void => {
    setConfirming(null);
    if (tile.id === null) return;
    const id = tile.id;
    if (tile.kind === 'clip') void deleteClip(id).then(refresh);
    else void deleteImage(id).then(refresh);
  };

  /**
   * Renaming, from the window that holds the row.
   *
   * The same act the remote asks for with `renameMedia`, done directly because
   * this window can. Both shelves carry it, in the same place, spelt the same
   * way — a capability one surface has and the other does not is how "the
   * library is different" starts again.
   */
  const commitRename = (tile: LibraryTile, next: string): void => {
    const id = tile.id;
    const clean = next.trim();
    setRenaming(null);
    if (id === null || clean.length === 0 || clean === tile.name) return;
    if (tile.kind === 'clip') void renameClip(id, clean).then(refresh);
    else void renameImage(id, clean).then(refresh);
  };

  const dismiss = (entry: DownloadEntry): void => {
    setDismissed((prev) => new Set([...prev, entry.id]));
  };

  /**
   * Retry fetches from THIS window rather than re-committing the source.
   *
   * The link is already the configured source — committing it again is a no-op
   * the display would never notice. The Configuration Browser shares CAM's
   * storage partition, so a copy it fetches is a copy the LCD can read.
   */
  const retry = (entry: DownloadEntry): void => {
    setMessage(null);
    setDismissed((prev) => new Set([...prev, entry.id]));
    void downloadToClip(entry.sourceUrl, { provider: detect(entry.sourceUrl).provider }).then(
      (result) => {
        refresh();
        if (!result.ok) setMessage({ tone: 'warn', text: failureLine(result.entry, presence) });
      },
    );
  };

  const addLink = (): void => {
    if (action === null) return;
    const outcome = action.submit(draft);
    if (outcome.issue !== null) {
      setMessage({
        tone: outcome.issue.severity === 'error' ? 'error' : 'warn',
        text: outcome.issue.message,
      });
    } else {
      setMessage(null);
    }
    if (outcome.accepted) {
      if (action.clearOnAccept) setDraft('');
      setAddOpen(false);
      /*
       * Truthful about WHO does the fetching, and therefore about when a tile
       * appears.
       *
       * The old line — "progress shows on its tile" — was printed directly above
       * "Nothing saved yet", with no tile anywhere (design audit, F5.3). It was
       * not a race: the DISPLAY does the downloading, because CAM's two browser
       * windows share one storage partition and the copy has to land in the one
       * the LCD reads. So if CAM is not running there is no tile, and there will
       * not be one, and the message has to say so.
       */
      setMessage({ tone: 'ok', text: linkReceipt(presence) });
    }
  };

  /**
   * Both kinds, on the surface that owns the bytes.
   *
   * This picker accepted `video/mp4,video/webm,video/quicktime` and sent every
   * file it got to the video ingest, on a page whose grid renders pictures and
   * whose **+** button has always been labelled *"Add a video or a picture"* —
   * while the phone's Add, on the surface that owns NOTHING, accepted both. That
   * is fork 3's asymmetry (kind is a property, not a place) surviving in the one
   * control where it is most visible: the only routes to a picture in CAM were a
   * URL or a transfer from a phone in the same room.
   *
   * The routing is `isPictureFile`, the same function the LAN transfer's receiver
   * has used since wave 3 — mime first, extension as the fallback, because a file
   * picked out of a document provider genuinely arrives with an empty type — and
   * the two destinations are the same two ingests, so there is still exactly one
   * way a byte becomes a row. It is reached through the dynamic import the
   * transfer chunk already lives behind, so the configuration UI does not gain a
   * static dependency on `src/transfer` for a fourteen-line predicate.
   *
   * A picture has no `force`: "Add anyway" answers a video probe that timed out,
   * and `ingestImageBlob` either decodes the bytes or does not.
   */
  const addFiles = (files: FileList | null, opts: { force?: boolean } = {}): void => {
    if (files === null || files.length === 0) return;
    setMessage(null);
    setForceable(null);
    /*
     * Copied out SYNCHRONOUSLY, before anything awaits.
     *
     * A `FileList` is a live view of the input, and the change handler clears
     * `e.target.value` the moment this function returns — so the list is empty by
     * the time any `await` resumes. It used to survive by accident: the first
     * await was inside the loop, so the spread had already happened. Adding one
     * await above the loop silently added nothing at all to the library, with no
     * error anywhere, which is a good argument for not relying on the accident.
     */
    const chosen = [...files];
    void (async () => {
      const { isPictureFile } = await import('../../../transfer/protocol');
      for (const file of chosen) {
        if (isPictureFile(file.name, file.type)) {
          const picture = await ingestImageBlob(file, file.name);
          setMessage(
            picture.ok
              ? { tone: 'ok', text: `Added “${file.name}”.`, claim: file.name }
              : {
                  tone: 'error',
                  text: picture.message ?? 'That file could not be added.',
                },
          );
          continue;
        }
        const result = await ingestFile(file, opts.force === true ? { force: true } : {});
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.message ?? 'That file could not be added.' });
          // The one failure the user can overrule: no metadata arrived, which
          // is not the same as "this is not a video".
          if (result.failure === 'probe-timeout') setForceable(file);
        } else if (result.warnings.length > 0) {
          setMessage({ tone: 'warn', text: result.warnings[0]?.message ?? '' });
        } else {
          setMessage({ tone: 'ok', text: `Added “${file.name}”.`, claim: file.name });
        }
      }
      await publishClipIndex();
      if (opts.force !== true) setAddOpen(false);
      refresh();
    })();
  };

  /** The remedy the error message has always named. */
  const addAnyway = (): void => {
    const file = forceable;
    if (file === null) return;
    setForceable(null);
    const bag = new DataTransfer();
    bag.items.add(file);
    addFiles(bag.files, { force: true });
  };

  const quotaPct =
    quota === null || quota.quotaBytes <= 0 ? null : (quota.usageBytes / quota.quotaBytes) * PCT;

  /*
   * When the storage warning is worth showing at all.
   *
   * "May be cleared if the disk fills up — pin the ones you care about" is a
   * true sentence about browser storage, and it was rendered in warning orange
   * next to "0.0 MB of 4096.0 MB used" on an EMPTY library, where there is
   * nothing to pin and nothing to lose (design audit, F10). The claim only
   * becomes actionable once something is actually stored, or once the quota is
   * genuinely under pressure — so that is when it is drawn.
   */
  const quotaMatters = tiles.length > 0 || (quotaPct !== null && quotaPct > QUOTA_WARN_PCT);

  /*
   * ONE remote shelf, not two.
   *
   * Wave 1 gave this page a wire-fed branch of its own so a phone reaching
   * `#/library` saw the real library instead of its own empty database. Wave 3
   * gives the shelf ACTIONS — pin, rename, delete, and an Add that hands the
   * Kraken a file over the LAN — and a second copy of those actions is exactly
   * how "the library is different" comes back: two shelves that look identical
   * and can do different things are still two shelves.
   *
   * So a window that does not own the bytes renders `RemoteLibrary`, the same
   * component the remote screen uses, inside this page's frame. The frame is
   * what the surface gate is about (`data-owns`, no file picker, no quota meter
   * for a disk the library does not live on); the shelf inside it is the shelf.
   *
   * Every hook above this line has already run, which is why the early return is
   * safe — and it is an early return rather than a ternary because the two
   * branches share almost nothing but the `<section>`.
   */
  if (!owns) {
    return (
      <section className="kh-library" data-testid="library" data-owns="false">
        <div className="kh-library__head">
          <p className="kh-hint" data-testid="library-lede">
            Everything {IN_YOUR_LIBRARY}.
          </p>
        </div>
        <RemoteLibrary
          store={runtime.store}
          wire={wireLibrary}
          packetAt={sync.library?.at ?? null}
          sendCmd={sync.sendCmd}
          activeModuleId={state.activeModuleId}
          videoUrl={videoCfg.url}
          imageId={localImageId(imageCfg.url)}
          presence={presence}
          add={
            <RemoteAdd
              runtime={runtime}
              sync={sync}
              presence={presence}
              narrow={narrow}
              open={addOpen}
              onOpenChange={setAddOpen}
            />
          }
        />
      </section>
    );
  }

  return (
    <section className="kh-library" data-testid="library" data-owns="true">
      <div className="kh-library__head">
        <div>
          {/*
            No heading here — A5, the six-names sweep.

            The shelf answered to six: Library, Your library, Your pictures, the
            shelf, the clip library, the clip picker. Six names is six shelves,
            which is the complaint. This page already carries its name in the
            sub-header two rows up (`SUBPAGE_TITLE`), so a second `<h2>` saying
            it differently was the duplication in its purest form.
          */}
          {/*
            The location, on the ONE surface where it constrains an action.

            "on this PC" is true and useful next to a file picker that can only
            reach this PC. It is referentless on a phone, which is why the remote
            branch above says nothing about machines at all.
          */}
          <p className="kh-hint" data-testid="library-lede">
            {`${KEPT_VERB.charAt(0).toUpperCase()}${KEPT_VERB.slice(1)}`} {COPY_HOME}, inside CAM’s
            own browser storage.
          </p>
        </div>
        <button
          type="button"
          className="kh-add"
          data-testid="library-add"
          aria-expanded={addOpen}
          aria-controls="kh-library-add"
          title={addOpen ? 'Close' : 'Add a video or a picture'}
          onClick={() => {
            setAddOpen((open) => !open);
            setMessage(null);
            // The panel is the point of the press; land the caret in it.
            window.setTimeout(() => addInput.current?.focus(), 0);
          }}
        >
          {/*
          A labelled button, not a glyph — and the label follows the glyph.

          The empty card underneath used to have to explain where this control
          was and what it did — "Add a link or a file with the button in the
          corner" — which is a caption for an icon that failed. A button that
          says Add needs no caption anywhere.

          With the panel open the + rotates into an ×, and round 3 caught the
          word underneath it still saying "Add": a close button labelled with
          the action it undoes, which is the same class of lie as F5.2's
          "Press + up there" printed next to an ×. The glyph and the word say
          the same thing in both states.
        */}
          <span aria-hidden="true">+</span>
          <span className="kh-add__lab">{addOpen ? 'Close' : 'Add'}</span>
        </button>
      </div>

      {addOpen && (
        <div
          className={dragOver ? 'kh-addpanel kh-addpanel--over' : 'kh-addpanel'}
          id="kh-library-add"
          data-testid="library-add-panel"
          // The WHOLE panel is the drop target — the old page had a separate
          // dashed rectangle inside a separate section, which is two boxes to
          // aim at for one gesture.
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            // Counter, not a boolean: `dragleave` fires for every child element.
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {action === null ? (
            /*
              Clock and Stats have nothing to be handed — the answer every other
              link surface gives, on the fourth one (C1). A file can still be
              dropped on the panel: bytes are a different question from what the
              panel is showing.
            */
            <p className="kh-addpanel__row">
              <button
                type="button"
                className="kh-quiet"
                data-testid="library-add-switch"
                onClick={() => {
                  runtime.store.commit((prev) => withBaseKind(prev, videoModule.id));
                  window.setTimeout(() => addInput.current?.focus(), 0);
                }}
              >
                Play something
              </button>
              <Button
                testId="library-browse"
                title="Choose a file on this PC"
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                Browse…
              </Button>
            </p>
          ) : (
            <form
              className="kh-addpanel__row"
              onSubmit={(e) => {
                e.preventDefault();
                addLink();
              }}
            >
              <input
                ref={addInput}
                className="kh-input"
                id="library-add-input"
                data-testid="library-add-input"
                type="text"
                value={draft}
                /* The spine's fingerprint — see `pasteLink.ts` and C1. */
                data-paste-field={action.moduleId}
                aria-label={action.label}
                placeholder={action.placeholder}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setMessage(null);
                }}
              />
              <button
                type="submit"
                className="kh-btn kh-btn--primary"
                data-testid="library-add-submit"
              >
                Add
              </button>
              <Button
                testId="library-browse"
                title="Choose a file on this PC"
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                Browse…
              </Button>
            </form>
          )}
          {/*
          One sentence about what the two paths DO.

          It ran to thirty words, and the back half of it — "square-cropped if
          you can, with the audio dropped" — is advice about editing a file
          before you get here, in a box whose whole job is to take the file you
          already have. Nothing in the app acts on it and nothing goes wrong if
          it is ignored. It lives in `docs/local-clips.md`, where somebody
          preparing clips is actually reading (round 3, minors).
        */}
          {/*
            It names both kinds, because the picker takes both.

            The sentence said "a file", above a picker that accepted three video
            containers, on a page whose grid draws pictures — so the one word
            doing the work was doing it wrong. Naming the two kinds is not the
            shelf explaining itself: it is the control saying what it will take.
          */}
          <p className="kh-hint">
            A link is fetched by your Kraken and kept here. A video or a picture is added straight
            from this PC.
          </p>
          <input
            ref={fileInput}
            data-testid="clip-file-input"
            type="file"
            accept="video/*,image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {standing !== null && <Notice tone={standing.tone}>{standing.text}</Notice>}

      {forceable !== null && (
        <div className="kh-row">
          <button
            type="button"
            className="kh-btn"
            data-testid="library-add-anyway"
            onClick={addAnyway}
          >
            Add anyway
          </button>
        </div>
      )}

      {tiles.length === 0 ? (
        <div className="kh-empty" data-testid="library-empty">
          {/*
            One verb, and no apology (round 4, F4 and the "…yet" sweep).

            This card said "Nothing saved yet", the header two rows up said
            things were **Kept** here, and the meter below said "Nothing stored
            yet" — three verbs for one act, within 200 px, plus two "yet"s
            apologising for a resting state that is simply what is true. The
            verb is `vocabulary.KEPT_VERB` on all three now, and an empty shelf
            describes itself in the present tense.
          */}
          <p className="kh-empty__title">{NOTHING_KEPT}</p>
          {/*
            One sentence, and it does not describe its own buttons.

            F5.2 killed "Press + up there" because the + becomes an × when the
            panel is open; round 2's R7 killed its replacement too, for a
            simpler reason — the button is labelled **Add** now, so a sentence
            explaining where the Add button is says strictly less than the
            button does. The promise underneath it — *plays with the network
            unplugged* — was ALSO printed in the header two lines above, on the
            same screen, at the same moment. It is said once, here, where there
            is nothing else to look at.
          */}
          <p className="kh-hint">{OFFLINE_PROMISE}</p>
        </div>
      ) : (
        <ul className="kh-grid" data-testid="library-grid">
          {tiles.map((tile) => (
            <Tile
              key={tile.key}
              tile={tile}
              owns={owns}
              active={tile.key === activeKey}
              activeLabel={nowShowingBadge(presence)}
              presence={presence}
              onShow={show}
              onPin={togglePin}
              onDelete={setConfirming}
              renamingDraft={renaming !== null && renaming.id === tile.id ? renaming.draft : null}
              onRenameStart={() => {
                if (tile.id !== null) setRenaming({ id: tile.id, draft: tile.name });
              }}
              onRenameDraft={(draft) => {
                setRenaming((current) => (current === null ? null : { ...current, draft }));
              }}
              onRenameCommit={() => {
                if (renaming !== null) commitRename(tile, renaming.draft);
              }}
              onRenameCancel={() => {
                setRenaming(null);
              }}
              onCancel={abortDownload}
              onRetry={retry}
              onDismiss={dismiss}
            />
          ))}
        </ul>
      )}

      {/*
        The quota meter and the persistence chip are claims about THIS browser's
        disk (A1). On a phone they measure storage the library does not live in,
        offer a remedy ("pin the ones you care about") for a pressure that is not
        the phone's, and imply the bytes are here. They are not drawn at all.

        …and round 6 found the OTHER half of the same rule half-applied. Round 2
        established `quotaMatters` — a meter is worth drawing once something is
        actually stored, or once the quota is genuinely under pressure — and
        then wired it to the CHIP only, leaving the bar and its label mounted
        unconditionally. So an empty library rendered "13 kB of 4.0 GB used"
        directly under **Nothing kept here**: two sentences about the same shelf,
        one saying it holds nothing and one quantifying what it holds. (The
        13 kB is the store's own overhead, which is why the `usageBytes <= 0`
        branch below never caught it — the shelf is empty and the database is
        not.) The rule now gates the block it was written for.
      */}
      {confirming !== null && (
        <ConfirmSheet
          testId="library-confirm-delete"
          question={`Delete “${confirming.name}” from your library?`}
          confirmLabel="Delete"
          confirmTitle="Delete it — there is no undo"
          keepTitle="Leave it alone"
          onConfirm={() => {
            remove(confirming);
          }}
          onCancel={() => {
            setConfirming(null);
          }}
        />
      )}

      {quotaMatters && (
        <div className="kh-quota" data-testid="library-quota">
          <Meter
            pct={quotaPct}
            label={
              quota === null || quota.quotaBytes <= 0
                ? 'space in use — unknown'
                : quota.usageBytes <= 0
                  ? `Nothing ${KEPT_VERB} — ${mb(quota.quotaBytes)} available`
                  : `${mb(quota.usageBytes)} of ${mb(quota.quotaBytes)} used`
            }
          />
          {/*
            ONE line, in one of two truthful states — and only one of them is a
            warning.

            The app has asked for persistent storage since M1 and then reported
            the answer as a green *"Kept for good"* chip next to an orange one,
            which is two badges for one boolean. Worse, the orange one is what a
            real CAM install almost never earns: CAM's webview GRANTS the
            request (the diagnostics report reads `persisted: true` there), and
            `ensurePersisted` now asks on every add rather than once on the
            first, so the grant is held wherever it can be. A promise being kept
            is not news, so the granted state is a quiet line rather than a
            badge; the warning keeps its tone, because it is one.

            `persisted` is `navigator.storage.persisted()`, read fresh with the
            quota — never a flag this app wrote down (see `platform/idb`).
          */}
          {quota?.persisted === true ? (
            <p className="kh-hint" data-testid="storage-persisted">
              {KEPT_SAFELY}
            </p>
          ) : (
            <Chip tone="warn" testId="storage-evictable">
              May be cleared if the disk fills up — pin the ones you care about
            </Chip>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One thing on the shelf, whatever state it is in.
 *
 * The three states share a frame on purpose: a download in flight is the same
 * object as the clip it becomes, so it gets the same tile, in the same slot,
 * with progress drawn over the space its thumbnail will occupy.
 */
function Tile({
  tile,
  owns,
  active,
  activeLabel,
  presence,
  onShow,
  onPin,
  onDelete,
  onCancel,
  onRetry,
  onDismiss,
  renamingDraft,
  onRenameStart,
  onRenameDraft,
  onRenameCommit,
  onRenameCancel,
}: {
  tile: LibraryTile;
  /** Whether this window can act on the bytes, not merely name them. */
  owns: boolean;
  active: boolean;
  /** What the badge says — "On screen", or the truth (`nowShowingBadge`). */
  activeLabel: string;
  /**
   * What this window may claim about the panel.
   *
   * The tile's failure line ends in one — *"…so your Kraken is playing it from
   * the link"* — and `failureLine` cannot be called without it (round 7).
   */
  presence: PanelPresence;
  onShow: (tile: LibraryTile) => void;
  onPin: (tile: LibraryTile) => void;
  onDelete: (tile: LibraryTile) => void;
  onCancel: (id: string) => void;
  onRetry: (entry: DownloadEntry) => void;
  onDismiss: (entry: DownloadEntry) => void;
  /** The in-progress new name, or `null` when this tile is not being renamed. */
  renamingDraft: string | null;
  onRenameStart: () => void;
  onRenameDraft: (draft: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  const entry = tile.download;
  const pct = entry === null ? null : progressPct(entry);

  return (
    <li
      className={active ? 'kh-tile kh-tile--active' : 'kh-tile'}
      data-testid="library-tile"
      data-tile-kind={tile.kind}
      data-tile-state={tile.state}
      {...(tile.kind === 'clip' && tile.state === 'ready' && tile.id !== null
        ? { 'data-clip-id': tile.id }
        : {})}
      {...(tile.kind === 'image' && tile.id !== null ? { 'data-image-id': tile.id } : {})}
    >
      <div className="kh-tile__art">
        {/*
          Every state gets the same picture language (round 3, F8).

          Round 2 gave STORED clips a generated frame with a treated hue-card
          behind it, and left the other two states rendering a bare
          `.kh-tile__thumb` — which at grid size is a ~400 px black rectangle.
          The two tiles a user looks at hardest, because something is happening
          or something went wrong, were the two with nothing on them. A download
          has a name from the moment it starts, so it has a treated card from
          the moment it starts; the progress and the failure line are drawn ON
          it rather than instead of it.
        */}
        {/*
          A window that cannot reach the bytes draws the SAME art, computed
          rather than shipped (A4) — but it does it in `RemoteLibrary` now, which
          this page renders wholesale on a remote surface (wave 3). This tile is
          the OWNING window's, so it always has a database to read a frame from.
        */}
        {tile.state === 'ready' ? (
          /*
            One branch on the STORED thumbnail, not on the kind (C3).

            A picture used to be its own thumbnail — the tile read the full blob
            back — which is a decode of a multi-megapixel file to paint a 160 px
            square, forty times, on a page that also drives the panel. Pictures
            carry a 320-edge WebP at ingest now, exactly as clips do, so both
            kinds take the same first branch and the kind only decides how a
            MISSING one is backfilled.
          */
          tile.thumbBlob !== null ? (
            <ClipThumb blob={tile.thumbBlob} name={tile.name} />
          ) : tile.kind === 'image' && tile.id !== null ? (
            <ImageThumb id={tile.id} name={tile.name} />
          ) : tile.id !== null ? (
            <GeneratedThumb id={tile.id} name={tile.name} durationSec={tile.durationSec ?? 0} />
          ) : (
            <ClipThumb blob={tile.thumbBlob} name={tile.name} />
          )
        ) : (
          <TreatedArt name={tile.name} />
        )}

        {tile.state === 'ready' && (
          <button
            type="button"
            className="kh-tile__hit"
            data-testid="tile-show"
            onClick={() => {
              onShow(tile);
            }}
          >
            <span className="kh-sr">{`Show “${tile.name}” on the display`}</span>
          </button>
        )}

        {tile.state === 'downloading' && (
          <div className="kh-tile__progress" data-testid="tile-progress">
            <span className="kh-tile__pct kh-tnum">
              {pct === null
                ? formatBytes(entry?.receivedBytes ?? 0)
                : `${pct.toFixed(PCT_DECIMALS)}%`}
            </span>
            <Meter pct={pct} />
          </div>
        )}

        {/*
          No kind badge.

          Every tile in the library carried a small uppercase CLIP or IMAGE in
          its corner, over the one part of the tile that is genuinely
          informative — the picture. The distinction is real and it is already
          drawn: a clip has a duration on its detail line and a picture does
          not. Machine-typed labels over the artwork are the shelf explaining
          itself instead of showing itself (round 2, R7).
        */}
        {active && (
          <span className="kh-tile__on" data-testid="tile-active">
            {activeLabel}
          </span>
        )}
      </div>

      <div className="kh-tile__meta">
        {renamingDraft === null ? (
          <div className="kh-tile__name" title={tile.name}>
            {tile.name}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRenameCommit();
            }}
          >
            <input
              className="kh-input"
              data-testid="tile-rename-input"
              aria-label={`New name for “${tile.name}”`}
              value={renamingDraft}
              ref={focusOnMount}
              onChange={(e) => {
                onRenameDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onRenameCancel();
              }}
            />
          </form>
        )}
        <div className="kh-tile__detail">
          {/*
            The app's one vocabulary, on the surface that was still speaking its
            own (round 3, F7). This line read "Saving to your Kraken…" — a third
            verb for the thing the home screen calls "Keeping a copy", and a
            destination the copy never goes to: the bytes land in CAM's storage
            on this PC, which is what the Kraken then reads.
          */}
          {tile.state === 'failed'
            ? failureLine(entry, presence)
            : tile.state === 'downloading'
              ? KEEPING_A_COPY_NOW
              : tileDetail(tile)}
          {tile.state === 'ready' && tile.pinned ? ' · pinned' : ''}
        </div>
      </div>

      {/*
        Curation is an act on bytes, so it belongs to the window that holds them
        — for now. Pin, delete, cancel, retry and dismiss all write to a store a
        remote cannot reach, and a button that silently writes to the wrong
        database is worse than no button. What every window CAN do is play, and
        that is a state commit, which already travels.
      */}
      <div className="kh-tile__actions">
        {owns && tile.state === 'ready' && renamingDraft === null && (
          <>
            <Button
              testId="tile-pin"
              title={
                tile.pinned
                  ? 'Allow this to be cleared when the disk fills up'
                  : 'Never clear this automatically'
              }
              onClick={() => {
                onPin(tile);
              }}
            >
              {tile.pinned ? 'Unpin' : 'Pin'}
            </Button>
            {/*
              Rename, on both shelves (wave 3).

              The name is the one thing on a tile a person chose, and it was
              whatever the file happened to be called when it arrived — for a
              downloaded clip, frequently a hash. The remote asks for this with
              `renameMedia`; this window simply does it, because it holds the row.
            */}
            <Button testId="tile-rename" title={`Rename “${tile.name}”`} onClick={onRenameStart}>
              Rename
            </Button>
            <Button
              testId="tile-delete"
              title={`Delete “${tile.name}”`}
              onClick={() => {
                onDelete(tile);
              }}
            >
              Delete
            </Button>
          </>
        )}
        {owns && tile.state === 'ready' && renamingDraft !== null && (
          <>
            <Button testId="tile-rename-save" title="Save the new name" onClick={onRenameCommit}>
              Save
            </Button>
            <Button testId="tile-rename-cancel" title="Keep the old name" onClick={onRenameCancel}>
              Cancel
            </Button>
          </>
        )}
        {owns && tile.state === 'downloading' && entry !== null && (
          <Button
            testId="tile-cancel"
            title="Stop this download"
            onClick={() => {
              onCancel(entry.id);
            }}
          >
            Cancel
          </Button>
        )}
        {owns && tile.state === 'failed' && entry !== null && (
          <>
            <Button
              testId="tile-retry"
              title="Try the download again"
              onClick={() => {
                onRetry(entry);
              }}
            >
              Retry
            </Button>
            <Button
              testId="tile-dismiss"
              title="Hide this"
              onClick={() => {
                onDismiss(entry);
              }}
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * This window's own jobs plus the other window's mirror, by id, newest first.
 *
 * The page used to prefer one list wholesale over the other, which meant a
 * retry started here hid a download the display was already running (and vice
 * versa). An entry this window owns wins on conflict: it is live rather than a
 * throttled snapshot.
 */
function mergeDownloads(
  primary: readonly DownloadEntry[],
  secondary: readonly DownloadEntry[],
): DownloadEntry[] {
  const byId = new Map<string, DownloadEntry>();
  for (const entry of secondary) byId.set(entry.id, entry);
  for (const entry of primary) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}
