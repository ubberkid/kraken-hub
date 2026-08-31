import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import { normalizeRepoUrl } from './src/buildInfo';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string; repository?: { url?: string } };

/**
 * `git+https://github.com/owner/repo.git` -> `https://github.com/owner/repo`.
 *
 * Read from package.json rather than written into `src/`, so a fork's in-app
 * documentation links point at the fork and invariant 4 (no hardcoded origins)
 * still holds. Empty when the manifest names no repository — callers must cope.
 */
function repoUrlSync(): string {
  return normalizeRepoUrl(pkg.repository?.url ?? '');
}

/** Short git SHA, or 'dev' outside a checkout (tarball installs, CI without git). */
function gitShaSync(): string {
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig(() => ({
  // I7: works at a project page (/kraken-hub/), a user page, a custom domain,
  // and http://127.0.0.1 alike. Never emit a root-relative asset URL.
  base: './',
  build: {
    // H18 is confirmed on CAM 4.76.5: Electron 32.1.0 / Chromium 128 (see the
    // hardware-checklist known results). `chrome108` is therefore conservative,
    // not wrong, and it stays — one CAM build on one machine is not a floor,
    // and an older CAM on an older PC is exactly what the margin is for.
    target: ['chrome108'],
    // No inline script → `script-src 'self'` stays possible.
    modulePreload: { polyfill: false },
    // Published: the app is MIT, debuggability beats obscurity.
    sourcemap: true,
    // Consumed by scripts/check-bundle-size.mjs.
    manifest: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        /**
         * Chunking is the mechanism behind invariant I8: the hidden Kraken
         * Browser must never download the configuration UI. Groups are ordered
         * by priority, and a group claims its matched modules AND their
         * dependencies — so `core` must outrank the two shells, or whichever
         * shell is listed first would swallow the shared platform/state code
         * and drag the configuration UI onto the LCD's critical path.
         */
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 100,
            },
            /*
             * Config-only code. Must not appear in the display graph.
             *
             * The second alternative sweeps every module's `*.tsx` settings
             * panel in here too. Panels are `.tsx` and every `module-*` group
             * matches `.ts$` only, so without this line each panel became its
             * own orphan chunk — one extra round trip per module, on the page
             * where round trips are cheapest and least useful. The module
             * groups outrank this one (92 > 90), so a panel's `schema.ts`
             * dependency still belongs to its module, not to config-ui.
             */
            {
              name: 'config-ui',
              test: /[\\/]src[\\/](?:ui|app[\\/]config)[\\/]|[\\/]src[\\/]modules[\\/].*\.tsx$/,
              priority: 90,
            },
            { name: 'display-shell', test: /[\\/]src[\\/]app[\\/]display[\\/]/, priority: 90 },
            // One chunk per module's display code. Config panels are .tsx and
            // split out on their own, so the LCD never pulls a panel in.
            /**
             * The video module's PLAYER — adapters, render controller, loop,
             * clip store, download manager. `index.ts` and `types.ts` are
             * excluded on purpose: the registry imports those eagerly for
             * validation and URL parsing, so leaving them here would drag the
             * whole player onto the LCD's first download. Everything else is
             * behind `loadDisplay()`.
             */
            /**
             * The two heavyweight media libraries, and ONLY them.
             *
             * The group tests match `node_modules` paths exclusively, which is
             * deliberate: a group claims its matched modules *and their
             * dependencies*, so a test that also named the adapter source file
             * would drag `src/lib/log.ts`, `src/platform/storage.ts` and the
             * shared adapter base out of `core`/`module-video` and into a
             * provider chunk — which is exactly how a 115 kB HLS library ends up
             * statically imported by the LCD's boot path. Measured, not feared:
             * that is what the first version of this config did.
             *
             * The adapters themselves are a few hundred bytes each and live in
             * `module-video`; only the library is worth its own chunk, and it is
             * fetched only when a manifest URL is actually played.
             *
             * `budgets.json` weighs every `provider-*` chunk individually, with
             * a documented per-chunk override for these two vendored libraries.
             */
            {
              name: 'provider-hls',
              test: /[\\/]node_modules[\\/]hls\.js[\\/]/,
              priority: 96,
            },
            {
              name: 'provider-dash',
              test: /[\\/]node_modules[\\/](?:dashjs|@svta)[\\/]/,
              priority: 96,
            },
            /**
             * The two cross-origin embed families and the resolver client, at a
             * priority BELOW `module-video` on purpose.
             *
             * A group claims its matched modules *and their dependencies*, so a
             * provider group ranked above `module-video` would drag the shared
             * adapter base, the geometry math and `src/platform/storage.ts` out
             * of the chunks that own them — which is how a lazily-imported
             * provider ends up statically imported by the LCD's boot path.
             * Ranking these last means they claim only the leftover leaf files.
             */
            /**
             * mqtt.js, and ONLY mqtt.js.
             *
             * Same rule as the two media libraries above: the test matches a
             * `node_modules` path exclusively, because a group claims its
             * matched modules *and their dependencies* — naming
             * `MqttTransport.ts` here would drag `src/lib/log.ts` and the
             * shared transport helpers out of `sync-core` and into this chunk,
             * and the transport would then be statically imported by anything
             * that touches the sync core.
             *
             * The library is ~110 kB gzip prebundled, which is why
             * `SyncService` reaches it through TWO dynamic imports (the
             * transport module, and mqtt.js inside it) and why nothing fetches
             * it unless a room is configured AND the transport preference
             * allows MQTT. `budgets.json` carries a measured override for it.
             */
            {
              name: 'sync-mqtt',
              test: /[\\/]node_modules[\\/]mqtt[\\/]/,
              priority: 96,
            },
            /**
             * The sync layer itself — service, envelope, crypto, transports.
             *
             * Ranked BELOW `core` (95) so the platform/state/lib modules it
             * depends on stay where they belong, and above the two shells so
             * neither shell swallows it. It is lazily imported from both
             * `mount.tsx` files, so it is not on the display's critical path
             * and is not counted in that budget — a display with no room
             * configured never fetches it at all.
             */
            /**
             * The diagnostics CORE — probes, report shape, and the `tele` wire
             * format for a remote report pull. `.ts` only, deliberately.
             *
             * `DiagView.tsx` imports `src/ui`, so a group that also matched
             * `.tsx` would claim the whole configuration component library as a
             * dependency — and the display lazily imports this chunk to answer
             * `requestDiag`, which would then be an invariant-I8 leak of the
             * config UI onto the LCD. Measured, not feared: that is exactly what
             * `npm run size` reported the first time this group did not exist
             * and rolldown left `src/diag/wire.ts` inside `config-ui`.
             *
             * Ranked above the two shells (90) so neither claims it, and above
             * `sync-core` (91) is unnecessary — nothing here imports a runtime
             * value from `src/sync`, on purpose (see `wire.ts`).
             */
            {
              name: 'diag-core',
              test: /[\\/]src[\\/]diag[\\/][^/\\\\]*\.ts$/,
              priority: 93,
            },
            {
              name: 'sync-core',
              test: /[\\/]src[\\/]sync[\\/]/,
              priority: 91,
            },
            {
              name: 'provider-embeds',
              test: /[\\/]src[\\/]modules[\\/]video[\\/]adapters[\\/](?:twitch|vimeo|streamable)\.adapter\.ts$/,
              priority: 91,
            },
            /**
             * `.ts` only, and that `$` is invariant I8 in one character.
             *
             * `resolver/` also holds the guided connect panel, which is a React
             * component that imports `src/ui`. This group outranks `config-ui`,
             * so an extension-agnostic test would pull the panel — and with it
             * the whole config vocabulary — into the chunk `display.ts`
             * dynamically imports for `resolverClient`, putting the
             * configuration UI on the LCD's network path. Same doctrine as
             * `module-video` above: config panels are `.tsx` and split out on
             * their own.
             */
            {
              name: 'provider-resolver',
              test: /[\\/]src[\\/]modules[\\/]video[\\/](?:resolver[\\/][^/\\\\]*\.ts$|adapters[\\/]resolver\.adapter\.ts$)/,
              priority: 91,
            },
            /**
             * The ingestion machinery — the download manager and the media
             * probing/thumbnailing it shares with manual upload — in its own
             * lazily-fetched chunk.
             *
             * It is the only part of the video module that BOTH pages want and
             * NEITHER page's first paint needs: the configuration UI's Sources
             * view imports it statically, and `display.ts` imports it
             * dynamically, at the one moment it is about to make a network
             * request anyway. Left in `module-video` it was ~1 kB gzip of pure
             * headroom away from breaching the 25 kB per-module budget, and
             * rolldown reported the dynamic import as INEFFECTIVE — a static
             * importer in another chunk pins a module in place unless a group
             * claims it outright.
             *
             * Ranked BELOW `module-video`, with the two files excluded from
             * that group's test — the same trick the embed/resolver groups use,
             * and for the same reason. A group claims its matched modules *and
             * their dependencies*, so ranking this one higher made it swallow
             * `clipStore.ts` and `videoTelemetry.ts`, which `display.ts` reads
             * on the cold-boot path; `module-video` then had to import this
             * chunk statically and the split bought nothing but a round trip.
             * Measured, not feared: that is what the first version of this
             * group did. Ranked last it claims only the two leaf files.
             */
            {
              name: 'module-video-ingest',
              test: /[\\/]src[\\/]modules[\\/]video[\\/]local[\\/](?:downloadManager|ingest)\.ts$/,
              priority: 91,
            },
            {
              name: 'module-video',
              test: /[\\/]src[\\/]modules[\\/]video[\\/](?!index\.ts$|types\.ts$|resolver[\\/]|local[\\/](?:downloadManager|ingest)\.ts$|adapters[\\/](?:twitch|vimeo|streamable|resolver)\.adapter\.ts$).*\.ts$/,
              priority: 92,
            },
            {
              name: 'module-clock',
              test: /[\\/]src[\\/]modules[\\/]clock[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            {
              name: 'module-image',
              test: /[\\/]src[\\/]modules[\\/]image[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            {
              name: 'module-stats',
              test: /[\\/]src[\\/]modules[\\/]stats[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            /**
             * The fit/safe-area math shared by every module that places a
             * rectangular source on the panel (video and image today).
             *
             * Ranked BELOW `core` (95) so its own dependencies — `src/lib/clamp`,
             * `src/platform/geometry` — stay in `core` where they belong, and
             * ABOVE the module groups (92) so neither `module-video` nor
             * `module-image` claims it and drags the other module's chunk in
             * behind it. It is a leaf: a couple of kB of pure math, fetched
             * alongside whichever module needs it, never on the display's
             * critical path.
             */
            {
              name: 'render-shared',
              test: /[\\/]src[\\/]render[\\/]/,
              priority: 94,
            },
            // Shared foundation both pages need; counted in the display budget.
            {
              name: 'core',
              // src/modules/*.ts (registry, types, defineModule) but NOT the
              // per-module directories: a module's React panel must stay out.
              test: /[\\/]src[\\/](?:(?:platform|state|lib|boot|config)[\\/]|modules[\\/][^/\\\\]*\.ts$)/,
              priority: 95,
            },
          ],
        },
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(process.env['GITHUB_SHA']?.slice(0, 7) ?? gitShaSync()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __REPO_URL__: JSON.stringify(repoUrlSync()),
  },
  plugins: [
    react(),
    tsconfigPaths(),
    process.env['ANALYZE']
      ? visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true })
      : null,
  ].filter(Boolean) as PluginOption[],
  // So CAM running on another machine can reach the dev server.
  server: { host: true },
}));
