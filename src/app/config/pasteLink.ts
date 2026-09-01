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

import { videoModule } from '../../modules/video';
import {
  primaryIssue,
  validateUrl,
  type ValidationIssue,
} from '../../modules/video/routing/validate';
import { validateVideoConfig } from '../../modules/video/types';
import { withModuleConfig } from '../../state/selectors';

import type { ConfigRuntime } from './runtime';

export interface LinkSubmission {
  /** The line to show under the input. `null` when the link is unremarkable. */
  issue: ValidationIssue | null;
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
