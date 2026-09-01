/**
 * "A link was pasted" — the one code path, shared by the two places a link can
 * be pasted.
 *
 * The home screen's row under the halo and the Library page's **+** panel are
 * different surfaces with the same meaning: validate the link, and if it is not
 * blocked, make it the video source. Everything after that — resolver, download,
 * quota, the local copy — is the display's download-first pipeline reacting to
 * the committed state, exactly as it does for a link set from the phone.
 *
 * This existed twice before, and the copies had drifted: the Library page called
 * `downloadToClip()` directly, which skipped `validateUrl`'s `config` context
 * (the http → https upgrade, §7.1 `mixed-content-http`) and skipped
 * `downloadMode` entirely, so "Never store anything" was honoured on one surface
 * and ignored on the other.
 */

import { imageModule } from '../../modules/image';
import { primaryImageIssue, validateImageUrl } from '../../modules/image/imageUrl';
import { validateImageConfig } from '../../modules/image/schema';
import { videoModule } from '../../modules/video';
import { primaryIssue, validateUrl, type Severity } from '../../modules/video/routing/validate';
import { validateVideoConfig } from '../../modules/video/types';
import { withModuleConfig } from '../../state/selectors';

import type { ConfigRuntime } from './runtime';

/**
 * A line to show under the paste row, from whichever validator ran.
 *
 * Structural rather than the video module's `ValidationIssue`, because the row
 * is contextual now: the same input submits a video link or a picture link, and
 * the two validators have their own code unions. The screen only needs the
 * severity and the sentence.
 */
export interface PasteIssue {
  severity: Severity;
  message: string;
}

export interface LinkSubmission {
  /** The line to show under the input. `null` when the link is unremarkable. */
  issue: PasteIssue | null;
  /** True when the link became the video source. A blocked link never does. */
  accepted: boolean;
}

export function submitVideoLink(runtime: ConfigRuntime, raw: string): LinkSubmission {
  const trimmed = raw.trim();
  if (trimmed === '') return { issue: null, accepted: false };

  const result = validateUrl(trimmed, { context: 'config' });
  const issue = primaryIssue(result);
  if (result.blocking) return { issue, accepted: false };

  // The NORMALIZED url, never the typed one: an http:// link has already been
  // upgraded by the time it reaches here (§7.1 `mixed-content-http`).
  const state = runtime.store.getSnapshot();
  const current = validateVideoConfig(state.modules[videoModule.id]?.cfg);
  runtime.store.commit((s) => ({
    ...withModuleConfig(s, videoModule.id, videoModule.configVersion, {
      ...current,
      url: result.url,
    }),
    activeModuleId: videoModule.id,
  }));
  return { issue, accepted: true };
}

/**
 * The same gesture, for the module that is on the panel.
 *
 * @see pasteAction — the mapping that decides which of the two runs.
 *
 * Round 2's R9: the row under the halo is the app's ONE primary action, and it
 * was hard-wired to video — so with Image on screen the most prominent control
 * in the product asked for a video link, while the actual picture field hid two
 * clicks away inside the module's panel. The row takes the active module's noun
 * now, and for Image it *is* the picture field: same validation, same commit,
 * one string, one place.
 */
export function submitImageLink(runtime: ConfigRuntime, raw: string): LinkSubmission {
  const trimmed = raw.trim();
  if (trimmed === '') return { issue: null, accepted: false };

  const result = validateImageUrl(trimmed, { context: 'config' });
  const found = primaryImageIssue(result);
  // One `LinkSubmission` shape for both modules: the image validator's
  // `auto-fix` severity has no home-screen tone, and an upgrade the app performed
  // silently is not a warning to read.
  const issue: PasteIssue | null =
    found === null || found.severity === 'auto-fix'
      ? null
      : { severity: found.severity, message: found.message };
  if (result.blocking) return { issue, accepted: false };

  const state = runtime.store.getSnapshot();
  const current = validateImageConfig(state.modules[imageModule.id]?.cfg);
  runtime.store.commit((s) => ({
    ...withModuleConfig(s, imageModule.id, imageModule.configVersion, {
      ...current,
      url: result.url,
    }),
    activeModuleId: imageModule.id,
  }));
  return { issue, accepted: true };
}

// ---------------------------------------------------------------------------
// Which of the two the field IS, right now
// ---------------------------------------------------------------------------

/**
 * The one primary action, described in the active module's own noun (R9).
 *
 * Round 2's R9 gave the home screen's paste row this shape, and round 5's S1 is
 * the bill for leaving the mapping inside `HomeView`: the phone's field never
 * got it. The remote hard-wired `setVideo({ url })` and the words *"Paste a
 * video link"* / *"Play"* regardless of what was on the panel, so pasting a
 * `.jpg` with **Image** active wrote a picture URL into `modules.video.cfg.url`,
 * left `modules.image.cfg.url` undefined, printed the success receipt and left
 * the panel saying "No picture." The app claimed something it did not know to be
 * true, which is exactly the class this round is about.
 *
 * So the mapping lives here, next to the two submit functions it chooses
 * between, and both surfaces read it. A module added later gets a row on both
 * screens or on neither — it cannot get one on the screen whose author
 * remembered.
 */
export interface PasteAction {
  /** The module this row is currently the field for. */
  moduleId: string;
  /** The input's accessible name. */
  label: string;
  placeholder: string;
  submitLabel: string;
  submit: (raw: string) => LinkSubmission;
  /**
   * False for a field that keeps showing what it committed — the picture link.
   *
   * The row IS the picture field, so it behaves like the panel input it
   * replaced: it holds the link it is showing rather than emptying itself.
   */
  clearOnAccept: boolean;
  /**
   * What the module currently holds.
   *
   * The home row starts empty for video (`clearOnAccept`) and holds the picture
   * for image; the remote's row mirrors whatever is playing, for both. One
   * value, two policies, and neither surface has to know the other's.
   */
  value: string;
}

/**
 * `null` means the module has nothing to be handed — Clock and Stats.
 *
 * Both surfaces answer that the same way: the row becomes one quiet
 * *"Play something"* button that switches to video and hands the field the
 * caret, rather than a loud, irrelevant video field.
 */
export function pasteAction(
  runtime: ConfigRuntime,
  activeModuleId: string,
  opts: { narrow?: boolean } = {},
): PasteAction | null {
  const narrow = opts.narrow === true;
  const state = runtime.store.getSnapshot();

  if (activeModuleId === videoModule.id) {
    return {
      moduleId: videoModule.id,
      label: 'Paste a video link',
      placeholder: narrow ? 'Paste a video link' : 'Paste a video link — YouTube, MP4, HLS…',
      submitLabel: 'Play',
      submit: (raw) => submitVideoLink(runtime, raw),
      clearOnAccept: true,
      value: validateVideoConfig(state.modules[videoModule.id]?.cfg).url,
    };
  }

  if (activeModuleId === imageModule.id) {
    return {
      moduleId: imageModule.id,
      label: 'Paste a picture link',
      placeholder: narrow ? 'Paste a picture link' : 'Paste a picture link — JPG, PNG, WebP, GIF…',
      submitLabel: 'Show',
      submit: (raw) => submitImageLink(runtime, raw),
      clearOnAccept: false,
      value: validateImageConfig(state.modules[imageModule.id]?.cfg).url,
    };
  }

  return null;
}
