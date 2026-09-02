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
            /**
             * The display's SYNC half — `sync.ts` and the replica feed it
             * drives — which the LCD downloads only when a room is configured.
             *
             * Both files live under `src/app/display/`, so the path-based
             * `display-shell` group claimed them and `displayCriticalPath`
             * weighed ~3 kB gzip that a display with no room never executes.
             * `mount.tsx` reaches `sync.ts` through `await import('./sync')`
             * and `sync.ts` reaches `replicaFeed.ts` the same way, so nothing
             * on the first-paint path imports either one — the bytes were on
             * the budget because of where the files sit, not because the LCD
             * needs them to show a frame. Same doctrine as `transfer` and
             * `diag-core`: a feature that only fires when somebody configures
             * a room must not cost the LCD's first paint.
             *
             * Listed BEFORE `display-shell` and at the same priority, and
             * `display-shell`'s test excludes the two files by name — the
             * ordering and the lookahead say the same thing twice on purpose.
             * It must NOT outrank `sync-core` (91): `sync.ts` statically
             * imports `src/sync/position` and dynamically imports
             * `src/sync/appSync`, and a group claims its matched modules AND
             * their dependencies, so a higher rank would swallow the whole
             * sync layer into a chunk the display fetches.
             *
             * The chunk still contains `src/app/display/` modules, so
             * `check-bundle-size.mjs` treats it as display-owned and keeps
             * following its dynamic edges for the invariant-I8 walk.
             */
            {
              name: 'display-lazy',
              test: /[\\/]src[\\/]app[\\/]display[\\/](?:sync|replicaFeed)\.ts$/,
              priority: 90,
            },
            {
              name: 'display-shell',
              test: /[\\/]src[\\/]app[\\/]display[\\/](?!(?:sync|replicaFeed)\.ts$)/,
              priority: 90,
            },
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
             * The nine kinds' STRIP declarations — `<kind>/editor.ts` — and the
             * house ink table they share, in ONE small lazily-fetched chunk.
             *
             * Each declaration is a few hundred bytes of config-only data, and
             * `[^/\\]*\.ts$` in every `module-*` group matches `editor.ts`, so
             * without this group each kind's strip rode that kind's DISPLAY
             * chunk. The editor is not the display: selecting a video layer for
             * the first time would have fetched the 24 kB player to find out
             * which five controls to draw. Nine strips in one chunk is also one
             * round trip instead of nine, on a page where a person selects
             * layers of several kinds in a row.
             *
             * Ranked ABOVE the module groups (92) so they cannot claim their
             * own `editor.ts` back, and BELOW `lazy-shared` (94) and `core`
             * (95) so the declarations' dependencies — `modules/types.ts`, the
             * strip contract — stay in the chunks that own them rather than
             * being dragged in behind a group that claims its matched modules
             * AND their dependencies.
             *
             * `swatches.ts` is here rather than in `core` for the same reason
             * `replicaThumb.ts` is in `lazy-shared`: `core` claims
             * `src/modules/*.ts` by PATH, so the shared ink table sat on the
             * LCD's first download to answer a question — what "Amber" is —
             * that only an `editor.ts` ever asks. `core`'s test carries the
             * matching negative lookahead, because a group cannot claim what a
             * higher-priority group's test already matched.
             */
            {
              name: 'module-editors',
              test: /[\\/]src[\\/]modules[\\/](?:[^/\\\\]+[\\/]editor|swatches)\.ts$/,
              priority: 93,
            },
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
            /**
             * The LAN file transfer — protocol, sender and receiver.
             *
             * Its own chunk for exactly the reason `diag-core` has one: the
             * DISPLAY lazily imports the receiver to answer a `transferOffer`,
             * and anything under `src/app/display/` belongs to `display-shell`,
             * which IS weighed in `displayCriticalPath`. A feature that only ever
             * fires when somebody points a phone at it must not cost the LCD's
             * first paint a single byte, so it lives outside both shells and both
             * shells reach it dynamically.
             *
             * Ranked above the two shells (90) so neither claims it, and above
             * `config-ui` (90) so the sender does not drag the configuration UI
             * into the chunk the display fetches. Nothing in `src/transfer`
             * imports `src/ui` or `src/app/config` — eslint's layering zones say
             * so, and `displayGraph` (I8) proves it on every build.
             */
            {
              name: 'transfer',
              test: /[\\/]src[\\/]transfer[\\/]/,
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
            {
              name: 'module-text',
              test: /[\\/]src[\\/]modules[\\/]text[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            {
              name: 'module-shape',
              test: /[\\/]src[\\/]modules[\\/]shape[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            {
              name: 'module-icon',
              test: /[\\/]src[\\/]modules[\\/]icon[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            {
              name: 'module-date',
              test: /[\\/]src[\\/]modules[\\/]date[\\/][^/\\\\]*\.ts$/,
              priority: 92,
            },
            /**
             * The effect RUNNER — manifest, schema, motion, the loader in
             * `effects.ts` — and deliberately NOT `effects/`.
             *
             * `[^/\\]*\.ts$` matches direct children only, so the twelve
             * fragment sources under `src/modules/effect/effects/` are outside
             * this group by construction. That is the point: each one is behind
             * a dynamic import in `effects.ts`, so the bundler gives it its own
             * chunk and a panel downloads the ~1.5 kB for the effect it is
             * actually showing instead of ~19 kB of GLSL for twelve. Widening
             * the test to `.*\.ts$` would fold all twelve into `module-effect`
             * and walk it straight at the 25 kB per-module budget —
             * `budgets.json`'s `perModuleChunk.note` says the same thing from
             * the budget's side.
             */
            {
              name: 'module-effect',
              test: /[\\/]src[\\/]modules[\\/]effect[\\/][^/\\\\]*\.ts$/,
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
            /**
             * Shared LEAVES that live in `core`'s directories but that NOTHING
             * on the display's first-paint path imports.
             *
             * `core` claims by PATH, not by importer, so every file under
             * `src/platform/`, `src/lib/`, `src/config/` and `src/modules/*.ts`
             * landed in the one chunk the LCD downloads before it can paint —
             * including eight modules whose only importers are lazy:
             *
             *   platform/mediaStore.ts   IndexedDB media layer: the two module
             *   platform/idb.ts          stores, `display/sync.ts`, config
             *   modules/replicaThumb.ts  thumbnails for the phone's mini-halo
             *   platform/capabilities.ts diagnostics probes only
             *   config/knownHosts.ts     video adapters + config views
             *   config/vocabulary.ts     config views + `.tsx` module panels
             *   lib/curation.ts          `display/sync.ts` (dynamic) only
             *   lib/chunkedTele.ts       diag/wire, replicaFeed, config sync
             *   lib/libraryPacket.ts     config `useSync`, `display/sync.ts`
             *
             * `vocabulary.ts` is the sentence bank the configuration UI speaks
             * in; the display shows none of it. It stayed on the LCD's first
             * download only because video's manifest wanted two words from it —
             * and those two now live in the dependency-free `config/words.ts`,
             * which STAYS in `core` because the display genuinely reads it.
             *
             * `libraryPacket.ts` earns its place twice over: it is lazy-only
             * itself, and it STATICALLY imports `mediaStore` and `chunkedTele`.
             * Leaving it in `core` left those two in `core` as well — a group
             * claims its matched modules and their dependencies, and `core`
             * outranks this one, so excluding a leaf without excluding its
             * static importer moves nothing. Measured, not feared: that is what
             * the first version of this group did.
             *
             * A static-import walk from `src/app/display/mount.tsx` reaches
             * none of them; they were ~4.8 kB gzip of `displayCriticalPath`
             * bought by directory layout. Here they are one leaf chunk fetched
             * alongside whichever lazy chunk actually wants them.
             *
             * Ranked BELOW `core` (95) so their own dependencies —
             * `src/lib/log`, `src/state/look/types` — stay where they belong,
             * and ABOVE the module groups (92) so neither `module-video` nor
             * `module-image` claims the media store and drags the other
             * module's chunk in behind it. The `core` test carries the matching
             * negative lookahead: a group cannot claim what a higher-priority
             * group's test already matched.
             *
             * This is NOT re-labelling. Every file here is behind a dynamic
             * import from the display's side; if one ever becomes a static
             * import of `mount.tsx` or `DisplayApp.tsx`, it must come back to
             * `core` rather than stay hidden in this chunk.
             */
            {
              name: 'lazy-shared',
              test: /[\\/]src[\\/](?:platform[\\/](?:mediaStore|idb|capabilities)|lib[\\/](?:curation|chunkedTele|libraryPacket)|config[\\/](?:knownHosts|vocabulary)|modules[\\/]replicaThumb)\.ts$/,
              priority: 94,
            },
            /**
             * The Look FILE — the `.krakenlook` reader/writer and the ten
             * shipped Looks. Two files, one chunk, and neither is on the LCD's
             * path.
             *
             * `templates.ts` is ~9 kB of designed arrangements and `file.ts` is
             * the importer/exporter; both live under `src/state/`, so `core`
             * claimed them by path and put them on the LCD's first download —
             * where they pay for a menu the panel cannot open and a file picker
             * it has no file manager for. MEASURED, not feared: wiring the Looks
             * sheet up took `displayCriticalPath` from 88.4 kB to 90.6 kB
             * against a 90 kB gate, and this group took it back to 88.6 kB.
             *
             * A dynamic edge alone does not move a module out of a chunk group
             * that claims it — the group has to stop matching. So this is the
             * `lazy-shared` shape exactly: a group ranked BELOW `core` (95) with
             * a matching negative lookahead in `core`'s own test, which is what
             * actually frees the files.
             *
             * Ranked below `core` so the dependencies stay put — `look/types.ts`,
             * `look/validate.ts`, `state/schema.ts`, `state/migrations.ts` are
             * all things the DISPLAY genuinely reads. A higher rank would drag
             * the document's whole state layer into a lazily-fetched chunk,
             * which is the trap every group above this one documents.
             *
             * Nothing under `src/app/display` or `src/render` imports either
             * file, and the `displayGraph` (I8) walk fails the build if that
             * changes.
             */
            {
              name: 'looks',
              test: /[\\/]src[\\/]state[\\/]look[\\/](?:templates|file)\.ts$/,
              priority: 94,
            },
            // Shared foundation both pages need; counted in the display budget.
            {
              name: 'core',
              // src/modules/*.ts (registry, types, defineModule) but NOT the
              // per-module directories: a module's React panel must stay out.
              // The leading lookahead hands the eight lazy-only leaves to
              // `lazy-shared`, the two Look files to `looks` and the shared ink
              // table to `module-editors` — see those groups for why they are
              // not `core`.
              test: /[\\/]src[\\/](?!platform[\\/](?:mediaStore|idb|capabilities)\.ts$|lib[\\/](?:curation|chunkedTele|libraryPacket)\.ts$|config[\\/](?:knownHosts|vocabulary)\.ts$|modules[\\/](?:replicaThumb|swatches)\.ts$|state[\\/]look[\\/](?:templates|file)\.ts$)(?:(?:platform|state|lib|boot|config)[\\/]|modules[\\/][^/\\\\]*\.ts$)/,
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
