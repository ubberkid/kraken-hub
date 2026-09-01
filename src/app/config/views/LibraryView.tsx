import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  publishClipIndex,
  readQuota,
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
import { ingestFile } from '../../../modules/video/local/ingest';
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
const POLL_MS = 1000;

function mb(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(MB_DECIMALS)} MB`;
}

/**
 * The object URL is created during render and revoked when the blob changes or
 * the tile unmounts. Creating it in an effect instead would need a `setState`
 * inside that effect, which cascades a render for every tile in the library.
 */
function ClipThumb({ blob }: { blob: Blob | null }) {
  const url = useMemo(() => (blob === null ? null : URL.createObjectURL(blob)), [blob]);
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url === null) return <div className="kh-tile__thumb" />;
  return <img className="kh-tile__thumb" src={url} alt="" />;
}

/**
 * Pictures have no stored thumbnail — they ARE their own thumbnail, and they
 * are kilobytes rather than megabytes, so the tile reads the blob back rather
 * than the library carrying a second copy of every picture at 320 px.
 */
function ImageThumb({ id }: { id: string }) {
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
  return <ClipThumb blob={blob} />;
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
    setMessage({ tone: 'ok', text: `“${tile.name}” is on the display.` });
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
      setMessage({
        tone: 'ok',
        text: 'Added. Your Kraken is fetching it — progress shows on its tile.',
      });
    }
  };

  const addFiles = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    setMessage(null);
    void (async () => {
      for (const file of [...files]) {
        const result = await ingestFile(file);
        if (!result.ok) {
          setMessage({ tone: 'error', text: result.message ?? 'That file could not be added.' });
        } else if (result.warnings.length > 0) {
          setMessage({ tone: 'warn', text: result.warnings[0]?.message ?? '' });
        } else {
          setMessage({ tone: 'ok', text: `Added “${file.name}”.` });
        }
      }
      await publishClipIndex();
      setAddOpen(false);
      refresh();
    })();
  };

  const quotaPct =
    quota === null || quota.quotaBytes <= 0 ? null : (quota.usageBytes / quota.quotaBytes) * PCT;

  return (
    <section className="kh-library" data-testid="library">
      <div className="kh-library__head">
        <div>
          <h2>Your library</h2>
          <p className="kh-hint">
            Kept on this PC, inside CAM’s own browser storage. Everything here plays with the
            network unplugged.
          </p>
        </div>
        <button
          type="button"
          className="kh-add"
          data-testid="library-add"
          aria-expanded={addOpen}
          aria-controls="kh-library-add"
          title="Add a video or a picture"
          onClick={() => {
            setAddOpen((open) => !open);
            setMessage(null);
            // The panel is the point of the press; land the caret in it.
            window.setTimeout(() => addInput.current?.focus(), 0);
          }}
        >
          <span aria-hidden="true">+</span>
          <span className="kh-sr">Add to your library</span>
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
          <p className="kh-hint">
            A link is fetched by your Kraken and kept here. A file is added straight from this PC —
            MP4 or WebM, square-cropped if you can, with the audio dropped.
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

      {tiles.length === 0 ? (
        <div className="kh-empty" data-testid="library-empty">
          <p className="kh-empty__title">Nothing saved yet</p>
          <p className="kh-hint">
            Press <b>+</b> up there to paste a link or drop a file. Whatever you add lands here and
            keeps playing with the network unplugged.
          </p>
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
              : `${mb(quota.usageBytes)} of ${mb(quota.quotaBytes)} used`
          }
        />
        <Chip tone={quota?.persisted === true ? 'ok' : 'warn'}>
          {quota?.persisted === true
            ? 'Kept for good'
            : 'May be cleared if the disk fills up — pin the ones you care about'}
        </Chip>
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
  const kindLabel = tile.kind === 'clip' ? 'Clip' : 'Image';

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
        {tile.state === 'ready' ? (
          tile.kind === 'image' && tile.id !== null ? (
            <ImageThumb id={tile.id} />
          ) : (
            <ClipThumb blob={tile.thumbBlob} />
          )
        ) : (
          <div className="kh-tile__thumb" />
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

        <span className="kh-tile__badge">{kindLabel}</span>
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
          {tile.state === 'failed'
            ? failureLine(entry)
            : tile.state === 'downloading'
              ? 'Saving to your Kraken…'
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
