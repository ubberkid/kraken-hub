/**
 * Manual clip ingest (design-videoEngine.md §5.3) — the **fallback** path.
 *
 * The featured flow is paste-a-URL and let the app download it (see
 * `downloadManager.ts`). This file covers the case where the bytes are already
 * on the user's disk: the file picker and the drop zone in the config panel.
 *
 * It also owns the two media probes the download path reuses — reading a clip's
 * real duration/dimensions, and rendering the 320×320 WebP thumbnail — because
 * both paths must produce identical `clips` rows.
 *
 * Upload only works inside CAM's Configuration Browser: it and the Kraken
 * Browser share one storage partition, while the user's ordinary browser and
 * their phone do not (§5.1). The remote page therefore hides this entirely.
 */

import { createLogger } from '../../../lib/log';
import { publish } from '../telemetry/videoTelemetry';

import { checkQuotaFor, ensurePersisted, newClipId, putClip, type ClipRecord } from './clipStore';

const log = createLogger('video/ingest');

/** §5.3 step 3 — a file that never reports metadata is offered as "add anyway". */
export const PROBE_TIMEOUT_MS = 8000;
// device-size-ok: the clip-library thumbnail edge, not a panel dimension.
const THUMB_PX = 320;
const THUMB_QUALITY = 0.8;
const THUMB_SEEK_FRACTION = 0.1;
const THUMB_SEEK_MAX_SEC = 1;
const HALF = 0.5;

/**
 * §5.3 step 1 — Chromium cannot demux Matroska in `<video>`. This is a platform
 * limit, not a bug we can route around, so it is a hard reject with the remux
 * command in the message.
 */
const REJECTED_EXTENSIONS = ['.mkv', '.mka', '.avi', '.flv', '.wmv', '.rmvb', '.3gp'];

export type IngestFailure =
  'unsupported-container' | 'probe-timeout' | 'quota-exceeded' | 'read-failed';

export interface IngestWarning {
  code: 'hevc-unverified' | 'av1-unverified' | 'probe-timeout' | 'high-fps-hint';
  message: string;
}

export interface IngestResult {
  ok: boolean;
  clip: ClipRecord | null;
  failure: IngestFailure | null;
  message: string | null;
  warnings: IngestWarning[];
  persisted: boolean;
}

export function isRejectedContainer(name: string): boolean {
  const lower = name.toLowerCase();
  return REJECTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * §5.3 step 2 — HEVC decode in Chromium is hardware-dependent with no software
 * fallback, and AV1 is not universal either. Warn, never hard-reject: the file
 * may well play on this machine, and refusing it would be a guess.
 */
export function codecWarnings(mime: string, name: string): IngestWarning[] {
  const out: IngestWarning[] = [];
  const supports = (type: string): boolean => {
    try {
      return 'MediaSource' in window && MediaSource.isTypeSupported(type);
    } catch {
      return false;
    }
  };
  const lower = `${mime} ${name}`.toLowerCase();
  if (
    (lower.includes('hevc') || lower.includes('hvc1') || lower.includes('.mov')) &&
    !supports('video/mp4; codecs="hvc1.1.6.L93.B0"')
  ) {
    out.push({
      code: 'hevc-unverified',
      message:
        'This machine reports no HEVC decode support. If the clip is HEVC it may not play — MP4/H.264 is safest.',
    });
  }
  if (lower.includes('av01') && !supports('video/mp4; codecs="av01.0.08M.08"')) {
    out.push({
      code: 'av1-unverified',
      message: 'This machine reports no AV1 decode support. The clip may not play.',
    });
  }
  return out;
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  timedOut: boolean;
}

/**
 * §5.3 step 3 — offscreen `<video preload="metadata">` on an object URL. The URL
 * is revoked in every exit path, including the timeout: a leaked one pins the
 * whole blob for the life of the document (§5.4).
 */
export function probeVideo(blob: Blob): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    el.playsInline = true;
    let settled = false;

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ durationSec: 0, width: 0, height: 0, timedOut: true });
    }, PROBE_TIMEOUT_MS);

    el.addEventListener('loadedmetadata', () => {
      finish({
        durationSec: Number.isFinite(el.duration) ? el.duration : 0,
        width: el.videoWidth,
        height: el.videoHeight,
        timedOut: false,
      });
    });
    el.addEventListener('error', () => {
      finish({ durationSec: 0, width: 0, height: 0, timedOut: true });
    });

    el.src = url;
    el.load();
  });
}

/**
 * §5.3 step 4 — a cover-cropped 320×320 WebP taken 10 % in (never frame 0,
 * which is black in most clips). `null` when the frame cannot be drawn, which
 * is normal for a file the decoder does not support.
 */
export function makeThumbnail(blob: Blob, durationSec: number): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    el.playsInline = true;
    let settled = false;

    const finish = (out: Blob | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(out);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, PROBE_TIMEOUT_MS);

    el.addEventListener('loadedmetadata', () => {
      el.currentTime = Math.min(THUMB_SEEK_MAX_SEC, durationSec * THUMB_SEEK_FRACTION);
    });
    el.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = THUMB_PX;
        canvas.height = THUMB_PX;
        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          finish(null);
          return;
        }
        const side = Math.min(el.videoWidth, el.videoHeight);
        const sx = (el.videoWidth - side) * HALF;
        const sy = (el.videoHeight - side) * HALF;
        ctx.drawImage(el, sx, sy, side, side, 0, 0, THUMB_PX, THUMB_PX);
        canvas.toBlob(
          (out) => {
            finish(out);
          },
          'image/webp',
          THUMB_QUALITY,
        );
      } catch (err) {
        log.warn('thumbnail failed', err);
        finish(null);
      }
    });
    el.addEventListener('error', () => {
      finish(null);
    });

    el.src = url;
    el.load();
  });
}

export interface IngestOptions {
  /** Add despite a metadata probe timeout (§5.3 step 3's "add anyway"). */
  force?: boolean;
  /** Recorded on the clip when the bytes came from a download. */
  sourceUrl?: string | null;
}

/**
 * The one function both ingest paths end in: probe → thumbnail → quota →
 * persist → single-transaction write. Never throws; failures come back as data
 * so the panel can render the exact §7.1 message.
 */
export async function ingestBlob(
  blob: Blob,
  name: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const warnings: IngestWarning[] = [];

  if (isRejectedContainer(name)) {
    return {
      ok: false,
      clip: null,
      failure: 'unsupported-container',
      message:
        ".mkv can't be played — Chromium has no Matroska support in `<video>`, and no library fixes that. Remux to MP4: `ffmpeg -i in.mkv -c copy out.mp4`.",
      warnings,
      persisted: false,
    };
  }

  warnings.push(...codecWarnings(blob.type, name));

  // §5.3 step 5 — refuse BEFORE writing anything, naming both numbers.
  const quota = await checkQuotaFor(blob.size);
  if (!quota.ok) {
    return {
      ok: false,
      clip: null,
      failure: 'quota-exceeded',
      message: quota.message,
      warnings,
      persisted: quota.quota.persisted,
    };
  }

  const probe = await probeVideo(blob);
  if (probe.timedOut && opts.force !== true) {
    return {
      ok: false,
      clip: null,
      failure: 'probe-timeout',
      message:
        "Couldn't read this file's duration or size. It may still play — use “Add anyway” to store it as-is.",
      warnings: [
        ...warnings,
        { code: 'probe-timeout', message: 'No metadata arrived within 8 seconds.' },
      ],
      persisted: false,
    };
  }

  const thumb = probe.timedOut ? null : await makeThumbnail(blob, probe.durationSec);
  const now = Date.now();
  const clip: ClipRecord = {
    id: newClipId(),
    name,
    mime: blob.type === '' ? 'video/mp4' : blob.type,
    size: blob.size,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    createdAt: now,
    lastUsedAt: now,
    thumbBlob: thumb,
    sha256Prefix: null,
    sourceUrl: opts.sourceUrl ?? null,
    pinned: false,
  };

  await putClip(clip, blob);
  const persisted = await ensurePersisted();
  publish({
    code: 'clip-added',
    severity: 'info',
    message: name,
    detail: { size: blob.size, durationSec: probe.durationSec, persisted },
  });

  return { ok: true, clip, failure: null, message: null, warnings, persisted };
}

/** File-picker / drop-zone entry point. */
export function ingestFile(file: File, opts: IngestOptions = {}): Promise<IngestResult> {
  return ingestBlob(file, file.name, opts);
}
