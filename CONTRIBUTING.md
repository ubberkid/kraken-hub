# Contributing to kraken-hub

Thanks for looking. This project is small, strict about a handful of platform
constraints, and deliberately honest about what it has and has not verified on
real hardware.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## The most useful thing you can do

**Submit a [hardware report](https://github.com/ubberkid/kraken-hub/issues/new?template=hardware_report.yml).**

Most of what kraken-hub believes about the Kraken LCD comes from NZXT's
documentation plus one maintainer's Kraken Elite. Kraken Plus and Kraken Z rows
in the docs are essentially empty. The About page produces the JSON for you —
click the version line in the footer, then **Report → Copy report** — and
pasting it into the form is a five-minute contribution with an outsized effect.

Every claim in the docs that has not been measured carries the literal marker
`⚠ not verified on hardware` and links to an H-id in
[`docs/hardware-checklist.md`](docs/hardware-checklist.md). Closing an H-id means sweeping the docs for its
marker.

## Dev setup

Requirements: **Node 22** (see [`.nvmrc`](.nvmrc); the engine range is
`>=20.19 <23`) and npm. No other global tooling.

```bash
nvm use
npm ci
npm run dev
```

Then open:

| URL                               | What it is                                                 |
| --------------------------------- | ---------------------------------------------------------- |
| `http://localhost:5173/`          | the Configuration UI (what CAM's _Configure_ button opens) |
| `http://localhost:5173/?kraken=1` | the display surface (what the LCD shows)                   |
| `http://localhost:5173/#/remote`  | the phone remote                                           |
| `http://localhost:5173/#/about`   | About and diagnostics (`#/diag` still resolves here)       |

### Developing without a Kraken

Everything except the final hardware validation is developable in the browser via
the simulator, which mocks `window.nzxt` and the monitoring feed:

| Parameter                             | Effect                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| `?sim=elite\|plus\|z\|kraken2023`     | sets `width` / `height` / `shape`                              |
| `?fps=<n>`                            | fakes `targetFps`                                              |
| `?monitor=idle\|load\|spike\|missing` | drives fake `MonitoringData` at 1 Hz                           |
| `?inject=late`                        | delays the fake injection by 900 ms, exercising the retry path |
| `?transport=fake`                     | remote-control work without touching a broker                  |

Simulator parameters are ignored whenever a real `window.nzxt` is present, so
they can never affect a real device.

## The one command

```bash
npm run check
```

That runs, in order: `typecheck`, `lint`, `invariants`, `format:check`, `test`,
`build`, `size`. CI runs the same steps as separately named steps so failures are easy to
read. If `npm run check` is green, CI will be too.

Useful pieces on their own:

```bash
npm run lint:fix     # eslint --fix
npm run format       # prettier --write .
npm run test:watch   # vitest in watch mode
npm run test:e2e     # Playwright (Chromium only)
npm run analyze      # bundle treemap
```

### Git hooks are not installed for you

There is no `prepare` script and no husky. `npm ci` will never rewrite your git
configuration. If you want the pre-commit `lint-staged` run, opt in explicitly:

```bash
npm run hooks:install     # git config core.hooksPath .githooks
git config --unset core.hooksPath   # to undo
```

CI is the enforcement point. Hooks are a convenience.

## Adding a module

Everything the LCD shows is a module — the video player included. Adding one is
a directory under `src/modules/` and a line in `src/modules/registry.ts`, with
no build configuration, no route and no state migration to touch.

[`docs/modules.md`](docs/modules.md) is the walkthrough: it builds the Clock
module step by step and covers the `KrakenModule` interface, the imperative
display-renderer contract, safe-area and `targetFps` degradation, config-panel
conventions, the 25 kB per-module chunk budget, URL parameters and what the
tests are expected to cover. [`src/modules/_template/`](src/modules/_template/)
is a copyable skeleton, deliberately unregistered.

## The platform invariants

These are not style preferences. Each one, violated, produces a black or frozen
LCD that is painful to debug — so each is enforced by a lint rule.

| #   | Invariant                                         | Why                                                                                                                                                                                  | Enforced by                                                                                                                                      |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Never assign to `window.nzxt` or `window.nzxt.v1` | Replacing the object destroys CAM's injected `width`/`height`/`shape`/`targetFps`. NZXT's own sample gets this wrong. Property-assign, with retry — injection can land after `load`. | `no-restricted-syntax`; allowed only in `src/platform/nzxt.ts` and `src/platform/simulator.ts`                                                   |
| 2   | Never navigate                                    | The Kraken Browser does not follow navigations. No `pushState`, `location.assign`, `location.href =`. Hash-only routing, and none of it in display mode.                             | `no-restricted-properties` / `no-restricted-syntax`; no file is excepted                                                                         |
| 3   | Storage only through the wrappers                 | Many forks share the single `github.io` origin; every key is namespaced, and reset must not touch a neighbour's keys.                                                                | `no-restricted-globals` on `localStorage`/`sessionStorage`, `indexedDB.open`; `src/platform/storage.ts` and `src/platform/idb.ts` excepted       |
| 4   | No hardcoded origins                              | A fork must work from its own hostname. Twitch `parent` and YouTube `origin` are derived at runtime; this is _the_ fork-breaker.                                                     | `no-restricted-syntax`; `src/config/knownHosts.ts` and `src/sync/endpoints.ts` excepted                                                          |
| 5   | No hardcoded device sizes                         | 640 is one device. Geometry comes from props.                                                                                                                                        | `no-magic-numbers` in `src/modules/**` and `src/app/display/**`, plus `npm run invariants` (`scripts/check-invariants.mjs`) across all of `src/` |
| 6   | Respect the layering                              | `platform` imports neither modules, providers, nor app; modules never import each other; providers never import modules; sync never imports app.                                     | `import-x/no-restricted-paths`                                                                                                                   |
| 7   | No default exports outside manifests              | Keeps the dynamic-import registry mechanical and greppable.                                                                                                                          | `import-x/no-default-export`                                                                                                                     |
| 8   | Nothing from a CDN                                | Strict CSP, reproducible builds, and an offline demo all depend on it.                                                                                                               | `no-restricted-syntax`                                                                                                                           |

## Testing

- **Unit (Vitest).** All pure logic: geometry and crop math, fit math, state
  migrations, precedence, room codes and crypto, URL routing and validation.
  `*.test.ts` runs in node; `*.dom.test.ts` and `*.test.tsx` run in jsdom.
- **E2E (Playwright, Chromium only).** The target is a Chromium webview; other
  engines would be misleading and triple CI time.
- **Transports.** A reusable contract suite runs against an in-memory
  `FakeTransport` on every CI run. **PR CI never contacts a public broker.**
  Live smoke tests are opt-in:

  ```bash
  KRAKEN_HUB_LIVE=1 npm run test:live
  ```

  They use a fresh random topic, send at most a handful of messages, and clear
  their retained message at teardown. There is also a documented local
  `mosquitto` recipe if you would rather not touch a public broker at all.

- **Companion extractor.** Every test in `companion/resolver/test/` injects a
  stub downloader, so the suite is hermetic — but that leaves `yt-dlp`'s own
  interface, and the companion's hard-coded `video/mp4` promise, untested.
  `companion/resolver/test-live/` closes that with one real extraction of a
  small CC-licensed clip, asserting the mp4 magic bytes on disk and the
  `202 → /job → /stream` flow with a Range request. It lives behind its own
  Vitest config, so `npm test` and `npm run check` never load it, and it is
  included in the same command:

  ```bash
  npm run test:live
  ```

  It **never installs anything**: with no `yt-dlp` (or `ffmpeg`) on `PATH` it
  skips and says so. Point `KRAKEN_HUB_YTDLP` at a binary, or
  `KRAKEN_HUB_LIVE_URL` at a different clip, to steer it.

## Bundle budgets

The display path is the budget that matters — it is what the hidden Kraken
Browser downloads before the LCD shows anything. `budgets.json` declares the
limits and `npm run size` enforces them from the real build manifest. The
display critical path is capped at **90 kB gzip**, a module chunk at **25 kB**.

If you need more, that is a design conversation (and probably an ADR), not a
budget bump.

## Commits, PRs, and the changelog

- Merges are **squashes**, so the **PR title** is the commit subject — write it
  as a [Conventional Commit](https://www.conventionalcommits.org/)
  (`feat: add clock module`, `fix(video): stop the end screen appearing`). There
  is no commitlint bot; review catches it.
- Every PR that touches `src/**` adds a line under `## [Unreleased]` in
  [`CHANGELOG.md`](CHANGELOG.md). CI warns when it does not.
- Anything that renders on the LCD needs a screenshot **at the real device size**.
  A scaled screenshot hides exactly the problems that matter on a small circular
  panel.

## Docs style

Sentence-case headings. No marketing adjectives. Every factual claim gets a
source link; every claim not measured on hardware gets the
`⚠ not verified on hardware` marker and an H-id link. Screenshots at 2× and
under 300 kB.

## Where to ask

Open a [Discussion](https://github.com/ubberkid/kraken-hub/discussions) for questions, ideas, and show-and-tell.
Issues are for actionable bugs, feature proposals, and hardware reports.
