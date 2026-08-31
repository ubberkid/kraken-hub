# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Semver for a continuously deployed app, as used here:

- **major** — a state-schema migration a downgrade cannot read, or the removal of
  a module, provider, or URL parameter.
- **minor** — a new module, provider, or setting.
- **patch** — fixes and documentation.

Deployment is decoupled from versioning: `main` deploys continuously, and tags
document state rather than gating a release.

## [Unreleased]

Everything below is the content of the forthcoming **v1.0.0**: milestones M0
through M4, written up as they landed. There is no released version yet, so the
whole history lives in one section rather than being split across tags that never
existed. Promoting it is a rename — `## [1.0.0] - <date>` — after which
`.github/workflows/release.yml` extracts exactly this text as the release body.

The one thing standing between this section and that rename is hardware:
[`docs/hardware-checklist.md`](docs/hardware-checklist.md) H01–H23, and the list
in [`docs/BEFORE-PUBLISHING.md`](docs/BEFORE-PUBLISHING.md).

### Added

- **M4 — documentation, screenshots, and the release plumbing.** The parts of the
  launch milestone that do not need a Kraken on a desk.
  - **`npm run capture` (`scripts/capture-media.mjs`).** Every screenshot the
    documentation ships is _generated_ from the built app, not hand-cropped: the
    script builds, boots `vite preview`, drives Chromium through the real display
    boot path inside the hardware simulator, and writes `docs/assets/hero.gif`,
    `hero.png`, `config-ui.png`, `remote.png`, `diag.png` and
    `public/preview-640.png`. Re-run it after a UI change and commit the diff.
    Deliberately **not** part of `npm run check` — it builds, opens a socket and
    writes binaries into the tree, none of which belongs in a check that has to
    be deterministic. Two details worth knowing: `public/preview-640.png` has an
    external contract (NZXT's submission spec wants 640×640) so the script
    _asserts_ the emitted dimensions rather than assuming them; and the remote
    capture runs with `?transport=fake`, because a documentation build has no
    business touching a public broker.
  - **`docs/getting-started.md`, `docs/self-hosting.md`,
    `docs/troubleshooting.md`, `docs/nzxt-submission.md`, `docs/README.md`.** The
    remaining user-facing documentation, plus an index. `docs/README.md` carries a
    **Known gaps** section listing what the design intended and did not ship —
    the reset-all-data button, the path-scoped storage namespace, the unbuilt H19
    probe — so nobody has to discover them by being surprised.
  - **`docs/BEFORE-PUBLISHING.md`.** Every placeholder that needs a real GitHub
    slug, every setting that lives in the GitHub UI rather than in the tree
    (Pages source, private vulnerability reporting, Discussions), the Code of
    Conduct contact, and the hardware work — in one checklist, with the `grep`
    that proves it is finished. Linked from the top of the README while the
    repository is unpublished.
  - **`.github/workflows/release.yml`.** On a `vX.Y.Z` tag: build, re-run the
    bundle budgets, assert the tag matches `package.json`, extract that version's
    section from `CHANGELOG.md` with the new
    `scripts/changelog-section.mjs`, and create the GitHub Release with the built
    site attached. The release body is the text a human already wrote and
    reviewed, never a generated commit list, and a tag pushed without a changelog
    section fails the job instead of publishing an empty release.
  - **`.github/workflows/link-check.yml`.** lychee over every markdown file, in
    two jobs with different contracts: internal links and anchors run
    `--offline` and **block** a docs PR, because a rename must not land with
    dangling links; external links run weekly and are advisory, filing an issue
    rather than failing, because a contributor should never be blocked by
    somebody else's server. `.lycheeignore` holds the unavoidable
    placeholder-slug entries, each with its reason, and it shrinks to nothing
    once the repository has a real name.
- **M3 — the three remaining modules, and the guide that produced them.**
  `docs/modules.md` was written FIRST, as a complete walkthrough of authoring a
  module, and the Clock module was then built by literally following it. Three
  places where the guide turned out to be wrong or incomplete were fixed as a
  result, which was the point of the exercise:
  - it claimed five files per module; there are six (the CSS file is part of the
    module and rides in its lazy chunk);
  - it asserted that `index.ts` and `schema.ts` stay out of the module chunk. They
    do — but because rolldown hoists what the registry imports eagerly into
    `core`, not because the group regex excludes them. The guide now says which
    of those two facts is a guarantee (neither) and which test would catch it
    changing (the e2e chunk-isolation assertion);
  - it said nothing about the two things that then bit all three modules —
    `[hidden]` losing to a class rule that sets `display`, and `reinit()` being
    the wrong place to re-arm a timer.
- **Clock module (`clock`).** Digital and analog faces, 12/24-hour, seconds on or
  off, an optional date line, and five flat colour themes. Every visual state is
  a function of the current wall-clock second and nothing animates, so the module
  is _correct_ at CAM's 1 FPS factory default and at the Kraken Z's hard 1 FPS
  ceiling — the second hand ticks, it never sweeps, and the analog dial is built
  once and then moved with three `setAttribute` calls per second. A `paintKey()`
  guard turns the other 39 of every 40 frame ticks into a string compare and
  zero DOM mutations. No `Intl`: it would drag ICU onto the display path and make
  the output depend on a host locale nobody controls inside CAM's webview.
- **Image module (`image`).** A direct picture or GIF link, or an image from its
  own library, with the video module's fit / zoom / pan / rotate math, a
  background colour and an optional slideshow (10 s floor). Download-first, like
  video: the display page fetches the bytes into IndexedDB and paints the local
  copy from then on, so the picture survives a reboot with the network unplugged;
  a CORS refusal is not an error and falls back silently to streaming the remote
  URL into `<img>`. GIFs render as a plain `<img>` so the browser animates them —
  what reaches the LCD is governed by CAM's capture rate, which the panel says
  out loud (`animated-capture-fps`).
- **System stats module (`stats`).** CPU and GPU temperature and load plus
  `kraken.liquidTemperature`, from the existing 1 Hz monitoring feed, in three
  layouts: single dial, dual dial, compact grid. Every field of that feed is
  `number | undefined` and every one of them degrades **per tile** to `--`, never
  to `NaN` and never to a dial parked at zero (a missing reading draws the track
  alone, because an empty arc reads as "0 °C"). There is **no pump RPM**: CAM
  exposes no such field, and the panel says so rather than inventing a plausible
  number for a display people use to judge whether their loop is healthy. A
  "waiting for CAM data" state appears when no sample has arrived for 5 s. Flat
  fills, one stroke per dial, no gradient or blur — the low-entropy rendering the
  compression guidance asks for — and a discrete 1 Hz update regardless of
  `targetFps`, which is why the module does not subscribe to the frame clock at
  all.
- **URL parameters `face` (clock) and `layout` (stats)**, alongside the existing
  `src` which the image module reuses: `?module=clock&face=analog`,
  `?module=stats&layout=grid`, `?module=image&src=…`.
- **`tests/e2e/modules.spec.ts`** — every module rendered at 640 round, 320 round
  and 240 square with no console error and nothing painted outside the panel;
  stats under `?monitor=missing` (placeholders, no `NaN`, no invented pump); the
  "waiting for CAM data" state; the image slideshow advancing on a Playwright
  fake clock; and a **chunk-isolation assertion** — booting one module must fetch
  that module's chunk and no other module's, and no `config-ui`.
- **Image library in IndexedDB** (`images` / `imageBlobs`, database version 3).
  Separate stores rather than a `kind` field on `clips`: the upgrade is then
  purely additive, so an interrupted `versionchange` cannot leave the existing
  video library half-migrated, and no video query has to filter on `kind`
  forever.

### Changed

- **The repository slug is real.** Every placeholder owner/repo and Pages URL is
  now `ubberkid/kraken-hub` and `https://ubberkid.github.io/kraken-hub/`
  (the literals are deliberately not repeated here, so the grep in
  `docs/BEFORE-PUBLISHING.md` keeps meaning what it says): `package.json` and
  `companion/resolver/package.json` (the first one is load-bearing — Vite turns
  it into `__REPO_URL__`, which every in-app documentation link is built from),
  the README badges and both one-click CAM install links, the `[unreleased]`
  changelog link reference, the issue-template contact links,
  `docs/nzxt-submission.md`, `docs/troubleshooting.md` and
  `docs/getting-started.md`. The README's **SET YOUR REPO** comment block is
  deleted; the "not published yet" note stays until the repository actually is.
  `docs/BEFORE-PUBLISHING.md` keeps the list, ticked, because the next fork
  needs the map.
- **Issue and discussion links are absolute, and `.lycheeignore` shrank by four
  entries.** GitHub's fork-relative `../../issues/new?template=…` form had to be
  excluded from the link checker wholesale, and that exclusion is exactly how
  `docs/hardware-checklist.md`'s wrong-depth copy of it (`../../` from a file one
  directory deep resolves to `/owner/repo/blob/issues/new` — a 404) stayed
  invisible to CI. Now that the slug is real the links are written out in full,
  the two placeholder-slug ignores and the two relative-form ignores are gone,
  and lychee checks all of them.
- **The stats module fills the biggest panel.** Its dial box was the largest
  square inside the safe area — the right bound for the text-first `grid`
  layout, and the wrong one for a _circle_, which does not need that square's
  corners. On a 640 round panel the two dials used barely a quarter of the
  height and read as an island in the middle of the glass. The box now grows
  toward the visible disc as the panel gets bigger: the single dial goes from
  ~53 % to ~69 % of panel height and the dual row from ~29 % to ~39 % (a row of
  two dials is bounded by the panel's _width_; ~39 % is the honest ceiling, not
  a compromise). The growth is a ramp keyed to panel size, so the 320 and 240
  panels are unchanged to the pixel — asserted, along with the disc-fit maths,
  in the new `src/modules/stats/layout.test.ts`. The rendering stays flat and
  low-entropy; only the sizes moved.
- **The module e2e suite has the `MODULES` table it promised.** `docs/modules.md`
  §11 and the spec's own header both claimed a new module was one row away from
  full coverage, while `tests/e2e/modules.spec.ts` actually hand-wrote a test
  body per module and named the modules again in three more places. It is now
  one table — id, chunk name, boot query, optional network setup, and one
  assertion per thing worth checking on a panel — driving both the preset matrix
  and the chunk-isolation tests. Nothing below the table names a module. Also
  corrected: §7's `summary` line, which had dropped the word "optional".
- **The Code of Conduct has a reachable contact.** The
  `TODO-MAINTAINER-CONTACT@example.invalid` placeholder is replaced by the
  repository's issue tracker, the maintainer's GitHub profile, and GitHub's
  private **Report content** flow. Deliberately no email address.
- **`docs/BEFORE-PUBLISHING.md` is accurate again.** The slug, Code of Conduct
  and `.lycheeignore` rows are ticked with the value that was applied; the two
  files its own grep found but its checklist never named (`docs/troubleshooting.md`,
  `docs/getting-started.md`) are listed; and the automatic hardware rows are
  corrected to **H01, H02, H03, H12, H14, H17, H18, H22** — H12 is a 3 s rAF
  sampler and was missing, and H19 was listed as automatic when the diagnostics
  page has never probed it. Three launch-asset rows were added: replace
  `docs/assets/hero.gif` / `hero.png` with real hardware footage, regenerate or
  crop `docs/assets/remote.png` (a live room code is legible in it), and re-run
  `npm run capture` once the Pages URL exists, because `config-ui.png` currently
  shows `http://127.0.0.1:4179/`.
- **The README is the finished one.** Hero, badges, the what-it-is pitch, a
  60-second quickstart that keeps the FPS slider as step 1, a supported-sources
  matrix mirroring `docs/providers.md`, the download-first explanation, the
  screenshots, and an FAQ that answers the four questions this project will
  actually be asked — ads on embeds, why extraction is dead, whether audio works
  (unknown, H08), and which Krakens are supported (Z: yes but not for video;
  2023: yes; Plus: unmeasured, H22).
- **The diagnostics page no longer says network reachability is "available once
  sync ships (M2)".** Sync shipped in M2, and the sentence had outlived its
  truth. The panel is now `Network reachability (H19)` and says what is actually
  the case: it lists the endpoints, probes nothing, points at the Remote page for
  live status on a paired room, and names H19 — whether CAM's webview can reach
  those hosts at all — as the still-unbuilt, still-unmeasured question.
- **The hardware checklist is H01–H23, and now says so.** H23 (`pagehide` on
  teardown) was added during M2 but the page title and the in-app link both still
  read "H01–H22".
- **The design docs gained post-M4 corrections sections.** `design-ossDx.md` now
  records nine divergences between the design text and what shipped —
  most importantly that the **storage namespace is not path-scoped**: the design
  specified `kraken-hub@<normalized path>:`, the plan's canonical conventions
  specified the fixed `kraken-hub:v1:`, and the fixed prefix is what shipped. The
  consequence — two kraken-hub deployments under one `<user>.github.io` share one
  configuration — is now documented in `docs/self-hosting.md`, in
  `docs/troubleshooting.md`, and in the known-gaps list, rather than being
  discovered by whoever hits it first. `design-architecture.md`'s "still
  outstanding after M0" note is resolved.
- **`clock-lite` is gone; `clock` replaces it.** State migration **3 → 4**
  rewrites `activeModuleId` and moves the stored config slot across, mapping
  `format` → `hourFormat` and carrying `showSeconds` over; the dropped free-form
  `color` becomes the `mono` theme, whose `#f2f4f8` is exactly what the
  placeholder painted, so a user who never changed it sees no difference. Every
  other module's slot — including a fork's — is preserved verbatim. It was
  dropped rather than aliased: an alias would have kept a second id alive in
  every picker, URL and synced snapshot forever, to preserve a module that
  existed only because M0 needed _something_ to render. This is also the worked
  example the module guide points at for "renaming a module id is a state
  migration, not a `configVersion` bump".
- **The fit and safe-area math moved to `src/render/`.** `computeFit`,
  `inscribeInCircle`, `toTransformCss`, `safeAreaBox` and the zoom/pan limits
  were the video module's, and the image module needs exactly the same math. A
  module may not import another module's internals (invariant I6) — and would not
  want to: a chunk group claims its matched modules _and their dependencies_, so
  reaching into `src/modules/video/` would have made the LCD download the entire
  video player in order to show a JPEG. The video module's `render/fit.ts` keeps
  the two genuinely provider-aware helpers (`pickSourceRect`, `effectiveFit`) and
  re-exports the rest, so no video import site moved and its tests are unchanged.
  New `render-shared` chunk, ranked between `core` and the module groups.
- **`http:` → `https:` upgrading is now shared** (`src/lib/mediaUrl.ts`). It was
  the generic half of the video router's `normalizeUrl`; the image module applies
  the identical policy — including the loopback exemption — instead of a second
  implementation that would drift. `patterns.ts` keeps the local-clip scheme and
  the provider table and delegates the rest.
- **Module config panels are chunked into `config-ui`.** Every `module-*` group
  matches `.ts$` only, so each `*.tsx` panel had been landing in its own orphan
  chunk — an extra round trip per module, on the page where a round trip is
  least useful.

### Fixed

- **The companion never looked for `yt-dlp` on `PATH`.** Its documentation said
  the resolution order ended there; the code went explicit `--yt-dlp` → cached
  auto-download → refuse, so a user with yt-dlp already installed got a second
  copy downloaded into the cache directory, or — under `CI` /
  `KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1` — a refusal telling them to install the
  thing they had already installed. `ensureYtDlpBinary()` now probes `PATH`
  between the flag and the cache, and "present" is not enough: it runs
  `yt-dlp --version` with a 5 s timeout and requires exit 0, so a stale shim or a
  hung wrapper counts as absent instead of failing later during a real
  extraction. The probe is injectable (`runImpl`), which is how the new unit
  tests cover the branch without a `yt-dlp` anywhere — and how every other
  `ensureYtDlpBinary` test now stubs `PATH` to empty, so a developer who happens
  to have yt-dlp installed sees the same result as CI. The checksum verification
  and both no-download guards are untouched.
- **`docs/hardware-checklist.md`'s hardware-report link was a 404.** It used
  GitHub's fork-relative `../../issues/…` form from a file one directory deep,
  where it needs `../../../`. Now absolute, along with every other issue and
  discussion link, and no longer hidden from the link checker.
- **The image slideshow could never advance on a machine whose watchdog trips.**
  Its first version re-armed the interval from `reinit()`, which the watchdog
  calls on every rAF or monitoring stall — routine on a hidden window — so the
  countdown was reset before it could ever elapse. `reinit()` now re-resolves the
  current source and leaves anything time-based alone. Caught by the e2e
  slideshow test, whose fake clock trips the watchdog on every fast-forward.

### Added (M2.5 and earlier, this cycle)

- **Position sync, end to end.** `AppState.playback` travelled in the sync
  envelope from the day the envelope existed, but nothing ever wrote it, so
  `src/sync/position.ts` was dead code at runtime and two user-visible claims
  were false. Three producers now exist, and each is deliberately on a different
  path:
  - **The remote scrubber re-anchors from telemetry.** Every `videoStats` packet
    is a `posSec + posAtTs` pair in disguise — `stats.currentTime` sampled on the
    display at the packet's own `ts` — so `RemoteView` feeds it to
    `anchorPosition()` and the 250 ms clock moves the bar between the 0.5 Hz
    packets. The description under the seek bar ("re-anchored here from posSec +
    posAtTs, so it keeps moving between packets") is now true rather than
    aspirational. An anchored sample that has gone `stale` is discarded in favour
    of the raw one, which is the case where two clocks disagree badly enough that
    extrapolating would invent a position that never existed. `useSync` grew
    `lastStats` so a `library` or `videoError` packet arriving in between cannot
    re-anchor a position against a timestamp belonging to a different sample.
  - **An explicit seek is published as state.** The `cmd` channel still does the
    seek — imperative, one-shot, never replayed — but a command is never
    retained, so a display booting ten seconds later knew nothing about it. A
    seek on the remote now also writes `playback {posSec, posAtTs}`, which puts
    it in the retained snapshot. The display applies it **once**, keyed on
    `posAtTs`, so the keepalive's five-minute republish and the localStorage echo
    from `persistRemote` cannot yank playback back to a seek made ten minutes
    ago. The display still never publishes state: config and remote publish
    `state`, the display publishes `tele`.
  - **The display checkpoints its own position locally.**
    `src/modules/video/local/positionCheckpoint.ts` — one entry under
    `kraken-hub:v1:video:positionCheckpoint`, keyed by source identity (a clip id
    for a local clip, otherwise the same 8-hex `urlHash` telemetry uses, so a raw
    URL never lands in storage), stamped every 10 s and on `pagehide`, and
    resumed only on a remount of the SAME source. Local-only: no wire format, no
    publish, no change to the sync contract. It stands down for a live source
    (a position in a live edge is meaningless), for a position within a second of
    the start or two seconds of the end, and for a configured A-B loop, whose own
    start is the resume point the user asked for.
- **`anchorPosition()` honours a sampled `rate`.** Optional and absent means 1×;
  it multiplies the extrapolation, not the clamp, so half-speed playback advances
  half as far per wall-clock second while `MAX_EXTRAPOLATION_SEC` still bounds
  the elapsed time.
- **A `pagehide` listener in both app modes**, calling `SyncService.stop()`.
  `MqttTransport.disconnect()` has always used `end(false, …)` with a 1.5 s
  ceiling precisely so the last state change before a reload is flushed rather
  than dropped — and that code was unreachable on a real tab close, because
  `stop()` only ran from React effect cleanup, which a browser tearing the page
  down never runs. `pagehide` is the event that still fires for a bfcache-eligible
  page, which `beforeunload` does not. `AppSync.stop()` now memoises its promise,
  so the listener racing the unmount cleanup is a no-op rather than two competing
  disconnects.
- **An opt-in live yt-dlp test for the companion**
  (`companion/resolver/test-live/`, `npm run test:live`). Every test in
  `companion/resolver/test/` injects the stub downloader, which is right for a
  suite every PR must pass but leaves the shipped `createYtDlpDownloader`
  exercised only at the level of its argv. This runs one real extraction of a
  12-second CC BY-SA clip and asserts the `202 → /job → /stream` flow, a Range
  request served from disk, and the **magic bytes** of the cached file — the
  companion hard-codes `mime: 'video/mp4'` for every fetch, so a WebM in the
  cache would be a lie to a `<video>` element that fails at playback time with no
  diagnostic. It lives behind its own Vitest config, so `npm test`, `npm run
check` and CI never load it, and it **never installs anything**: with no
  `yt-dlp` or `ffmpeg` on `PATH` it skips with a message saying exactly that.
- **Two ordering bugs the new e2e found, both fixed.** (a) The display applied
  any `playback` whose `posAtTs` it had not seen, including one OLDER than a seek
  it had already acted on — and because the `state` channel is coalesced and
  retried while `cmd` is not, a stale snapshot really does land last. The guard
  is now monotonic on the sample's own timestamp, which is stamped by one peer,
  so no clock skew is involved. (b) React delivers both `input` and `change` for
  a controlled range input, and the second one arrives after the component has
  re-rendered with the telemetry-anchored position — so a seek was followed by an
  echo carrying the value the bar had snapped back to. `sendCmd` happened to drop
  it (it throttles per op) and the `playback` write did not, which left the two
  channels disagreeing and dragged the display back to where it started. The bar
  now ignores a change to within half a step of what it is already showing, and
  the `playback` write is throttled with a **trailing** edge — leading-edge alone
  drops the last event of a drag, which is the only one that matters.
- **Tests for all of the above**: `src/sync/appSync.test.ts` (a non-null
  `playback` survives encode → decode → precedence patch → the state validator),
  `positionCheckpoint.test.ts` (the resume decision and the namespaced storage
  round trip), rate cases in `position.test.ts`, three e2e in `sync-remote.spec.ts`
  (the scrubber changes value three times inside one telemetry period — which
  packets alone cannot produce; a remote seek moves a HELD display, so playback
  cannot account for it; a cold display resumes from a retained snapshot after
  both peers close and the local checkpoint is deleted) and three in
  `video.spec.ts` (a reload resumes, a different source does not, and an A-B loop
  writes no checkpoint at all). The failover e2e now asserts
  `elapsed < 5000` instead of merely passing inside a 15 s locator timeout.
- Repository scaffold: Vite + TypeScript + React, npm, Node 22.
- Strict TypeScript configuration (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and friends).
- ESLint 9 flat config encoding the platform invariants as lint rules: no
  `window.nzxt` reassignment, no navigation, namespaced storage only, no
  hardcoded origins, import layering zones, no default exports outside manifests.
- Prettier, opt-in `lint-staged` pre-commit hook via `core.hooksPath`.
- `npm run check` — typecheck, lint, format, unit tests, build, bundle budgets.
- Bundle budget gate (`budgets.json` + `scripts/check-bundle-size.mjs`).
- GitHub Actions: `ci.yml` (checks on PR and `main`) and `deploy.yml`
  (GitHub Pages via `actions/deploy-pages`).
- Community files: MIT license, Code of Conduct, security policy, issue forms
  (including the hardware report), PR template, Dependabot configuration.
- Source-of-truth design and research documents under `docs/design/`.
- **State model** (`src/state/`): one versioned `AppState` document written
  atomically to `kraken-hub:v1:state`, hand-rolled coerce/clamp validators with
  no runtime dependency, forward-only migrations that preserve — never destroy —
  state written by a newer build, a `storage`-event watcher with an
  unconditional 1 s poll fallback and per-delivery-path counters, the URL
  parameter table, and per-leaf precedence resolution
  (`defaults < persisted < remote < url`).
- **Platform layer** (`src/platform/`): the single safe `window.nzxt` accessor
  (property assignment only, 200 ms × 10 retry ladder, live `targetFps` re-read
  every 2 s, DEV reassignment tripwire), geometry and circular safe-area math,
  the rAF frame governor gated to `targetFps`, the 1 Hz monitoring fan-out,
  the liveness watchdog, capability probes, the namespaced storage wrapper, and
  the `kraken-hub.v1` IndexedDB opener.
- **Hardware simulator** (`?sim=elite|plus|z|kraken2023`) with a correlated
  monitoring generator (`?monitor=idle|load|spike|missing`), a frame-rate
  override (`?fps=`) and late-injection reproduction (`?inject=late`).
- **Boot branching**: `src/main.tsx` dynamically imports exactly one mount
  module, so the hidden Kraken Browser never downloads the configuration UI.
- **Display shell** (`src/app/display/`): error boundary, stage with the round
  mask and `contain: strict`, module host with the full renderer lifecycle, the
  low-FPS advisory card and badge, the module error card, and a debug overlay.
- **Config shell** (`src/app/config/`): a dependency-free hash router (`#/`,
  `#/module/<id>`, `#/sources`, `#/remote`, `#/preview`, `#/diag`, `#/about`),
  setup view with the CAM one-click install links derived from `location`, an
  iframe-based device preview with a bezel, and a small dark design system in
  `src/ui/`.
- **Module system** (`src/modules/`): the `KrakenModule` contract, the registry,
  a `_template/` starter, a conformance test suite that runs over every
  registered module, and a working `clock-lite` placeholder module.
- **Diagnostics** (`src/diag/`): probes, the `DiagReport` (schema version 1),
  the on-LCD overlay at `?kraken=1&diag=1` with `&pattern=flat|rings` test
  patterns, and `#/diag`, which reads the report the display publishes to
  `kraken-hub:v1:diag:display` and offers Copy JSON.
- Playwright end-to-end coverage for both boot modes, hash routing, the
  no-navigation invariant, two-page storage sync (event and poll-only paths),
  and the diagnostics hand-off.
- **Video module, pure-logic core** (`src/modules/video/`) — the whole of
  `docs/design/design-videoEngine.md` §0–4 as pure, DOM-free, unit-tested
  functions, landed ahead of any adapter per the doc's own sequencing:
  - `types.ts` — `VideoModuleConfig`, `LoopConfig` + `LOOP_DEFAULTS`,
    `RenderConfig`, `SourceRect`, `ProviderCapabilities`, the `YT_LADDER` /
    `qualityFloorPx` constants, the §8.3 performance profile, and a
    never-throwing `validateVideoConfig()` that clamps every field.
    `downloadMode` defaults to `auto` and `resolver.policy` to `youtube-only`,
    so pasting a URL downloads the video into the local clip library whenever
    the bytes are reachable.
  - `routing/patterns.ts` + `routing/detect.ts` — the §1.3 routing table:
    hard rejects (the `.mkv` container family, reddit comment pages), the
    canonical `kraken-hub-clip:<id>` scheme, YouTube including `/shorts/`,
    `/live/` and `youtu.be` with `t=`/`start=` extraction (bare seconds and
    `1h2m3s`), Vimeo with the unlisted hash, Twitch vod/clip/channel,
    Streamable, `v.redd.it`, the extension routes, the warn-only Discord /
    Imgur / playlist annotations, and the unmatched-https fallback with
    `needsFallbackChain`. `applyResolverPolicy()` implements §1.4 as a policy
    layer over a finished match rather than a URL pattern.
  - `routing/validate.ts` — the §7.1 table with its exact messages (the
    https auto-upgrade note, the `ffmpeg -i in.mkv -c copy out.mp4` remux
    command, the Discord 24-hour expiry, …) and the severity model: warnings
    never block, errors block a config-side save while the display still
    renders a card.
  - `youtube/geometry.ts` — the §2.2 crop engine, steps 1–5, reproducing every
    §2.3 worked example: 640/square/N=1920 →
    `translate(-248.889px, -248.889px) scale(0.5925926)`, the
    `tx = ty = −0.388889 × displayW` invariant at 640/320/240, zoom 1.5,
    N=2560, `tight` mode, the portrait Shorts variant, the 1.6875 / 2.25
    pixel-parity zoom limits, and `sourceInset` for baked-in bars.
  - `render/fit.ts` + `render/safeArea.ts` — the §4.1 cover / contain /
    contain-circle / fill math (one path for iframes and `<video>` alike) and
    the circular overlay box, which reuses `platform/geometry.ts`'s inset
    helper rather than restating the formula.
  - `loop/LoopEngine.ts` — §3.2 validation including the duration-unknown
    `pending` state, the never-loop-a-live-source rule, the end guard and the
    implicit `[0.05, duration − 1]` loop, plus the pure crossing-prediction
    helpers `HtmlVideoLoop` and `PolledLoop` will be built on (rAF prediction,
    lookahead, sub-poll scheduling, buffer priming, and the adaptive
    `canSeekSilently` promoter).
  - `youtube/qualityPolicy.ts` — the §2.7 label→height map and the ladder
    watchdog decision: step up once on a size-limited hypothesis, publish
    `quality-capped` rather than escalate again, and never step up when the
    buffer is the constraint.
  - 226 unit tests across these files, written against the design document's
    worked numbers rather than against the implementation.

- **Video module, the playable end-to-end path** — the download-first pipeline
  from the plan, which supersedes `design-videoEngine.md` §5.3's upload-first
  framing:
  - `adapters/VideoAdapter.ts` — the §1.1 adapter contract, `AdapterEvent`,
    `MountContext`, the closed `VideoError` enum with its retryable/deterministic
    split, and the two contract rules that keep the render layer
    provider-agnostic: an adapter never touches a transform, and it emits
    `sourcerect` when natural dimensions arrive rather than per frame.
  - `adapters/registry.ts` — `ProviderId` → lazy `import()` factory, returning
    `null` (and a specific card) for providers this build does not have yet.
  - `adapters/HtmlVideoAdapterBase.ts` — the shared `<video>` plumbing:
    muted + playsinline + autoplay, one `NotAllowedError` retry-muted and no
    more, `sourcerect` on `loadedmetadata`, buffered/duration/rate readers, and
    the teardown order that stops a revoked blob URL from looking like a corrupt
    file (clear `src` → `load()` → release).
  - `adapters/directFile.adapter.ts` and `adapters/localFile.adapter.ts`, the
    streaming and clip-library paths.
  - `loop/HtmlVideoLoop.ts` — rAF-predictive crossing with a `timeupdate` safety
    net, present because the Kraken Browser is a hidden window whose rAF Chromium
    throttles; both paths share one predicate. `loop/crossfade.ts` — the optional
    dual-`<video>` seam fade, default off and hard-disabled in performance mode.
  - `render/RenderController.ts` — the §4.1 DOM stack, imperative transform
    writes (never through a React re-render of the media element), §4.2 rotation
    with the non-square guard, forced-cover for `hasOwnChrome` providers, and
    §4.4 compositor hygiene (exactly one `will-change` layer, no filters).
  - `local/clipStore.ts` — the `clips`/`clipBlobs`/`kv` stores on
    `kraken-hub.v1`, written in a single transaction so a metadata row can never
    exist without its bytes, plus quota checks, `navigator.storage.persist()` and
    the localStorage-published clip index.
  - **`local/downloadManager.ts` (new; not in the design doc)** — the featured
    ingestion path. Streams a URL with `fetch` + `ReadableStream` progress into
    IndexedDB, abortable, two retries with backoff, refuses on the §5.3 quota
    check, mirrors live progress to `kraken-hub:v1:video:downloads` so the config
    page watches a download running in the _other_ CAM window, and treats a CORS
    refusal as a silent fall-back to streaming (`download-cors-blocked`) rather
    than an error. Carries the marked seam the M2.5 resolver client plugs into.
  - `local/ingest.ts` (manual upload fallback: `.mkv` reject, HEVC/AV1
    feature-detect warnings, metadata probe, 320×320 WebP thumbnail) and
    `local/blobUrlRegistry.ts` (§5.4 ref-counting with a `pagehide` sweep).
  - `display.ts` — the renderer: resolve → validate → play a local clip → replay
    an already-downloaded copy → download → stream, with the low-entropy progress
    card, error card and 15 s demo hint on the panel.
  - `VideoConfigPanel.tsx` (URL field with live validation, download mode, fit /
    zoom / pan / rotate, A-B loop) and a rebuilt **Sources** view (paste-to-
    download, live download list, clip library with thumbnails, quota bar,
    persistence badge, pin/delete, and the upload drop zone marked as the
    fallback it is).
  - `telemetry.ts` — the §7.5 localStorage ring buffer and last-error object the
    Configuration Browser reads for free over the shared origin.
- **Video module, the YouTube geometry engine** — design-videoEngine.md §2 in
  full, plus §3.4 and the §8.3 levers that apply to it. YouTube extraction is
  impossible from a static origin (see the research notes); this is the whole
  answer to "play YouTube on the LCD without the chrome and without the 360p".
  - `youtube/ytApiLoader.ts` — single-flight `iframe_api` loader that CHAINS any
    pre-existing `onYouTubeIframeAPIReady` rather than replacing it, and fails
    after 10 s with the new retryable `yt-api-unavailable` error so a display
    nobody can click renders a card instead of a black screen.
  - `adapters/youtubeEmbed.adapter.ts` — an oversized, letterboxing iframe
    (1920×1920 by default) whose width/height **attributes** are what the player
    measures, so YouTube serves ~1080p and paints its chrome onto black bars the
    crop discards. The §2.5 embed URL exactly, on `youtube-nocookie.com`, with
    `origin` derived from `location`; `YT_INCLUDE_INERT_VQ = false` keeps the
    measured "`vq` is never parsed into PLAYER_VARS" finding discoverable in
    code. Attaches `YT.Player` to the pre-existing iframe so the API never takes
    ownership of the size attributes, and reports a `SourceRect` whose `safe` is
    the centre crop square at zoom 1 (`RenderController` applies zoom and pan
    exactly once) and whose `full` is the video band including any chrome.
  - `youtube/maskController.ts` — the §2.6 transition table: poster fallback
    `maxresdefault` → `hqdefault` → flat colour (the 120×90 grey placeholder is
    detected and rejected), instant raise on BUFFERING/seek/UNSTARTED/CUED/
    PAUSED/ENDED, a 180 ms fade only once PLAYING _and_ the clock is past
    `A + 0.05` _and_ no seek is in flight, a 100 ms flash cap for seeks observed
    to be silent, a 2.5 s failsafe that never leaves the panel black, and a 15 s
    escalation to a stalled error card plus telemetry.
  - **`pauseVideo()` is never called.** `hold()` is a micro-loop — slowest
    available rate plus a temporary `[t, t+0.30]` span — because pausing raises a
    suggested-video grid _inside_ the video rect where no crop can reach it.
    `youtube.pauseStrategy: 'maskedPause'` is the documented lower-power
    alternative and pauses only behind a fully opaque mask. An implicit end-guard
    loop `[0.05, duration − 1.0]` is always installed, A-B loop or not, so
    playback never reaches `duration` and never shows the end screen.
  - `loop/PolledLoop.ts` — §3.4 for providers with no `timeupdate` and no
    `seeked`: rAF poll, `LOOKAHEAD_S = max(0.08, 2 × pollInterval)`, a
    `setTimeout` at the predicted instant inside the last 0.35 s (the display may
    be clocked at 1 FPS), buffer priming, and adaptive `canSeekSilently`
    promotion after three clean crossings — with the observed value published so
    the UI can say whether the seam is seamless. `LoopEngine` gains the shared
    `AbLoop` interface both loop implementations satisfy, which is what keeps
    `display.ts` free of per-provider branches.
  - `youtube/qualityWatch.ts` — the §2.7 watchdog around the existing
    `qualityPolicy` decision function: armed 6 s after the first PLAYING,
    discriminates size-limited from network-limited via
    `getVideoLoadedFraction()` and a 30 s buffering counter, steps the ladder
    1920 → 2560 **once** with a remount that preserves the playhead, remembers
    the step in `kraken-hub:v1:video:ytLadder` for the session only, and steps
    _down_ to 1280 when the network is the limit and `perf` is `auto`.
  - `sourceAspect` presets (§2.4) — `auto` resolves to 9:16 for a `/shorts/`
    link and 16:9 otherwise, since there is no cross-origin way to read the true
    aspect. Config panel gains an aspect picker, a geometry-mode picker, a
    portrait-width picker, a hold-behaviour picker, a warning when zoom passes
    the pixel-parity limit, and the §2.8 ad-honesty note next to the URL field:
    ads play inside the video rect, so cropping cannot remove them.
  - §8.3 wiring for the YouTube levers: a 1280 element floor, `tight` geometry,
    a 1.5 zoom clamp now enforced in `RenderController`, and a flat mask instead
    of a poster.
- `platform/storage.ts` gains namespaced **session** helpers, so the ladder step
  is stored under `kraken-hub:v1:` like everything else rather than reaching for
  `sessionStorage` directly — it is session-scoped on purpose, being a reaction
  to one machine's current network and GPU conditions.
- `tests/support/fakeYouTube.ts` — a deterministic stand-in for the IFrame Player
  API that records every call it receives, letting the e2e suite assert the
  module's most important negative: `pauseVideo` is never called.
- Eleven more Playwright cases: the §2.3 worked-example transforms asserted
  exactly at all four device presets, the §2.5 parameter set, performance mode's
  tight 1280 geometry, mask behaviour on buffering and seek, A-B loop crossings
  with no `pauseVideo`, and a ladder step on a forced low-quality report.
- **`npm run test:e2e:live`** (`playwright.live.config.ts`, `tests/e2e-live/`) —
  the opt-in suite for the two claims that are about _YouTube_ rather than about
  us: that a real embed loads from this origin, and that a 1920-wide element
  really does elicit ≥720p. Excluded from CI on purpose, so a rate limit or a
  player rollout never turns the build red.
- **Demo mode.** `scripts/make-demo.mjs` generates `public/demo/demo.mp4`
  procedurally with ffmpeg — 640×640, 6.0 s, 30 fps, seamless loop, flat shapes,
  CRF 21, `-an`, `+faststart`, 31 kB. A cold boot with no state plays it offline;
  `?demo=1` forces it over a configured source.
- Nine Playwright cases covering direct-URL playback, paste-URL auto-download →
  clip → blob playback → survives a reload with the media URL blocked, the manual
  upload path, an observed A-B loop crossing, offline demo cold boot, `?demo=1`,
  and render controls rewriting the transform without recreating the `<video>`.

- **Every remaining video provider** (design-videoEngine.md §1.2, §1.5), each
  behind a lazy `import()` and its own bundle chunk:
  - `hls` — hls.js **light** build (no subtitles, no EME, no alternate audio:
    64 kB gzip less, and all three are meaningless on a muted panel). Native HLS
    is checked first, so Safari never downloads the library at all. Live
    playlists disable seek, duration and looping.
  - `dash` — dash.js 5, chosen over shaka for `v.redd.it` manifest tolerance and
    size. §1.5's audio rule is implemented literally: two consecutive audio-track
    failures drop the audio and keep the video, because a 403 on a track nobody
    can hear must never take the picture down.
  - `reddit` — probes the progressive `DASH_<h>.mp4` ladder (1080/720/480/360,
    4 s each) with throwaway metadata elements and plays the first that answers
    as a plain direct file, skipping the dash.js bundle and the MSE pipeline
    entirely. dash.js is loaded only when audio is wanted or the ladder fails.
  - `twitch` — Embed JS API, `parent` computed from `location.hostname` at
    runtime so a fork works unchanged, `setQuality` driven to match the crop,
    live channels with loop and seek disabled.
  - `vimeo` — player.js, mask raised **before** pause (Vimeo paints a play button
    and title on pause), `setLoop(true)` never called (it suppresses `ended`,
    the loop engine's failure signal), and `canSetQuality: false` stated honestly
    because Vimeo gates it on the uploader's paid tier.
  - `streamable` — oEmbed for the true source aspect, then an iframe. Almost
    every capability is `false`, which is the provider rather than a gap.
  - `resolver` — mounts the ordinary direct/HLS/DASH machinery on whatever
    `streamUrl` the companion returns; there is no resolver-specific playback
    code at all.
- **Resolver client and frozen v1 wire contract** (§6). `resolverTypes.ts` is the
  normative TypeScript form of `docs/resolver-protocol.md`, including the closed
  error enum and loopback-only enforcement; `resolverClient.ts` implements the
  1.2 s health probe memoized 60 s in memory _and_ `sessionStorage`, the 202 →
  `/job` polling flow with a 60 s budget, and §6.4's `maxHeight` formula (a 640
  panel at DPR 1 asks for 1080, never 2160).
- **Resolver policy wiring**, default **`youtube-only`** (the plan's override of
  the design doc's `off`): the display health-checks the companion silently,
  routes YouTube through it when present, and falls back to the geometry engine
  on _every_ failure path with a `resolver-fallback` telemetry line and nothing
  on screen.
- **The resolver download seam.** When the companion returns a `progressive` or
  `file` kind and `downloadMode` is `auto`, the display fetches the loopback
  stream into the IndexedDB clip library and plays the clip — so the clip keeps
  playing on the next boot with the companion stopped. `downloadToClip` gained
  `sourceUrl`, so a clip fetched from an expiring `/stream/<opaque>` token is
  remembered by the YouTube URL the user actually pasted.
- **The unknown-URL fallback chain** (§7.3) in `routing/sniff.ts`: `<video>`
  attempt first (it needs no CORS, so it succeeds where `fetch` cannot even
  read), then a 2 KB range-probe sniff, then a blind manifest guess, then an
  optional user-configured proxy, then the error card — every step
  `AbortSignal`-guarded and the whole chain capped at 25 s.
- **`proxyBase` config**, shipped empty, with `allorigins.win` as the one preset
  and the HLS caveat documented in the panel and in `docs/providers.md`: a plain
  passthrough proxy cannot fix HLS, because the URLs inside a manifest resolve
  back to the origin.
- **The full §7.4 error card** (`ui/ErrorCard.ts`): category glyph,
  middle-ellipsized URL, fixed "Fix in CAM → Kraken → Configure" footer with a
  room-code slot, a 1 Hz pulse dot as the only animation, `2/4/8/30 s` auto-retry
  for transient classes **only**, and — after three failed retries — falling back
  to the previous working source with a corner badge instead of a card.
- **The §8.1 FPS advisory** (`ui/FpsAdvisory.ts`) as a module-owned state
  machine: full card for 20 s, then a persistent badge, self-clearing above 5 FPS
  and re-arming as a card if the rate drops again. Dismissible only from the
  config UI (`kraken-hub:v1:video:fpsAdvisoryDismissed`), because the LCD is
  non-interactive. New `ModuleCapabilities.ownsFpsAdvisory` stands the display
  shell's generic banner down.
- **Telemetry's third sink** (§7.5). `telemetry/videoTelemetry.ts` adds the
  `tele` channel packet shape (frozen now, transport in M2) with a local emitter
  and a `kraken-hub:v1:video:tele` mirror, ambient context (display, achievedFps,
  quality, geometry, resolver health, retry count), SHA-256 `urlHash`, continuous
  0.5 Hz stats (0.2 Hz in performance mode) carrying `loopCrossings` and
  `maskVisiblePct`, and `subscribeTelemetry()` with the mandated 1 s poll
  fallback alongside the `storage` event.
- **§8.3's `auto` promotion rule with hysteresis** (`createPerfPromoter`):
  `targetFps <= 10` promotes immediately because it is a _setting_, while
  `achievedFps < targetFps * 0.6` must hold for a continuous 10 s in either
  direction because it is a noisy _measurement_.
- **Docs, as a first-class deliverable:** `docs/providers.md` (the honest
  capability matrix, including the Vimeo tier gate, the Twitch `parent`
  derivation and the fact that the YouTube crop cannot remove ads),
  `docs/why-not-extraction.md` (the three measured walls with curl repros and the
  collapsed Invidious/Piped tables), `docs/resolver-protocol.md` (the frozen v1
  contract, companion behaviour contract and security posture) and
  `docs/local-clips.md` (download-first flow, manual fallback, the ffmpeg
  square-crop one-liner, quota and persistence). README gained a sources matrix
  and a download-first section, with the FPS callout still above the fold.
- **Tests:** 98 new unit cases — the sniff/fallback-chain ordering against a
  mocked fetch, the resolver client including 202 polling, loopback rejection and
  the `maxHeight` formula, error-card retry classification, the FPS advisory
  machine, the perf promoter's hysteresis, the Reddit ladder, HLS level selection
  and dash.js audio-error tolerance, plus Twitch/Vimeo/Streamable contract tests
  against faked SDKs (`tests/support/fakeEmbeds.ts`; deliberately no network
  e2e). Five new Playwright cases: the fallback chain rendering the error card
  with the right copy and per-step reasons, a hard reject with no retry counter,
  the FPS advisory, and **the full resolver flow against a real in-test HTTP
  server on `127.0.0.1:8976` implementing the v1 contract** — YouTube URL →
  companion → clip library → kill the server, reload, still plays from IndexedDB.

- **Sync layer** (`src/sync/`) — milestone M2. One `SyncTransport` interface
  moving OPAQUE BYTES, with encryption, envelope encoding, dedup, throttling and
  failover all living in `SyncService`, so a new transport is ~150 lines and
  inherits the whole security model. `state` is always a FULL snapshot, never a
  delta, because a cold display must be correct after exactly one message.
  - `roomCode.ts` — 8-character Crockford base32 (no `I`, `L`, `O`, `U`), with
    normalisation that folds the lookalikes rather than rejecting them.
  - `crypto.ts` — `topicId = base32(SHA-256(code)[0..10])` (80 bits), HKDF-SHA256
    per channel to an AES-GCM-256 key, a fresh 12-byte IV per message, and
    `AAD = "<topicId>|<channel>"` so a ciphertext cannot be replayed onto another
    channel. Decrypt failures return `null` and are counted, never explained.
  - `envelope.ts` — validation that never trusts its input, and the 8 KB cap
    (invariant I6) with a diagnostic that says what to do about it.
  - `position.ts` — position on the wire is always `posSec + posAtTs`, re-anchored
    by the receiver with a 30-second extrapolation clamp.
  - `backoff.ts` — `1s…60s` with ±20 % jitter, so a broker restart does not
    reconnect every display in the world at the same instant.
  - `transports/` — `LocalStorageTransport` (zero network, always running, carries
    `cmd`/`tele`; the canonical state key already IS the retained state store),
    `MqttTransport` (mqtt.js behind TWO dynamic imports, CONNACK **and** SUBACK
    before `connect()` resolves, publishes awaited on the broker's callback,
    `end(false)` with a flush ceiling, last will on `tele` ONLY — a will on
    `state` would erase the retained snapshot a reloading display depends on),
    `NtfyTransport` (POST + SSE, retention emulated by a 4-minute republish and a
    `?poll=1&since=10m` recovery that takes the LAST state message and never
    replays a command), and `FakeTransport`, an in-repo broker simulator backed by
    the storage wrapper so it works as an in-process fixture in Vitest and as a
    cross-page channel in Playwright.
  - `SyncService.ts` — transport ladder with auto-failover on a connect error or a
    5-second timeout, `(src, seq)` dedup, echo suppression before anything else,
    5 Hz publish throttling with coalescing, a 5-minute retained keepalive, and an
    oversized-snapshot fallback that drops inactive modules rather than the message.
  - `appSync.ts` — inbound state is applied as the **`remote` precedence layer**,
    never written straight over the store, so a URL parameter still outranks a
    phone. `sync`, `platform` and `diagnostics` are deliberately absent from the
    wire format: a remote peer cannot repoint a display's broker, disable its
    watchdog or opt it into audio.
- **Remote control UI at `#/remote`** — pairing (generate / rotate / join, with a
  QR code), source URL with the same validation the config page uses, play / hold /
  seek / re-initialise, an A–B loop pair throttled to 5 Hz, fit / zoom / rotation,
  a module switcher, a clip picker with the "local clips live in CAM" explanation
  and a cam-redirect deep link, live transport and telemetry status including
  `achievedFps` and the last error, room settings (transport preference, endpoint
  overrides, telemetry and persistence toggles) and a plain-language "what leaves
  your machine" note. Volume and mute are present and **disabled with a tooltip**:
  webview audio routing is unverified on hardware (H08), and a control that
  silently does nothing is worse than one that says why it is off.
- **A hand-rolled QR encoder** (`src/app/config/qr.ts`, byte mode, ECC level L,
  versions 1–10). Not a dependency and emphatically not a QR _service_: the URL it
  encodes contains the room code, and posting that to `api.qrserver.com` would mail
  the only secret in the design to a third party on every render.
- **`SetupView` pairing card** — room code, QR and copyable remote link as step 4.
- **`DisplayRenderer.command(op, arg)`** — the `cmd` channel's landing point.
  Separate from `update()` because commands are not idempotent and are not state;
  unknown ops are ignored so a newer remote can drive an older display. The video
  module implements play/hold/toggle/seek/rate, using `hold()` rather than a real
  pause because a real pause raises YouTube's suggested-video grid.
- **The M1 telemetry seam is connected.** `videoTelemetry` keeps its local emitter
  and its localStorage mirror and gains the encrypted `tele` sink. The display also
  publishes its clip index (capped at 40, no thumbnails) and download progress on
  change and every five minutes — on `tele` rather than `state`, because they are
  facts about that machine, not desired configuration.
- **`<html data-kh-sync>`** — a machine-readable readout of what sync has actually
  applied (transport, last revision, whether it arrived retained, active module,
  loop span). You cannot read text off a 640 px round LCD and you cannot copy
  anything off it, which is the same reason `#/diag` publishes through localStorage.
- **Sync tests.** Unit: room-code alphabet and normalisation, crypto round-trip,
  tamper rejection, per-channel key separation and a **pinned known-vector
  `topicId`** (if that value ever changes, every paired display in the world
  silently stops hearing its remote), envelope caps and validation, backoff,
  position anchoring, `FakeTransport` retained semantics, ntfy recovery taking the
  LAST state message, and `SyncService` failover / dedup / throttle / keepalive /
  echo-suppression / stale-command handling against injected transports.
  Playwright (`tests/e2e/sync-remote.spec.ts`, `?transport=fake`): a remote page
  driving a display page, **the persisted state document deleted outright and the
  display cold-restored from the retained snapshot alone** (with an assertion that
  the retained frame does not contain the module id in plaintext), a loop-slider
  change reaching the display in under a second, and a killed transport surfacing
  as a visible failover.
- **Opt-in live smoke test** (`npm run test:live`, `tests/live/sync-live.test.ts`)
  — one real EMQX retained round-trip and one real ntfy publish/replay against a
  freshly generated random room, cleaning up its retained message afterwards with a
  zero-length retained publish. Plus `.github/workflows/live-smoke.yml`: manual
  dispatch and a weekly schedule, deliberately not a required check.
- **`docs/remote-control.md`** — pairing walkthrough, what the remote can and
  cannot do and why, the transport table and the failover ladder, the full privacy
  and threat model including the honest 40-bit limitation of a room code, what
  telemetry contains, and how to point either transport at your own server.
- **The resolver companion (`companion/resolver/`), as an npm workspace** — the
  reference implementation of the frozen v1 contract, published as
  `kraken-hub-resolver` and run with `npx kraken-hub-resolver`. Node ≥ 20,
  TypeScript compiled with `tsc`, and **zero runtime dependencies**: `node:http`,
  `node:crypto`, `node:fs` and `node:child_process` cover the entire program,
  which matters more here than anywhere else in the repo — this is the piece that
  runs outside the browser sandbox on the user's own machine.
  - `server.ts` — `/health`, `/resolve`, `/job/<id>`, `/stream/<opaque>.mp4`,
    `/thumb/<opaque>.jpg`, `OPTIONS` → 204, all of it bound to **`127.0.0.1`
    only**, with the mandated CORS header set (including
    `Access-Control-Expose-Headers` and `Accept-Ranges`) on _every_ response,
    errors included, and Range → `206 Content-Range` / `416` on `/stream`.
  - `resolve.ts` — the URL policy (https only; `file:`/`data:`/`blob:`/
    `javascript:`/`ftp:` and loopback, RFC1918, CGNAT, link-local and `.local`
    targets refused with `403 forbidden`; obviously-non-video extensions refused
    with `400 unsupported-url`), a 10-per-minute sliding-window rate limit, and a
    job queue two extractors wide that answers `202 { jobId, retryAfterMs }`
    immediately and never blocks a request for minutes. Every failure lands on the
    closed error enum.
  - `cache.ts` — opaque ids are 16 random bytes minted per resolve, `/stream`
    serves _only_ ids this process minted (which is what stops the companion from
    being a general proxy), TTL expiry, and LRU eviction by **atime** to
    `--max-cache-gb`, so the clip that is actually looping outlives yesterday's
    experiment.
  - `ytdlp.ts` — progressive-first format selection with an ffmpeg mux fallback
    (and a progressive fallback when ffmpeg is absent), the URL passed as its own
    argv entry after `--` with `shell: false`, and first-run binary auto-download
    from the official GitHub release **verified against that release's
    `SHA2-256SUMS`** — refused outright when `CI` or
    `KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1` is set, so no test can ever reach for it.
  - `cli.ts` — `--port` (default 8976), `--cache-dir` (OS cache directory),
    `--token`, `--max-cache-gb` (default 4), `--max-height`, `--yt-dlp`,
    `--ffmpeg`, `--log-level`.
- **Contract tests that run the real server** (`companion/resolver/test/`, 108
  assertions) on an ephemeral port with the extractor injected as a stub serving
  the app's own `public/demo/demo.mp4`. They assert responses against the **web
  app's own `parseEnvelope` / `parseHealth`, imported across the workspace**, so
  the two halves of the wire cannot drift without a red test; `lockstep.test.ts`
  pins the api revision, the closed enum, the kind list and the header spelling
  against `src/modules/video/resolver/resolverTypes.ts` directly. No network
  anywhere in the suite.
- **`tests/e2e/companion.spec.ts`** — the milestone's acceptance, against the
  _compiled_ companion spawned as its own OS process on a kernel-chosen port:
  paste a YouTube URL → `202` → `/job` → download into the IndexedDB clip library
  with byte-level progress → play → **`SIGKILL` the companion** → reload → still
  playing from the local clip. And the other half: kill it _mid-download_ and the
  display falls back to the geometry engine with `resolver-fallback` in telemetry
  and no error card on the panel.
- **`companion/resolver/README.md`** — install, every flag, the plain statement of
  what installing it means (any page in your browser can ask it to download a
  video) with the mitigations that follow from that, and troubleshooting.
- **Root `check:companion` / `build:companion` scripts**, `check:companion` wired
  into `npm run check` and into CI as its own step.

### Changed

- **`docs/resolver-protocol.md` §6 is no longer a plan.** The reference
  implementation ships in `companion/resolver`; the status line, the flag list and
  the acceptance paragraph now describe what exists and name the tests that prove
  it.
- **A companion that dies mid-download degrades silently instead of erroring.**
  `tryResolver` used to hand the resolver adapter a `streamUrl` even when the
  download into IndexedDB had just failed — which, when the failure was the
  companion going away, mounted a `<video src>` on a dead socket and put an error
  card on the LCD. §6.4 forbids exactly that: a resolver miss is never a visible
  failure. It now re-checks health once, and when the companion is genuinely gone
  returns a distinct `RESOLVER_GONE` answer meaning "attempted and downgraded" —
  play the original URL exactly as an installation with no companion would (the
  geometry engine, for YouTube), and skip the download step, since a YouTube page
  URL is not something `fetch` can turn into a clip.
- **Root ESLint ignores `companion/**`**, which has its own type-aware flat config
  and its own invariants — no `exec*`, no `shell: true`, no `'0.0.0.0'` literal in
  `src/` — enforced by `npm run check:companion`. Linting it from the root would
  have required Node-only CLI code in the web app's tsconfig projects.
- **Fixed a real race in `SyncService.test.ts`** (found by running `npm run check`
  on repeat, not by looking at it). `start()` derives the room keys and seals a
  last-will frame first, and both are WebCrypto calls that resolve as event-loop
  _tasks_; the failover test advanced the fake clock past `CONNECT_TIMEOUT_MS`
  after a single tick, so roughly two runs in five armed the connect timeout only
  _after_ the clock had already moved past it. The timer then never fired, the
  deliberately-hung transport hung the test, and it failed on a timeout rather
  than an assertion. It now waits for `primary.connects === 1` — the observable
  effect — before advancing, and `flush()` yields a few more times so the sealed
  frame exists before it is asserted on. 18 consecutive green runs, from ~60%.

- **State schema 2 → 3.** `SyncSettings` gained `mqttUrl` / `ntfyBase` endpoint
  overrides and `transport` gained the test-only `fake` value. Both are additive
  and the validator fills them from defaults, but the bump is real: a schema-2
  build would reject `transport: 'fake'` and must stash a v3 document rather than
  quietly rewriting the user's transport preference. The room code stays stored in
  plaintext, deliberately — it IS the key material, so a display that reboots has
  to read it back to derive the AES key; a hash could not decrypt anything and a
  "wrapped" copy would only move the wrapping key into the same localStorage. A
  code arriving as `?room=` on the DISPLAY page is still never persisted.
- **`createStore` gained `commitBase` and `overlay`, and both fix real bugs.**
  A commit used to rebuild the document from storage and a `storage`-event update
  used to replace the snapshot with the raw persisted document — so on any page
  opened with URL parameters, the URL layer silently vanished the first time
  anything was saved, or the first time the OTHER CAM browser wrote. On the remote
  page that showed up as the sync connection tearing itself down mid-session,
  because `?room=` disappeared from the snapshot the effect depends on. The config
  and remote surfaces now commit against the resolved snapshot, and both surfaces
  re-apply the URL layer to anything arriving from storage. The overlay is applied
  in memory only, which is what keeps a shared `?room=` link from permanently
  repointing somebody's LCD.
- **`SyncService` subscribes to a transport BEFORE connecting it.** A retained
  message can be delivered as part of the connect handshake — that is what
  "retained" means — and wiring the handlers up afterwards loses the single most
  important message the layer carries. The failure mode was a cold display sitting
  on its defaults forever while the status line cheerfully said "online".
  Measured, not feared: that is what the first version did.
- **New chunk groups `sync-core` and `sync-mqtt`.** `sync-core` (7.7 kB gzip) is
  lazily imported by both mount modules and is fetched only when a room is
  configured, so it is not on the display critical path — the `displayGraph` (I8)
  check proves that on every build. `sync-mqtt` matches `node_modules/mqtt` and
  nothing else, for the same reason the media-library groups do.
- **`budgets.json` gained a measured `syncMqtt` override.** mqtt.js 5.x ships a
  prebundled browser ESM file that gzips to 109 kB on its own and is not
  tree-shakeable; the emitted chunk is 101 kB gzip and essentially all of it is the
  library. The 70 kB base still governs any MQTT code we write, and the chunk sits
  behind two dynamic imports. Same rationale as the hls/dash overrides.
- **`?transport=` accepts `fake`** (the in-repo broker simulator, never offered in
  the UI) and `?room=` now requires a well-formed 8-character Crockford code
  instead of any 4–32 character string.
- **`onStorageEvent` no-ops where there is no `window`.** The transports run in the
  node Vitest project as well as in a browser, and with no other document on the
  origin there is nothing a cross-document event could tell us anyway.
- **`vitest.config.ts` passes `KRAKEN_HUB_LIVE` through** instead of pinning it to
  `'0'` — pinned, the flag `npm run test:live` sets could never take effect. Unset
  still means off, so PR CI still never contacts a public broker. A third `live`
  project holds `tests/live/**`.
- `ConfigRuntime` carries the resolved `role`, and the `persisted` and `url`
  precedence layers, so the sync layer can re-resolve on every remote message.

- **Per-provider bundle chunks.** `hls.js` and `dashjs` get their own
  `provider-*` chunks, and the two chunk groups match `node_modules` paths
  **only**: a group claims its matched modules _and their dependencies_, so a
  group that also named the adapter source dragged `src/lib/log.ts`,
  `src/platform/storage.ts` and the shared adapter base out of `core`/
  `module-video` — which put a statically-imported 115 kB HLS library on the
  LCD's boot path. Measured, not feared. The embed and resolver adapters get
  chunks ranked _below_ `module-video` for the same reason.
- **The ingestion machinery moved into its own `module-video-ingest` chunk.**
  `local/downloadManager.ts` and `local/ingest.ts` are the only part of the video
  module that both pages want and neither page's first paint needs, and they were
  leaving `module-video` at 97 % of its 25 kB budget. `display.ts` now imports
  the download manager through `await import()` at the one moment it is about to
  make a network request anyway (steps 2 and 3 of the resolution order still read
  the eagerly-imported `clipStore`, so a cold boot with the network down is
  unaffected), and the chunk group is ranked _below_ `module-video` with the two
  files excluded from that group's test — ranked above, it claimed `clipStore.ts`
  and `videoTelemetry.ts` as dependencies and `module-video` had to import it
  statically, which bought nothing but a round trip. Measured, not feared.
  `module-video` 25.2 → 23.4 kB gzip, with a 5.0 kB lazy chunk beside it.
- **`budgets.json` gained per-chunk overrides for `perProviderChunk`**, used for
  exactly two chunks: `provider-hls` (120 kB) and `provider-dash` (240 kB), whose
  weight is a fact about hls.js and dash.js rather than about this code. The base
  60 kB limit still governs every chunk we write, and neither vendored chunk is
  on the display critical path. `totalDistMb` raised to 10 MB to accommodate the
  two libraries' published sourcemaps.
- **`ModuleCapabilities` gained `ownsFpsAdvisory`**, so a module that renders the
  §8.1 advisory in its own safe-area overlays suppresses the display shell's
  generic low-FPS banner instead of showing two.
- `src/modules/video/telemetry.ts` moved to `telemetry/videoTelemetry.ts`, and
  `geometryToSourceRect` moved from `youtubeEmbed.adapter.ts` into the pure
  `youtube/geometry.ts` — Twitch, Vimeo and Streamable letterbox inside an
  oversized element exactly as YouTube does, and so use exactly the same crop.
- The `<video>` adapter base gained `attach`/`detach` hooks (for MSE libraries
  that take the element rather than a `src`) and optional quality forwarding.
- `tsconfig.node.json` now includes `src/types/**/*.d.ts`, so the e2e support
  harnesses can fake the provider SDKs against the same ambient namespaces `src`
  uses.

- **The default module is now `video`, not `clock-lite`.** With no configuration
  at all it plays the bundled demo clip offline, which is a better first boot
  than a clock and doubles as the "is the display alive?" answer. `clock-lite`
  stays registered and one click away.
- **IndexedDB `kraken-hub.v1` is now version 2**, adding the `clips`,
  `clipBlobs` and `kv` stores. The upgrade is additive and guarded, so an
  existing database keeps its `media`/`meta` contents.
- **Loopback `http://` is no longer upgraded to `https://`.** `127.0.0.1` and
  `localhost` are potentially-trustworthy origins and are exempt from
  mixed-content blocking — they are where the resolver companion (M2.5) and a LAN
  dev server live, so upgrading them broke the one http origin that works.
- The low-FPS advisory now reads the active module's `motionLevel`: a `static`
  module never nags about a frame-rate slider it does not care about.
- `?demo=1` is passed through to the active module as well as being a boot flag.
- **State schema 1 → 2.** `RenderSettings.fit` gained `'contain-circle'` for the
  video module's round-bezel fit. The change is additive, so the 1 → 2 migration
  rewrites nothing — but the version bump is what makes a v1 build stash a v2
  document under `kraken-hub:v1:state:future` instead of silently discarding the
  new fit mode.
- ESLint: the no-hardcoded-origins selector now requires a host character after
  `//`, so it still catches `https://example.com` but no longer fires on a
  user-facing message that merely mentions the `https://` scheme. Invariant I5
  (`no-magic-numbers` in `src/modules/**`) is waived for test files, where
  reproducing a design document's worked numbers is the entire point.

- **Invariant I8 is now enforced mechanically, in both layers it was specified
  in.** ESLint `import-x/no-restricted-paths` gained the zones the invariant is
  actually about (`src/app/display` and a module's `.ts` display code may not
  import `src/ui` or `src/app/config`; a module's `.tsx` config panel still
  may), and `scripts/check-bundle-size.mjs` gained a `displayGraph` check that
  walks the built manifest's imports transitively from the display entry chunks
  and fails when any reached chunk contains a `src/ui/` or `src/app/config/`
  module. Chunk membership is read from the sourcemaps, so it is robust to
  hashed filenames. Previously a display-side `import { Panel } from '../../ui'`
  shipped the entire configuration UI to the LCD with lint and the size gate
  both green.
- **Closed the aliasing escape hatches in I2 and I5.** The old selectors only
  matched literal `window.nzxt` / bare `localStorage`, so `const w = window;
w.nzxt = {}`, `(window as unknown as { nzxt }).nzxt`, and
  `const ls = window.localStorage` all linted clean — the first of which is the
  house style in `src/platform/nzxt.ts`. Any `.nzxt` member access, any cast
  naming `nzxt`, and any `.localStorage` / `.sessionStorage` member access are
  now errors outside the allowlisted platform files.
- ESLint override blocks are now composed with a `syntaxExcept()` helper that
  waives exactly the named rule group and keeps every other invariant. This
  restores the navigation rules to `src/config/knownHosts.ts` and the
  hardcoded-origin rule to `src/platform/nzxt.ts` / `simulator.ts`, both of
  which had been dropped by hand-listing the survivors. Overrides for files that
  land in M1/M2 are kept and labelled as such.
- `npm run lint` runs with `--max-warnings 0`, and `no-magic-numbers` (invariant
  I3's stand-in, scoped to `src/modules/**` and `src/app/display/**`) is an
  error rather than a warning, so it can no longer pass CI.
- CI runs the Playwright suite: a new `e2e` job installs Chromium (cached on the
  resolved `@playwright/test` version), runs `npm run test:e2e`, and uploads the
  HTML report. Both boot modes, storage sync, the poll fallback, the diagnostics
  hand-off and the no-navigation invariant were previously unguarded on PRs.
- The on-LCD diagnostics overlay renders its live values on the first frame —
  panel geometry, dpr, injection state, Chromium version and build are read
  synchronously — and marks only the rAF frame rate `sampling…` until the 3 s
  window closes. It used to show `…` / `nzxt absent` for the first three
  seconds, which on a 1 FPS panel is a photograph of an apparent failure.
- `docs/design/design-architecture.md` gained a "Corrections (post-M0)" section
  recording where shipped reality wins over the design text (90 kB display
  budget, the `src/platform/storage.ts` vs `src/state/storage.ts` split, and the
  now-real I8 enforcement). The body is left unedited: design docs are
  historical source material.

[unreleased]: https://github.com/ubberkid/kraken-hub/commits/main
