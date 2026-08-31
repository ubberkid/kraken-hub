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
import { LOCAL_CLIP_RE } from '../../modules/video/routing/patterns';
import { readTeleMirror } from '../../modules/video/telemetry/videoTelemetry';
import { DEVICE_PRESETS, type DevicePresetId } from '../../platform/devicePresets';

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
