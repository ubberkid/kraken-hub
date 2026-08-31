import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { videoModule } from '../../../modules/video';
import {
  deleteClip,
  publishClipIndex,
  readQuota,
  setPinned,
  type ClipRecord,
  type QuotaInfo,
  listClips,
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
import { primaryIssue, validateUrl } from '../../../modules/video/routing/validate';
import { validateVideoConfig } from '../../../modules/video/types';
import { withModuleConfig } from '../../../state/selectors';
import { Button, Chip, Field, Meter, Notice, Panel, Row, TextInput } from '../../../ui';

import type { ConfigRuntime } from '../runtime';

/**
 * Sources — the clip library and the download-first ingestion UI.
 *
 * The featured flow is the top of this page: paste a URL, kraken-hub fetches the
 * bytes into IndexedDB, and the display plays the local copy from then on.
 * Manual upload is at the bottom, marked as the fallback it is, and it only
 * works inside CAM's Configuration Browser — CAM's two browsers share one
 * storage partition, an ordinary browser tab and a phone do not
 * (design-videoEngine.md §5.1).
 */

const BYTES_PER_MB = 1_048_576;
const PCT = 100;
const PCT_DECIMALS = 0;
const MB_DECIMALS = 1;
const SECONDS_PER_MINUTE = 60;
const PAD_BELOW = 10;

function mb(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(MB_DECIMALS)} MB`;
}

function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const m = Math.floor(total / SECONDS_PER_MINUTE);
  const s = total % SECONDS_PER_MINUTE;
  return `${String(m)}:${s < PAD_BELOW ? '0' : ''}${String(s)}`;
}

/**
 * The object URL is created during render and revoked when the blob changes or
 * the row unmounts. Creating it in an effect instead would need a `setState`
 * inside that effect, which cascades a render for every clip in the library.
 */
function ClipThumb({ clip }: { clip: ClipRecord }) {
  const thumb = clip.thumbBlob;
  const url = useMemo(() => (thumb === null ? null : URL.createObjectURL(thumb)), [thumb]);
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url === null) return <div className="kh-clip__thumb" />;
  return <img className="kh-clip__thumb" src={url} alt="" />;
}

export function SourcesView({ runtime }: { runtime: ConfigRuntime }) {
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [downloads, setDownloads] = useState<DownloadEntry[]>(() => [
    ...listDownloads(),
    ...readMirroredDownloads(),
  ]);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'warn' | 'ok'; text: string } | null>(
    null,
  );
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(() => {
    void listClips().then(setClips);
    void readQuota().then(setQuota);
  }, []);

  useEffect(() => {
    refresh();
    // Live progress for a download running in the OTHER window (the display
    // does its own downloading) plus anything started from this page.
    const stop = subscribeDownloads((all) => {
      setDownloads(all);
    });
    const poll = setInterval(() => {
      const mirrored = readMirroredDownloads();
      const local = listDownloads();
      setDownloads(local.length > 0 ? local : mirrored);
    }, 1000);
    return () => {
      stop();
      clearInterval(poll);
    };
  }, [refresh]);

  const validation = url.trim() === '' ? null : validateUrl(url);
  const issue = validation === null ? null : primaryIssue(validation);

  const playClip = (clip: ClipRecord): void => {
    const state = runtime.store.getSnapshot();
    const current = validateVideoConfig(state.modules['video']?.cfg);
    runtime.store.commit((s) => ({
      ...withModuleConfig(s, videoModule.id, videoModule.configVersion, {
        ...current,
        url: `${LOCAL_CLIP_SCHEME}${clip.id}`,
      }),
      activeModuleId: videoModule.id,
    }));
    setMessage({ tone: 'ok', text: `Now playing “${clip.name}” on the display.` });
  };

  const startDownload = (): void => {
    const target = validation?.match.url ?? url.trim();
    if (target === '') return;
    setMessage(null);
    void downloadToClip(target, { provider: detect(target).provider }).then((result) => {
      refresh();
      if (result.ok) {
        setMessage({ tone: 'ok', text: 'Downloaded into the clip library.' });
        setUrl('');
      } else if (result.reason === 'cors') {
        setMessage({
          tone: 'warn',
          text: "That server won't allow a cross-origin read, so the clip can't be stored. The display will stream it instead — or download it yourself and add it below.",
        });
      } else {
        setMessage({ tone: 'error', text: result.message });
      }
    });
  };

  const addFiles = (files: FileList | null): void => {
    if (files === null) return;
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
      refresh();
    })();
  };

  const quotaPct =
    quota === null || quota.quotaBytes <= 0 ? null : (quota.usageBytes / quota.quotaBytes) * PCT;

  return (
    <>
      <Panel
        title="Add a video"
        hint="Paste a link. kraken-hub downloads the bytes into its own clip library and plays the local copy — that is what makes playback ad-free, chrome-free and offline-proof."
      >
        <Field label="Video URL" htmlFor="sources-url">
          <TextInput
            id="sources-url"
            value={url}
            placeholder="Paste a video link"
            onChange={setUrl}
          />
        </Field>
        {issue !== null && (
          <Notice tone={issue.severity === 'error' ? 'error' : 'warn'}>{issue.message}</Notice>
        )}
        <Row>
          <Button
            primary
            onClick={startDownload}
            title="Fetch the bytes into the local clip library"
          >
            Download to library
          </Button>
        </Row>
        {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}
        <p className="kh-hint">
          The display downloads on its own too: set a URL from anywhere and CAM&rsquo;s hidden
          browser fetches and stores it, with a progress card on the LCD.
        </p>
      </Panel>

      {downloads.length > 0 && (
        <Panel title="Downloads">
          <ul className="kh-cliplist">
            {downloads.map((d) => {
              const pct = progressPct(d);
              return (
                <li className="kh-clip" key={d.id}>
                  <div className="kh-clip__meta">
                    <div className="kh-clip__name">{d.name}</div>
                    <div className="kh-clip__detail">
                      {d.state}
                      {d.error === null ? '' : ` — ${d.error}`}
                    </div>
                    <Meter
                      pct={pct}
                      label={pct === null ? mb(d.receivedBytes) : `${pct.toFixed(PCT_DECIMALS)}%`}
                    />
                  </div>
                  {(d.state === 'downloading' || d.state === 'queued') && (
                    <Button
                      onClick={() => {
                        abortDownload(d.id);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <Panel
        title="Clip library"
        hint="Stored in CAM's browser storage on this PC. Clips play with no network at all."
      >
        <Row>
          <Meter
            pct={quotaPct}
            label={
              quota === null || quota.quotaBytes <= 0
                ? 'usage unknown'
                : `${mb(quota.usageBytes)} of ${mb(quota.quotaBytes)}`
            }
          />
          <Chip tone={quota?.persisted === true ? 'ok' : 'warn'}>
            {quota?.persisted === true
              ? 'Persistent'
              : 'Best-effort — Chromium may evict clips under disk pressure'}
          </Chip>
        </Row>

        {clips.length === 0 ? (
          <p className="kh-hint">No clips yet. Paste a URL above, or drop a file below.</p>
        ) : (
          <ul className="kh-cliplist">
            {clips.map((clip) => (
              <li className="kh-clip" key={clip.id} data-clip-id={clip.id}>
                <ClipThumb clip={clip} />
                <div className="kh-clip__meta">
                  <div className="kh-clip__name">{clip.name}</div>
                  <div className="kh-clip__detail">
                    {duration(clip.durationSec)} · {mb(clip.size)} · {clip.width}×{clip.height}
                  </div>
                </div>
                <Button
                  primary
                  onClick={() => {
                    playClip(clip);
                  }}
                >
                  Play
                </Button>
                <Button
                  onClick={() => {
                    void setPinned(clip.id, !clip.pinned).then(refresh);
                  }}
                >
                  {clip.pinned ? 'Unpin' : 'Pin'}
                </Button>
                <Button
                  onClick={() => {
                    void deleteClip(clip.id).then(refresh);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Add a file (fallback)"
        hint="Only needed when a server refuses a cross-origin read. Works in CAM's Configuration Browser only — CAM's two browsers share one storage partition; your phone and your normal browser do not."
      >
        <div
          className={dragOver ? 'kh-dropzone kh-dropzone--over' : 'kh-dropzone'}
          data-testid="clip-dropzone"
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
          Drop an MP4 or WebM here
        </div>
        <Row>
          <Button
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            Choose a file…
          </Button>
        </Row>
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
        <p className="kh-hint">
          Square-crop before adding — every Kraken panel is square (round ones are a circle
          inscribed in it), so a 1080×1080 clip has no wasted pixels and about a third of the
          bitrate of a 1920×1080 master at equal quality. Drop audio with{' '}
          <code className="kh-code">-an</code>; the LCD is always muted.
        </p>
      </Panel>
    </>
  );
}
