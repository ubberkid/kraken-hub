/**
 * Quality — the pure half.
 *
 * "Show what you're getting everywhere; offer control only where it's real."
 *
 * Every provider in this app has a different answer to "what resolution is on
 * the panel, and can I change it?", and the honest answers range from *exact*
 * (hls.js hands us a level list with heights) to *nothing at all* (a
 * cross-origin YouTube iframe will not tell us and will not be told). The whole
 * point of this file is that the UI never has to guess which case it is in: it
 * asks `qualityControlFor()` and renders the control that is actually true.
 *
 * Four kinds of control, and the difference between them is a product promise,
 * not a rendering detail:
 *
 *  - **`set`** — the provider takes a height and honours it. hls (`currentLevel`),
 *    dash (`setRepresentationForTypeByIndex`), twitch (`setQuality`) and the
 *    resolver companion (re-resolve at a new `maxHeight`) are all real control.
 *  - **`bias`** — YouTube. There is no `setPlaybackQuality` that works any more;
 *    the only lever is the *measured size of the player element*, which YouTube
 *    reads when it picks a stream. So the picker says "Bias", the helper line
 *    says who is actually choosing, and the value maps onto the geometry ladder.
 *  - **`readonly`** — a local clip or a direct file. The resolution is whatever
 *    is in the file; there is nothing to pick, so we show it and stop.
 *  - **`none`** — nothing known yet.
 *
 * This file is display-safe: no DOM, no React, no config-UI imports. Both the
 * panel and the phone remote import it, and so does the display.
 */

import type { ProviderId } from './types';

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

/**
 * `auto` lets the provider's own adaptive logic run; `fixed` pins `height`.
 *
 * `height` is kept across a switch back to `auto` on purpose — a user who tries
 * Auto and changes their mind should get their pin back, not a blank.
 */
export type QualityMode = 'auto' | 'fixed';

export interface QualityConfig {
  mode: QualityMode;
  /** The pinned height in pixels, or `null` when nothing has been chosen. */
  height: number | null;
}

export const DEFAULT_QUALITY: QualityConfig = { mode: 'auto', height: null };

/**
 * The standard ladder, used wherever a provider cannot enumerate its own
 * renditions but a ceiling IS known — today that is the resolver companion,
 * which reports the source height in its `/resolve` envelope.
 *
 * Named rungs rather than bare array elements because invariant I5's
 * `no-magic-numbers` exempts `const` initialisers but not array literals.
 */
const RUNG_480 = 480;
const RUNG_720 = 720;
const RUNG_1080 = 1080;
const RUNG_1440 = 1440;
const RUNG_2160 = 2160;

export const QUALITY_LADDER: readonly number[] = [
  RUNG_480,
  RUNG_720,
  RUNG_1080,
  RUNG_1440,
  RUNG_2160,
];

/** One rendition a provider says it can play. */
export interface QualityLevel {
  height: number;
  label: string;
}

export function qualityLabel(height: number): string {
  return `${String(Math.round(height))}p`;
}

/**
 * The ladder capped at a known source height, as levels.
 *
 * "Capped", not "clamped": a 900p source offers 480 and 720 and nothing above,
 * because offering 1080 for a 900p file would be a promise the file cannot
 * keep. The source height itself is added when it is not already a rung, so a
 * 900p source can still be asked for at 900p.
 */
export function ladderUpTo(maxHeight: number): QualityLevel[] {
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) {
    return QUALITY_LADDER.map((h) => ({ height: h, label: qualityLabel(h) }));
  }
  const heights = QUALITY_LADDER.filter((h) => h <= maxHeight);
  if (!heights.includes(Math.round(maxHeight))) heights.push(Math.round(maxHeight));
  return heights.sort((a, b) => a - b).map((h) => ({ height: h, label: qualityLabel(h) }));
}

// ---------------------------------------------------------------------------
// Who is in control
// ---------------------------------------------------------------------------

export type QualityControl = 'set' | 'bias' | 'readonly' | 'none';

/**
 * What kind of control a provider genuinely offers.
 *
 * Derived from the provider id rather than from `ProviderCapabilities.canSetQuality`
 * because the config panel and the phone remote both have to answer this
 * question *before* anything has mounted — the panel from a pasted URL, the
 * remote from a telemetry packet that may not have arrived yet.
 */
export function qualityControlFor(provider: ProviderId | null): QualityControl {
  switch (provider) {
    case 'hls':
    case 'dash':
    case 'twitch':
    case 'resolver':
      return 'set';
    case 'youtube-embed':
      return 'bias';
    case 'local-file':
    case 'direct-file':
    case 'reddit':
      return 'readonly';
    default:
      return 'none';
  }
}

/**
 * The key a downloaded clip is remembered by, for providers where the height is
 * genuinely a choice.
 *
 * The clip library is looked up by `sourceUrl` before any network work, which
 * is what makes a cold boot with no network play instantly. That same lookup is
 * why changing the quality of a *downloaded* source needs this: without it, the
 * pasted URL would keep finding the old 720p file forever and the new setting
 * would appear to do nothing after one reload.
 *
 * So a pinned height becomes part of the key. Three consequences, all wanted:
 * the old clip is still there and still playing while the new one downloads (it
 * is a different row, not an overwrite), the swap happens when the new clip
 * lands, and going back to a height already downloaded is instant.
 *
 * Only applied where the control is real — a local file or a direct `.mp4` has
 * exactly one resolution, so tagging its key would fragment the library for a
 * choice nobody can make.
 */
export function clipSourceKey(url: string, cfg: QualityConfig, control: QualityControl): string {
  if (control !== 'set' || cfg.mode !== 'fixed' || cfg.height === null) return url;
  return `${url}#kh-q=${String(cfg.height)}`;
}

// ---------------------------------------------------------------------------
// The YouTube bias ladder
// ---------------------------------------------------------------------------

/**
 * The three geometry rungs a bias can land on.
 *
 * These are *iframe element widths*, not panel dimensions and not video
 * heights: YouTube picks a stream from the size it measures the player at, so
 * "ask for 1080" means "make the element 1920 wide and let YouTube conclude the
 * obvious". See `youtube/geometry.ts` for why that works at all.
 */
// device-size-ok: YouTube ELEMENT ladder widths (iframe px), not panel dimensions.
const YT_FLOOR_720 = 1280;
// device-size-ok: YouTube ELEMENT ladder widths (iframe px), not panel dimensions.
const YT_FLOOR_1080 = 1920;
// device-size-ok: YouTube ELEMENT ladder widths (iframe px), not panel dimensions.
const YT_FLOOR_1440 = 2560;

/** The bias values the UI offers, in the order it offers them. */
export const YT_BIAS_HEIGHTS: readonly number[] = [RUNG_720, RUNG_1080, RUNG_1440];

/**
 * A wanted height → the ladder rung whose floor asks YouTube for it.
 *
 * `null` in means "Auto", which is `null` out: the caller then leaves
 * `youtube.qualityFloorPx` exactly as configured and the quality watchdog keeps
 * its normal freedom to step the ladder.
 *
 * Everything below 1080 floors at the smallest rung and everything at or above
 * 1440 floors at the largest, because those are the only rungs there are. This
 * is deliberately a FLOOR and not a ceiling: the watchdog may still step up
 * from it if YouTube reports it is size-limited, which is the only way a user
 * asking for 1080 on a slow link ever gets 1080.
 */
export function ytLadderFloorFor(height: number | null): number | null {
  if (height === null || !Number.isFinite(height) || height <= 0) return null;
  if (height <= RUNG_720) return YT_FLOOR_720;
  if (height <= RUNG_1080) return YT_FLOOR_1080;
  return YT_FLOOR_1440;
}

// ---------------------------------------------------------------------------
// Describing what is actually on the panel
// ---------------------------------------------------------------------------

export interface QualityReadout {
  /**
   * What the adapter last reported, if anything.
   *
   * Both fields optional because this arrives off a wire or a localStorage
   * mirror written by a peer that may be a different build: a packet with a
   * `label` and no `height` is a shape this has to survive, not reject.
   */
  reported: { height?: number | null; label?: string | null } | null;
  /** True when the bytes are a stored clip rather than a stream. */
  local: boolean;
}

/**
 * One line of plain language for the current state.
 *
 * Three shapes, and the difference between them is the whole feature:
 *
 *   "1080p · local"            — pinned, and the bytes are on this PC
 *   "Auto — 720p right now"    — the provider is choosing, and this is its choice
 *   "Quality not reported yet" — nothing has come back; say so rather than lie
 *
 * Never invents a number. A pinned 1080 that the provider has not confirmed
 * reads as "1080p (asked)", because "1080p" would be a claim about the picture
 * and all we know is what we requested.
 */
export function describeQuality(
  cfg: QualityConfig,
  readout: QualityReadout,
  opts: {
    /**
     * True when this line sits directly above the picker — round 7's minors.
     *
     * The Auto **segment** is right there, selected, saying the word: printing
     * "Auto — 720p right now" as the row's description put the same word twice
     * within thirty pixels, once as a label for a control and once as prose
     * about it. What the description is FOR is the half the segment cannot show
     * — what Auto is choosing at this moment — so in a picker that is all it
     * says, and it says nothing at all when nothing has been reported.
     */
    inPicker?: boolean;
  } = {},
): string {
  const now = readout.reported?.height ?? null;
  const nowText =
    now !== null && now > 0
      ? qualityLabel(now)
      : (readout.reported?.label ?? null) !== null && readout.reported?.label !== ''
        ? (readout.reported?.label ?? '')
        : null;
  const suffix = readout.local ? ' · local' : '';

  if (cfg.mode === 'fixed' && cfg.height !== null) {
    if (nowText === null) return `${qualityLabel(cfg.height)} (asked)${suffix}`;
    return `${nowText}${suffix}`;
  }
  // Just "Auto". The trailing "— quality not reported yet" was an apology for
  // the setting doing exactly what it says: the display picks. There is nothing
  // for the reader to do about it and nothing being waited for (round 4, minors).
  if (opts.inPicker === true) return nowText === null ? '' : `${nowText} right now${suffix}`;
  if (nowText === null) return `Auto${suffix}`;
  return `Auto — ${nowText} right now${suffix}`;
}

/**
 * The picker's options, as `{value,label}` pairs a `<select>` can round-trip.
 *
 * `value` is the height as a string, or `'auto'`. The levels come from whatever
 * the display reported; when nothing has, a `set`-capable provider still gets
 * the standard ladder so the control is not dead on arrival — a level list that
 * has not arrived is not the same as a provider that cannot switch.
 */
export function qualityOptions(
  control: QualityControl,
  levels: readonly QualityLevel[],
): { value: string; label: string }[] {
  if (control === 'bias') {
    return [
      { value: 'auto', label: 'Auto' },
      ...YT_BIAS_HEIGHTS.map((h) => ({ value: String(h), label: String(h) })),
    ];
  }
  const list =
    levels.length > 0 ? levels : QUALITY_LADDER.map((h) => ({ height: h, label: qualityLabel(h) }));
  return [
    // One word. The design audit's F9 counted 171 words living inside
    // `<option>` elements across the config UI; the sentence that used to be
    // here was one of them, and the row's own description already says what
    // Auto is doing right now.
    { value: 'auto', label: 'Auto' },
    ...[...list]
      .sort((a, b) => b.height - a.height)
      .map((l) => ({ value: String(l.height), label: l.label })),
  ];
}

/** Parses a picker value back into a `QualityConfig`, keeping the old pin. */
export function qualityFromOption(value: string, previous: QualityConfig): QualityConfig {
  if (value === 'auto') return { mode: 'auto', height: previous.height };
  const height = Number(value);
  if (!Number.isFinite(height) || height <= 0) return previous;
  return { mode: 'fixed', height: Math.round(height) };
}

/** The `<select>` value for a config, so the control round-trips. */
export function qualityOptionValue(cfg: QualityConfig): string {
  return cfg.mode === 'fixed' && cfg.height !== null ? String(cfg.height) : 'auto';
}

/**
 * The one honest helper line for the `bias` case.
 *
 * Exported rather than written into the panel so the phone remote and the CAM
 * panel say exactly the same thing — a claim about who controls the picture is
 * not something two surfaces should phrase differently.
 */
export const YT_BIAS_HELPER =
  'YouTube chooses; kraken-hub nudges it by resizing the hidden player.';
