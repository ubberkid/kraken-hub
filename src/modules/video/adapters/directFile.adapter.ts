/**
 * `direct-file` — a progressive MP4/WebM played straight off its URL
 * (design-videoEngine.md §1.2).
 *
 * This is the *streaming* path. Under the download-first product decision it is
 * the fallback, not the headline: when `downloadMode` is `auto` the module tries
 * to fetch the bytes into the clip library first and mounts `local-file`
 * instead; a CORS refusal is what silently lands us back here (telemetry
 * `download-cors-blocked`), and the user sees playback either way.
 *
 * No `crossorigin` attribute is set on purpose: plain progressive playback needs
 * no CORS at all, and asking for it turns a working video into a broken one on
 * every server that does not send `Access-Control-Allow-Origin`.
 */

import { createHtmlVideoAdapter, type HtmlVideoAdapter } from './HtmlVideoAdapterBase';

export function createAdapter(): HtmlVideoAdapter {
  return createHtmlVideoAdapter({
    id: 'direct-file',
    caps: {
      // Only true once the span is buffered; §3.4's promoter measures the truth.
      canSeekSilently: false,
    },
    resolveSrc: (ctx) => Promise.resolve(ctx.match.url),
  });
}
