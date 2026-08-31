/**
 * What the home screen knows about the LCD, and how it says it.
 *
 * Everything here reads the SHARED ORIGIN rather than guessing. CAM opens two
 * browsers on one origin, so whatever the display published to localStorage is
 * the closest thing this page has to ground truth — and the distinction between
 * "the display told us" and "we assumed" is load-bearing twice over:
 *
 *  - the mirror boots the simulator at the panel size the display actually
 *    reported, so it is a mirror rather than a lookalike;
 *  - the low-frame-rate advisory is shown ONLY on a number that came off the
 *    display. This page's own geometry fallback is 640/30 on any desktop
 *    browser, and warning a user about a slider they already raised — or one
 *    they have not reached yet — is how a correct app gets a reputation for
 *    crying wolf.
 *
 * Two publishers, in order of authority:
 *  1. `kraken-hub:v1:diag:display` — the full DiagReport, written by
 *     `?kraken=1&diag=1`. Authoritative, but only present while diagnostics ran.
 *  2. `kraken-hub:v1:video:tele` — the video module's continuous telemetry,
 *     which carries `display: { w, h, shape, targetFps }` on every packet. This
 *     is the one that exists during ordinary use.
 */

import { readDisplayReport } from '../../diag/report';
import { detect } from '../../modules/video/routing/detect';
import { LOCAL_CLIP_RE } from '../../modules/video/routing/patterns';
import { readTeleMirror } from '../../modules/video/telemetry/videoTelemetry';
import { DEVICE_PRESETS, type DevicePresetId } from '../../platform/devicePresets';

import type { DownloadEntry } from '../../modules/video/local/downloadManager';

/** Panel facts as the DISPLAY reported them. Never inferred from this window. */
export interface DisplayFacts {
  width: number;
  height: number;
  shape: string;
  targetFps: number;
  /** Which publisher answered — surfaced in copy, and useful in tests. */
  source: 'diag' | 'tele';
}

/**
 * At or below this, CAM's frame-rate slider is low enough that full-motion
 * content is a slideshow. CAM's factory default is 1.
 */
export const LOW_FPS_THRESHOLD = 5;

const SECONDS_PER_MINUTE = 60;
const PAD_BELOW = 10;

function fromReport(): DisplayFacts | null {
  const report = readDisplayReport();
  if (report?.mode !== 'display') return null;
  // `nzxtRaw` is exactly what CAM injected; `device` is what the geometry engine
  // resolved. Prefer the raw value — it is the slider, unmediated.
  const raw = report.device.nzxtRaw;
  const d = raw ?? report.device;
  if (!Number.isFinite(d.width) || d.width <= 0) return null;
  return {
    width: d.width,
    height: d.height,
    shape: d.shape,
    targetFps: d.targetFps,
    source: 'diag',
  };
}

function fromTelemetry(): DisplayFacts | null {
  const packet = readTeleMirror();
  const d = packet?.display;
  if (d === undefined || !Number.isFinite(d.w) || d.w <= 0) return null;
  return { width: d.w, height: d.h, shape: d.shape, targetFps: d.targetFps, source: 'tele' };
}

export function readDisplayFacts(): DisplayFacts | null {
  return fromReport() ?? fromTelemetry();
}

/**
 * The simulator preset that matches the real panel.
 *
 * Elite is the fallback for the same reason `devicePresets.ts` gives: it is by
 * far the most common panel, and guessing large is safe because content laid
 * out for 640 scales down cleanly while the reverse does not.
 */
export function pickMirrorPreset(facts: DisplayFacts | null): DevicePresetId {
  if (facts === null) return 'elite';
  for (const preset of Object.values(DEVICE_PRESETS)) {
    if (preset.width === facts.width && preset.height === facts.height) {
      if (preset.shape === facts.shape) return preset.id;
    }
  }
  return 'elite';
}

/** True only on a frame rate the DISPLAY reported. `null` never warns. */
export function isLowFps(facts: DisplayFacts | null): boolean {
  return facts !== null && Number.isFinite(facts.targetFps) && facts.targetFps <= LOW_FPS_THRESHOLD;
}

/** `94` → `1:34`. Non-finite and negative inputs render as an em dash. */
export function formatSeconds(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.floor(sec);
  const m = Math.floor(total / SECONDS_PER_MINUTE);
  const s = total % SECONDS_PER_MINUTE;
  return `${String(m)}:${s < PAD_BELOW ? '0' : ''}${String(s)}`;
}

// ---------------------------------------------------------------------------
// The download story
// ---------------------------------------------------------------------------

/**
 * What the step-cards under the paste box are allowed to say.
 *
 * The names are outcomes, not failures, because **a download is an enhancement
 * layered on playback and its failure is never a failure of playback**. Three of
 * the five are terminal-and-fine:
 *
 *  - `streaming` — the server sent no `Access-Control-Allow-Origin`, so `fetch`
 *    cannot READ bytes that a plain `<video src>` plays without complaint. Most
 *    of the web is like this. The video is on the panel; only the local copy is
 *    missing.
 *  - `youtube-embed` — no companion, so the geometry engine is playing the
 *    video, exactly as designed (§6.4: *"users never see a hard error for a
 *    resolver miss"*). The card is an invitation, not a diagnosis.
 *  - `unsaved` — something else went wrong while keeping the copy (a 500, no
 *    room on disk). Still not an error card: the display's own fallback chain
 *    has already put something on the panel or shown its own card.
 *
 * The regression this type exists to prevent: the redesign rendered a browser
 * `TypeError` ("Failed to fetch") as the second step's copy for `streaming`, for
 * the FIRST entry in a mirror nobody prunes — so one CORS-less link left every
 * later paste, YouTube included, looking broken.
 */
export type FlowStage = 'downloading' | 'stored' | 'streaming' | 'unsaved' | 'youtube-embed';

export interface FlowState {
  stage: FlowStage;
  /** `null` for `youtube-embed`, which is a story about a download NOT started. */
  entry: DownloadEntry | null;
}

/**
 * The download entry that belongs to `url` — and only to `url`.
 *
 * Matched on `sourceUrl` as well as `url` because the resolver path fetches a
 * loopback `/stream/<opaque>` on the user's behalf; the job is still the story
 * of the YouTube link they pasted. Entries arrive newest-first
 * (`listDownloads()` sorts by `startedAt`), so the first match is the current
 * attempt.
 */
export function pickDownloadEntry(
  url: string,
  entries: readonly DownloadEntry[],
): DownloadEntry | null {
  const target = url.trim();
  if (target === '') return null;
  return entries.find((e) => e.sourceUrl === target || e.url === target) ?? null;
}

/**
 * The whole paste-flow state machine, as one pure function.
 *
 * `null` means "say nothing", which is the honest answer far more often than
 * the redesign assumed: a local clip, the demo, a source with no download story
 * to tell, or a job the user cancelled.
 */
export function describeFlow(input: {
  url: string;
  entries: readonly DownloadEntry[];
  /** From the DISPLAY's telemetry — this window never probes the companion. */
  resolverHealthy: boolean;
}): FlowState | null {
  const url = input.url.trim();
  if (url === '' || LOCAL_CLIP_RE.test(url)) return null;

  const entry = pickDownloadEntry(url, input.entries);
  if (entry !== null) {
    switch (entry.state) {
      case 'queued':
      case 'downloading':
      case 'storing':
        return { stage: 'downloading', entry };
      case 'done':
        return { stage: 'stored', entry };
      case 'error':
        return { stage: entry.reason === 'cors' ? 'streaming' : 'unsaved', entry };
      default:
        // `aborted` — the user asked for it to stop, and a card explaining what
        // they just did to themselves is noise.
        return null;
    }
  }

  // No job, because none was ever startable: a YouTube page URL is not
  // something `fetch` can turn into a file, and without the companion nothing
  // can. That is a state worth NAMING — the video is playing through the embed
  // and one program away from being a permanent, ad-free local copy.
  if (!input.resolverHealthy && detect(url).provider === 'youtube-embed') {
    return { stage: 'youtube-embed', entry: null };
  }
  return null;
}

/** True only while the DISPLAY's own telemetry says the companion answered. */
export function resolverHealthyFromTele(
  packet: { resolver?: { healthy: boolean } } | null,
): boolean {
  return packet?.resolver?.healthy === true;
}

/**
 * A human sentence for a download that could not be kept, in OUR words.
 *
 * Never `err.message`: "Failed to fetch" is Chrome telling a programmer that a
 * promise rejected, and putting it on the home screen is how a working video
 * comes to look like a broken one.
 */
export function failureLine(entry: DownloadEntry | null): string {
  switch (entry?.reason) {
    case 'quota':
      return 'There is no room left on this PC for a copy, so your Kraken is playing it from the link.';
    case 'network':
      return 'The download did not finish, so your Kraken is playing it from the link.';
    case 'store-failed':
      return 'The copy could not be saved to this PC, so your Kraken is playing it from the link.';
    default:
      return 'A copy could not be kept, so your Kraken is playing it from the link.';
  }
}

/**
 * A human name for whatever is playing, without a network round trip.
 *
 * Local clips are named by the published clip index; a remote URL is named by
 * its last path segment, which is what a user recognises. Never the raw URL: it
 * can be 2 kB of signed query string.
 */
export function sourceName(url: string, clipNames: ReadonlyMap<string, string>): string {
  const trimmed = url.trim();
  if (trimmed === '') return 'the demo clip';
  const clipId = LOCAL_CLIP_RE.exec(trimmed)?.[1];
  if (clipId !== undefined) return clipNames.get(clipId) ?? 'a local clip';
  try {
    const parsed = new URL(trimmed);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last !== undefined && last.length > 0) return decodeURIComponent(last);
    return parsed.hostname;
  } catch {
    return trimmed;
  }
}
