import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { COPY_HOME, KEEPING_A_COPY_NOW } from '../../../config/vocabulary';
import { imageModule } from '../../../modules/image';
import {
  deleteImage,
  getImageBlob,
  listImages,
  setImagePinned,
  type ImageRecord,
} from '../../../modules/image/imageStore';
import { localImageId, localImageUrl, validateImageConfig } from '../../../modules/image/schema';
import { videoModule } from '../../../modules/video';
import {
  deleteClip,
  getClipBlob,
  publishClipIndex,
  readQuota,
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
import { LOCAL_CLIP_SCHEME } from '../../../modules/video/routing/patterns';
import { validateVideoConfig } from '../../../modules/video/types';
import { withModuleConfig } from '../../../state/selectors';
import { Button, Chip, Meter, Notice } from '../../../ui';
import { failureLine } from '../homeState';
import { buildLibraryTiles, formatBytes, tileDetail, type LibraryTile } from '../libraryItems';
import { submitVideoLink } from '../pasteLink';

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
 * The add panel's link path goes through `submitVideoLink`, the same function
 * the home screen's paste row calls, so both surfaces honour `downloadMode` and
 * the display does the fetching (CAM's two browsers share one storage
 * partition; a phone and an ordinary tab do not — design-videoEngine.md §5.1).
 * The file path stays local to this window, because the bytes are here.
 */

const PCT = 100;
const PCT_DECIMALS = 0;
const BYTES_PER_MB = 1_048_576;
const MB_DECIMALS = 1;
/** Below this a tenth of a megabyte is real information; above it, it is noise. */
const TENTHS_BELOW_MB = 10;
/** The quota warning earns its orange above this much of the budget in use. */
const QUOTA_WARN_PCT = 50;
const POLL_MS = 1000;

/**
 * Megabytes, without inventing a decimal place that means nothing.
 *
 * An empty library reported "0.0 MB of 4096.0 MB used" — false precision in
 * both halves (design audit, F10). Nothing stored says *nothing*, and a whole
 * number of megabytes is rendered as one.
 */
function mb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'nothing';
  if (bytes < BYTES_PER_MB) return 'under 1 MB';
  const value = bytes / BYTES_PER_MB;
  return `${value < TENTHS_BELOW_MB ? value.toFixed(MB_DECIMALS) : String(Math.round(value))} MB`;
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
 * What a tile shows when there is no picture to show — and there never will be.
 *
 * Flat, quiet, and derived from the name so two clips never look identical: the
 * initial plus a hue rotation off a cheap string hash. It is not decoration, it
 * is the difference between "three grey squares" and "three things I can tell
 * apart".
 */
function TreatedArt({ name }: { name: string }) {
  const trimmed = name.trim();
  // `codePointAt` rather than `[0]`, so a name that starts outside the BMP
  // renders one character instead of half a surrogate pair.
  const first = trimmed.codePointAt(0);
  const initial = first === undefined ? '?' : String.fromCodePoint(first).toUpperCase();
  let hash = 0;
  for (const ch of trimmed) hash = (hash * HUE_MIX + (ch.codePointAt(0) ?? 0)) % HUE_STEPS;
  return (
    <div
      className="kh-tile__thumb kh-tile__thumb--treated"
      data-testid="tile-treated"
      style={{ '--kh-tile-hue': `${String(hash)}deg` } as CSSProperties}
    >
      <span aria-hidden="true">{initial}</span>
    </div>
  );
}

/** Small odd multiplier plus a full turn of hue: cheap, stable, no collisions that matter. */
const HUE_MIX = 31;
const HUE_STEPS = 360;

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
 * Pictures have no stored thumbnail — they ARE their own thumbnail, and they
 * are kilobytes rather than megabytes, so the tile reads the blob back rather
 * than the library carrying a second copy of every picture at 320 px.
 */
function ImageThumb({ id, name }: { id: string; name: string }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    let live = true;
    void getImageBlob(id).then((found) => {
      if (live) setBlob(found);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return <ClipThumb blob={blob} name={name} />;
}

interface Message {
  tone: 'error' | 'warn' | 'ok';
  text: string;
}

export function LibraryView({ runtime }: { runtime: ConfigRuntime }) {
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
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const addInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    void listClips().then(setClips);
    void listImages().then(setImages);
    void readQuota().then(setQuota);
  }, []);

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
  }, [refresh, syncJobs]);

  const state = runtime.store.getSnapshot();
  const videoCfg = validateVideoConfig(state.modules[videoModule.id]?.cfg);
  const imageCfg = validateImageConfig(state.modules[imageModule.id]?.cfg);
  const activeKey =
    state.activeModuleId === videoModule.id
      ? videoCfg.url.startsWith(LOCAL_CLIP_SCHEME)
        ? `clip:${videoCfg.url.slice(LOCAL_CLIP_SCHEME.length)}`
        : null
      : state.activeModuleId === imageModule.id
        ? mapImageKey(localImageId(imageCfg.url))
        : null;

  const tiles = buildLibraryTiles({ clips, images, downloads, dismissed });

  const show = (tile: LibraryTile): void => {
    if (tile.id === null) return;
    if (tile.kind === 'clip') {
      runtime.store.commit((s) => ({
        ...withModuleConfig(s, videoModule.id, videoModule.configVersion, {
          ...videoCfg,
          url: `${LOCAL_CLIP_SCHEME}${tile.id ?? ''}`,
        }),
        activeModuleId: videoModule.id,
      }));
    } else {
      runtime.store.commit((s) => ({
        ...withModuleConfig(s, imageModule.id, imageModule.configVersion, {
          ...imageCfg,
          url: localImageUrl(tile.id ?? ''),
        }),
        activeModuleId: imageModule.id,
      }));
    }
    setMessage({ tone: 'ok', text: `“${tile.name}” is on your Kraken.` });
  };

  const togglePin = (tile: LibraryTile): void => {
    if (tile.id === null) return;
    const id = tile.id;
    if (tile.kind === 'clip') void setPinned(id, !tile.pinned).then(refresh);
    else void setImagePinned(id, !tile.pinned).then(refresh);
  };

  const remove = (tile: LibraryTile): void => {
    if (tile.id === null) return;
    const id = tile.id;
    if (tile.kind === 'clip') void deleteClip(id).then(refresh);
    else void deleteImage(id).then(refresh);
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
        if (!result.ok) setMessage({ tone: 'warn', text: failureLine(result.entry) });
      },
    );
  };

  const addLink = (): void => {
    const outcome = submitVideoLink(runtime, draft);
    if (outcome.issue !== null) {
      setMessage({
        tone: outcome.issue.severity === 'error' ? 'error' : 'warn',
        text: outcome.issue.message,
      });
    } else {
      setMessage(null);
    }
    if (outcome.accepted) {
      setDraft('');
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
      setMessage({
        tone: 'ok',
        text: 'Sent to your Kraken. It does the downloading, so a tile appears here once CAM picks it up.',
      });
    }
  };

  const addFiles = (files: FileList | null, opts: { force?: boolean } = {}): void => {
    if (files === null || files.length === 0) return;
    setMessage(null);
    setForceable(null);
    void (async () => {
      for (const file of [...files]) {
        const result = await ingestFile(file, opts.force === true ? { force: true } : {});
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.message ?? 'That file could not be added.' });
          // The one failure the user can overrule: no metadata arrived, which
          // is not the same as "this is not a video".
          if (result.failure === 'probe-timeout') setForceable(file);
        } else if (result.warnings.length > 0) {
          setMessage({ tone: 'warn', text: result.warnings[0]?.message ?? '' });
        } else {
          setMessage({ tone: 'ok', text: `Added “${file.name}”.` });
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

  return (
    <section className="kh-library" data-testid="library">
      <div className="kh-library__head">
        <div>
          <h2>Your library</h2>
          <p className="kh-hint">Kept {COPY_HOME}, inside CAM’s own browser storage.</p>
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
              aria-label="Paste a link or drop a file"
              placeholder="Paste a link or drop a file"
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
          {/*
            One sentence about what the two paths DO.

            It ran to thirty words, and the back half of it — "square-cropped if
            you can, with the audio dropped" — is advice about editing a file
            before you get here, in a box whose whole job is to take the file you
            already have. Nothing in the app acts on it and nothing goes wrong if
            it is ignored. It lives in `docs/local-clips.md`, where somebody
            preparing clips is actually reading (round 3, minors).
          */}
          <p className="kh-hint">
            A link is fetched by your Kraken and kept here. A file is added straight from this PC.
          </p>
          <input
            ref={fileInput}
            data-testid="clip-file-input"
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}

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
          <p className="kh-empty__title">Nothing saved yet</p>
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
          <p className="kh-hint">Whatever lands here keeps playing with the network unplugged.</p>
        </div>
      ) : (
        <ul className="kh-grid" data-testid="library-grid">
          {tiles.map((tile) => (
            <Tile
              key={tile.key}
              tile={tile}
              active={tile.key === activeKey}
              onShow={show}
              onPin={togglePin}
              onDelete={remove}
              onCancel={abortDownload}
              onRetry={retry}
              onDismiss={dismiss}
            />
          ))}
        </ul>
      )}

      <div className="kh-quota" data-testid="library-quota">
        <Meter
          pct={quotaPct}
          label={
            quota === null || quota.quotaBytes <= 0
              ? 'space in use — unknown'
              : quota.usageBytes <= 0
                ? `Nothing stored yet — ${mb(quota.quotaBytes)} available`
                : `${mb(quota.usageBytes)} of ${mb(quota.quotaBytes)} used`
          }
        />
        {quotaMatters &&
          (quota?.persisted === true ? (
            <Chip tone="ok">Kept for good</Chip>
          ) : (
            <Chip tone="warn">
              May be cleared if the disk fills up — pin the ones you care about
            </Chip>
          ))}
      </div>
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
  active,
  onShow,
  onPin,
  onDelete,
  onCancel,
  onRetry,
  onDismiss,
}: {
  tile: LibraryTile;
  active: boolean;
  onShow: (tile: LibraryTile) => void;
  onPin: (tile: LibraryTile) => void;
  onDelete: (tile: LibraryTile) => void;
  onCancel: (id: string) => void;
  onRetry: (entry: DownloadEntry) => void;
  onDismiss: (entry: DownloadEntry) => void;
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
        {tile.state === 'ready' ? (
          tile.kind === 'image' && tile.id !== null ? (
            <ImageThumb id={tile.id} name={tile.name} />
          ) : tile.thumbBlob === null && tile.id !== null ? (
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
            On screen
          </span>
        )}
      </div>

      <div className="kh-tile__meta">
        <div className="kh-tile__name" title={tile.name}>
          {tile.name}
        </div>
        <div className="kh-tile__detail">
          {/*
            The app's one vocabulary, on the surface that was still speaking its
            own (round 3, F7). This line read "Saving to your Kraken…" — a third
            verb for the thing the home screen calls "Keeping a copy", and a
            destination the copy never goes to: the bytes land in CAM's storage
            on this PC, which is what the Kraken then reads.
          */}
          {tile.state === 'failed'
            ? failureLine(entry)
            : tile.state === 'downloading'
              ? KEEPING_A_COPY_NOW
              : tileDetail(tile)}
          {tile.state === 'ready' && tile.pinned ? ' · pinned' : ''}
        </div>
      </div>

      <div className="kh-tile__actions">
        {tile.state === 'ready' && (
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
        {tile.state === 'downloading' && entry !== null && (
          <Button
            testId="tile-cancel"
            title="Stop fetching this"
            onClick={() => {
              onCancel(entry.id);
            }}
          >
            Cancel
          </Button>
        )}
        {tile.state === 'failed' && entry !== null && (
          <>
            <Button
              testId="tile-retry"
              title="Try fetching the bytes again"
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
/** `null` in, `null` out — a picture that is not a local one marks no tile. */
function mapImageKey(id: string | null): string | null {
  return id === null ? null : `image:${id}`;
}

function mergeDownloads(
  primary: readonly DownloadEntry[],
  secondary: readonly DownloadEntry[],
): DownloadEntry[] {
  const byId = new Map<string, DownloadEntry>();
  for (const entry of secondary) byId.set(entry.id, entry);
  for (const entry of primary) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}
