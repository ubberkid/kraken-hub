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

import { COPY_HOME, KEEPING_A_COPY } from '../../config/vocabulary';
import { readDisplayReport } from '../../diag/report';
import { detect } from '../../modules/video/routing/detect';
import { LOCAL_CLIP_RE } from '../../modules/video/routing/patterns';
import { readTeleMirror } from '../../modules/video/telemetry/videoTelemetry';
import { DEVICE_PRESETS, type DevicePresetId } from '../../platform/devicePresets';

import { panelIsKnown, type PanelPresence } from './panelPresence';

import type { FlowStage } from './flowStages';
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

/*
 * `FlowStage` and its enumeration live in `./flowStages` — see that file for
 * why each stage is an outcome rather than a failure, and why round 4 turned
 * the union into a list. Re-exported here because every consumer of the paste
 * story already imports this module.
 */
export { FLOW_STAGES, type FlowStage } from './flowStages';

export interface FlowState {
  stage: FlowStage;
  /** `null` for `youtube-embed`, which is a story about a download NOT started. */
  entry: DownloadEntry | null;
}

/**
 * How long a *successful* receipt stays on the screen — the ONE number.
 *
 * Round 2's R11 established it for the home screen's download ladder: narration
 * that never ends becomes furniture, so a step that has reached a steady state
 * says its piece and gets out of the way.
 *
 * It lived in `HomeView` until round 5's S4, which is why it applied to exactly
 * one of the four surfaces that print a receipt. The Library page's "Added
 * X." stood over an empty shelf after the file was deleted, and the remote's
 * LINK_RECEIPT stayed up for the rest of the session. A claim with no end is a
 * claim the screen keeps making about a moment that has passed — so the timer
 * is here, next to the rule about which stages earn one, and every surface
 * imports both.
 *
 * The linger is only half of it. A receipt must ALSO be dropped the moment the
 * thing it asserts stops being true, which no timer can know; see
 * `LibraryView`'s `claim`, which is reconciled against the shelf itself.
 */
export const RECEIPT_LINGER_MS = 4000;

/**
 * Whether a stage's receipt is allowed to stay on the screen (round 3, F4).
 *
 * Round 2 gave the receipt a retirement and then hard-coded the set of stages
 * that could use it — `accepted` and `stored` — which meant the app's FLAGSHIP
 * path was the one it did not apply to. A YouTube link produced a 219 px
 * three-card ladder that never left, asserting for the rest of the session that
 * a video was playing, next to a halo showing it playing and a status line
 * saying it was playing. The page said one fact four times.
 *
 * The rule is not a list of stages any more, it is a question about a stage,
 * and there are only two answers that earn permanence:
 *
 *  - **it has not finished** — `downloading`, which is a progress bar, and a
 *    progress bar that vanished at four seconds would be a bug;
 *  - **it went wrong** — `unsaved`, the one stage that reports something the
 *    user may want to act on, which stays until the story resolves.
 *
 * Everything else has reached a steady state, and a steady state is what the
 * status line under the halo is FOR. `streaming` and `youtube-embed` both
 * describe a source's permanent property, and a property belongs where the
 * setting that answers it lives — the video module's options, which carry both
 * sentences — never in a ladder of events.
 *
 * The `switch` is exhaustive on purpose: a new `FlowStage` is a type error here
 * rather than a card that silently inherits "stays forever".
 */
export function receiptPersists(stage: FlowStage): boolean {
  switch (stage) {
    case 'downloading':
      return true;
    case 'unsaved':
      return true;
    case 'accepted':
    case 'stored':
    case 'streaming':
    case 'youtube-embed':
      return false;
    default: {
      // Unreachable while the union is exhausted above; a compile error if not.
      const never: never = stage;
      return never;
    }
  }
}

/**
 * A receipt's second line, or `null` when it would only say the headline again.
 *
 * Round 4's minors. The first step-card names what was detected — *"YouTube
 * video detected"* — and printed `sourceName()` underneath it, which for a
 * YouTube link is *"a YouTube video"*. One fact, twice, in two type sizes, 18 px
 * apart, on the path the app is most often used for. It is real information for
 * a direct file (`dunes.mp4`) or an unrecognised host, and noise for every
 * provider the headline can name.
 *
 * The test is containment rather than equality, in both directions and with the
 * article dropped, because the two strings are written for different jobs and
 * will never be character-identical.
 */
export function receiptSubLine(headline: string, sub: string): string | null {
  const bare = (text: string): string =>
    text
      .toLowerCase()
      .replace(/^(?:a|an|the)\s+/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const h = bare(headline);
  const s = bare(sub);
  if (s === '') return null;
  return h.includes(s) || s.includes(h) ? null : sub;
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
  // Everything else that is a recognisable video link: acknowledged in the same
  // shape, with the same three cards, because it was the same gesture.
  if (detect(url).provider !== null) return { stage: 'accepted', entry: null };
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
      return `There is no room left ${COPY_HOME} for a copy, so your Kraken is playing it from the link.`;
    case 'network':
      return 'The download did not finish, so your Kraken is playing it from the link.';
    case 'store-failed':
      return `The copy could not be saved ${COPY_HOME}, so your Kraken is playing it from the link.`;
    default:
      return 'A copy could not be kept, so your Kraken is playing it from the link.';
  }
}

/**
 * What the app calls each source before anything has told it a real title.
 *
 * Not provider jargon and not an adapter id — the name of the site the user
 * came from, in the shape of an English noun phrase, so the status line reads
 * "Playing **a YouTube video**" rather than "Ready to play **watch**".
 */
const PROVIDER_NAME: Readonly<Record<string, string>> = {
  'youtube-embed': 'a YouTube video',
  vimeo: 'a Vimeo video',
  twitch: 'a Twitch stream',
  streamable: 'a Streamable clip',
  reddit: 'a Reddit video',
  resolver: 'a downloaded copy',
  'local-file': 'a local clip',
  hls: 'a live stream',
  dash: 'a stream',
};

/** A last path segment worth showing: `sunset.mp4`, never `watch` or `dQw4…`. */
const FILENAME_RE = /^[^/]+\.[a-z0-9]{2,5}$/i;

/**
 * A human name for whatever is playing, without a network round trip.
 *
 * Three sources, best first:
 *
 *  1. **A real title**, when telemetry carries one. The display is the only peer
 *     that has ever talked to the player, so if it learned the video's name that
 *     name beats every guess below.
 *  2. **The clip index**, for a local clip — the file the user themselves named.
 *  3. **The detected provider**, for everything else.
 *
 * The last path segment is used only when it actually looks like a filename.
 * That rule is the whole of design-audit finding F4: `sourceName` used to take
 * the last segment unconditionally, and *every YouTube watch link in the world*
 * ends in `/watch`, so the app's most common action was answered with the word
 * "watch". A Shorts link produced the raw video id. Never the raw URL either —
 * it can be 2 kB of signed query string.
 */
export function sourceName(
  url: string,
  clipNames: ReadonlyMap<string, string>,
  title?: string | null,
): string {
  const trimmed = url.trim();
  if (trimmed === '') return 'the demo clip';
  const clipId = LOCAL_CLIP_RE.exec(trimmed)?.[1];
  if (clipId !== undefined) return clipNames.get(clipId) ?? 'a local clip';
  if (typeof title === 'string' && title.trim() !== '') return title.trim();

  const provider = detect(trimmed).provider;
  const named = provider === null ? undefined : PROVIDER_NAME[provider];
  if (named !== undefined) return named;

  try {
    const parsed = new URL(trimmed);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last !== undefined && FILENAME_RE.test(last)) return decodeURIComponent(last);
    return parsed.hostname;
  } catch {
    return trimmed;
  }
}

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

/** Older than this and the "live" dot would be a lie, so it is not drawn. */
export const TELE_FRESH_MS = 6000;

export interface Status {
  live: boolean;
  verb: string;
  name: string;
  detail: string | null;
}

export interface VideoStatusInput {
  url: string;
  loopEnabled: boolean;
  loopEnd: number | null;
  tele: { ts: number; stats?: TeleStats; title?: string | null } | null;
  clipNames: ReadonlyMap<string, string>;
  now: number;
  /** True while a download for this exact link is in flight. */
  downloading: boolean;
  /**
   * What this window knows about the panel — the ONE signal (round 6, C2).
   *
   * It was `displaySeen: boolean`, read straight off `displaySeen.ts` by the
   * one caller that happened to import it, which is how the download ladder
   * ended up making a *different* claim about the same panel eighteen pixels
   * below this line. The status line and the ladder consume one derivation now;
   * see `panelPresence.ts` for the three states and why there are three.
   */
  presence: PanelPresence;
  /**
   * True only when nothing is being kept: the user asked for stream-only, or the
   * server refused the cross-origin read so no copy is possible.
   *
   * Round 2's one-status-voice finding. The strip carried a permanent green
   * "Keeping a copy" badge while the line under the halo read
   * "**Streaming** clip.mp4" — one screen, two answers to "is this being
   * saved?", and neither of them was a stage in a story. "Streaming" is a real
   * word for a real state and it is now used only for that state.
   */
  streamingOnly: boolean;
}

interface TeleStats {
  currentTime: number;
  bufferedEnd: number;
  held: boolean;
}

/**
 * The line under the halo, in the present tense (design audit, F4).
 *
 * The old ladder had one rung — "Ready to play" — and it never left it in the
 * configuration browser, because liveness required `tele.stats` from a running
 * display and the audit's seeded telemetry never satisfied it. So the app spent
 * its whole life describing something it was *about* to do.
 *
 * The rungs now, in order, each one a claim the app can actually support:
 *
 *  - **Playing / Holding** — telemetry is fresh. This is the display's own
 *    clock, not ours, and `Holding` is what the video engine calls a pause it
 *    performs without YouTube's overlay.
 *  - **Keeping a copy of** — a job for this exact link is in flight in the other
 *    window. The bytes are moving whether or not telemetry is.
 *  - **Playing / Streaming** — a source is configured and a display has been
 *    seen on this origin. `Streaming` ONLY when nothing is being kept.
 *  - **Ready to play** — and only here. Nothing is configured, or no display has
 *    ever connected, which is the one case where nothing is genuinely happening.
 *
 * Round 2's finding was that rungs two and three disagreed with each other and
 * with the ops strip: a `.mp4` being downloaded read "Streaming clip.mp4" under
 * a green badge that said "Keeping a copy". The ladder tells ONE story now —
 * *keeping a copy of X*, then *playing X · 0:12 / 3:02* — and the badge is gone,
 * because a stage in a story is not a permanent property of a video.
 */
export function describeVideoStatus(input: VideoStatusInput): Status {
  const { tele, now } = input;
  const stats = tele !== null && now - tele.ts < TELE_FRESH_MS ? tele.stats : undefined;
  const name = sourceName(input.url, input.clipNames, tele?.title);

  if (stats !== undefined) {
    const end = input.loopEnabled && input.loopEnd !== null ? input.loopEnd : stats.bufferedEnd;
    const detail =
      end > 0
        ? `${formatSeconds(stats.currentTime)} / ${formatSeconds(end)}`
        : formatSeconds(stats.currentTime);
    return { live: !stats.held, verb: stats.held ? 'Holding' : 'Playing', name, detail };
  }

  if (input.downloading) return { live: false, verb: `${KEEPING_A_COPY} of`, name, detail: null };

  const configured = input.url.trim() !== '';
  if (configured && panelIsKnown(input.presence)) {
    // A local clip is never streamed, whatever the mode says; everything else is
    // streaming only when no copy is being kept.
    const local = LOCAL_CLIP_RE.test(input.url.trim());
    const streaming = !local && input.streamingOnly;
    return { live: false, verb: streaming ? 'Streaming' : 'Playing', name, detail: null };
  }

  return { live: false, verb: 'Ready to play', name, detail: null };
}
