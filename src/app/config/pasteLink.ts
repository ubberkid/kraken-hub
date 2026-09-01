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
