/**
 * `resolver` — playback through the localhost companion
 * (design-videoEngine.md §1.4, §6.4).
 *
 * When the companion is running this is the **best** playback path in the whole
 * app, and by a wide margin: the bytes arrive from `127.0.0.1` with `ACAO: *`
 * and `Accept-Ranges: bytes`, so there is no CORS problem, no player chrome, no
 * ads, real `pause()`, silent backward seeks, and full A-B looping. Everything
 * the geometry engine works around simply is not a problem here.
 *
 * The adapter is a thin shell on purpose: it asks `resolverClient` what the
 * stream is, and then mounts the *ordinary* machinery on the answer — a plain
 * `<video src>` for `progressive`/`file`, `attachHls` for `hls`, `attachDash`
 * for `dash`. There is no resolver-specific playback code, which is what keeps
 * the companion optional in the strongest sense: nothing downstream of the
 * `streamUrl` knows it exists.
 *
 * `setPreresolved()` is the handoff from `display.ts`. The display resolves
 * first so it can run the download-first path (fetch the loopback stream into
 * the IndexedDB clip library, so the clip keeps playing once the companion is
 * stopped); handing the envelope over avoids asking the companion twice.
 */

import { ladderUpTo } from '../quality';
import { publish } from '../telemetry/videoTelemetry';

import { createHtmlVideoAdapter, type HtmlVideoAdapter } from './HtmlVideoAdapterBase';
import { videoError } from './VideoAdapter';

import type { DashHandle } from './dash.adapter';
import type { HlsHandle } from './hls.adapter';
import type { ResolverEnvelope, ResolverOk } from '../resolver/resolverTypes';

/** A one-slot handoff from `display.ts`; consumed exactly once. */
let preresolved: { url: string; envelope: ResolverOk } | null = null;

export function setPreresolved(url: string, envelope: ResolverOk): void {
  preresolved = { url, envelope };
}

export function clearPreresolved(): void {
  preresolved = null;
}

function takePreresolved(url: string): ResolverOk | null {
  if (preresolved?.url !== url) return null;
  const { envelope } = preresolved;
  preresolved = null;
  return envelope;
}

export function createAdapter(): HtmlVideoAdapter {
  let hls: HlsHandle | null = null;
  let dash: DashHandle | null = null;

  const adapter = createHtmlVideoAdapter({
    id: 'resolver',
    caps: {
      // Loopback, Range-capable, progressive: every one of these is true here
      // and false almost everywhere else.
      canSeekSilently: true,
      canSetQuality: true,
      canReadQuality: false,
      hasOwnChrome: false,
      canTruePause: true,
    },

    attach: async (el, ctx) => {
      const url = ctx.match.url;
      let envelope: ResolverEnvelope | null = takePreresolved(url);

      if (envelope === null) {
        const { resolveOrFallback } = await import('../resolver/resolverClient');
        const { deriveMaxHeight } = await import('../resolver/resolverClient');
        if (ctx.signal.aborted) return;
        envelope = await resolveOrFallback(url, ctx.config.resolver, {
          maxHeight: deriveMaxHeight({
            displayW: ctx.display.width,
            displayH: ctx.display.height,
            dpr: ctx.display.dpr,
            zoom: ctx.config.render.zoom,
          }),
          audio: ctx.config.audioEnabled,
          signal: ctx.signal,
        });
      }
      if (ctx.signal.aborted) return;

      if (envelope.status !== 'ok') {
        // The caller (display.ts) is expected to have downgraded already; if it
        // did not, this is a real error rather than a silent fallback, because
        // by now there is nothing else left to try.
        ctx.emit({
          type: 'error',
          err: videoError(
            'provider-unavailable',
            'The resolver companion could not produce a stream for this link.',
            'resolver',
            url,
          ),
        });
        return;
      }

      /*
       * The resolver cannot enumerate renditions — yt-dlp already chose one —
       * but it DOES report the source height, and that is a real ceiling. So
       * the offer is the standard ladder capped there: every rung below the
       * source is genuinely obtainable, by asking the companion again with a
       * lower `maxHeight`. Nothing above it is offered, because nothing above
       * it exists.
       */
      ctx.emit({ type: 'levels', levels: ladderUpTo(envelope.height ?? 0) });

      publish({
        code: 'resolver-stream',
        severity: 'info',
        provider: 'resolver',
        message: envelope.kind,
        detail: { height: envelope.height ?? 0, mime: envelope.mime },
      });

      if (envelope.kind === 'hls') {
        const { attachHls } = await import('./hls.adapter');
        hls = await attachHls({
          el,
          url: envelope.streamUrl,
          ctx,
          caps: adapter.capabilities,
          provider: 'resolver',
        });
        return;
      }

      if (envelope.kind === 'dash') {
        const { attachDash } = await import('./dash.adapter');
        dash = await attachDash({
          el,
          url: envelope.streamUrl,
          ctx,
          caps: adapter.capabilities,
          setMuted: (m) => {
            adapter.setMuted(m);
          },
          provider: 'dash',
        });
        return;
      }

      // `progressive` / `file`: the plain, boring, perfect case.
      el.src = envelope.streamUrl;
      el.load();
    },

    detach: () => {
      hls?.destroy();
      hls = null;
      dash?.destroy();
      dash = null;
    },

    quality: {
      // §6.4 — quality on this path means *re-resolving* at a different
      // `maxHeight`, which is a source change the host owns. Within one mount,
      // only an MSE ladder can move.
      set: (h) => Promise.resolve(hls?.setQuality(h) ?? dash?.setQuality(h) ?? false),
      get: () => hls?.getQuality() ?? dash?.getQuality() ?? { height: null, label: null },
    },
  });

  return adapter;
}
