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
[`docs/hardware-checklist.md`](docs/hardware-checklist.md) H01–H33, and the list
in [`docs/BEFORE-PUBLISHING.md`](docs/BEFORE-PUBLISHING.md).

### Changed

- **The low-frame-rate advisory card hung off the edge of every panel that
  showed it.** The card's type was sized `--kh-inscribed / 14` with a title,
  body and footer stacked on top of that, which built a box taller than the safe
  box it is centred in: 405 px of card in 398 px of room on a 640 Elite, and
  233 px in 202 px on a 240 Kraken — 12 px past the glass, with the footer
  sheared off — while the architecture doc promised the card is "laid out
  entirely inside `safeInsetPx`". The video module's own card on the same panel
  fit exactly, because it sizes each paragraph off `--kh-inscribed` directly.
  The shell card is sized the same way now (divisor 16), and below 300 px
  inscribed the footer line is dropped rather than shrunk — the same rule and
  threshold the video card's route footer already used. Measured on the built
  app: 322 px in 398 px at 640 (body 26.9 px), 146 px in 202 px at 240. It
  shipped because every display end-to-end test ran at the default 640×640
  viewport and asserted on text, so a card hanging off the disc read as passing;
  `boot-display.spec.ts` now sets the viewport per panel and asserts the card's
  box against `panel − 2 × safeInset` at 240 and 640.
- **The frame-rate instruction started a paragraph on a lowercase verb.**
  _"drag CAM → Lighting → your Kraken → Web Integration → Frame Rate to
  maximum"_ is correct where it ends a longer sentence (About, the CAM setup
  card: _"Point CAM at this page, then drag …"_), and wrong where it is the
  whole paragraph — the display's advisory card and the config home banner.
  `camPaths.fpsAdvisoryBody()` takes `{ leadIn: true }` for the second case and
  derives the capital from the same verb constant, so there is still exactly one
  instruction and it differs in exactly one character.
- **A stock Kraken Z was told, permanently, to drag a slider that is already at
  maximum to maximum.** CAM offers a Kraken Z exactly one frame rate — 1 FPS —
  which is also the low-FPS threshold, so the display's banner showed the full
  advisory card and then a permanent `1 FPS ⚠` badge on hardware that was
  already configured as well as it can be. Both advisories — the display shell's
  `LowFpsBanner` and the video module's own `FpsAdvisory`, which the shell stands
  down for — now gate on the ceiling for the panel actually attached
  (`maxTargetFpsForPanel`): a panel at its maximum is shown nothing, and an
  unrecognised panel still advises, because a ceiling we cannot name is not a
  ceiling we can claim was reached.

- **The display's banner re-assembled the frame-rate instruction by hand, and so
  said something different from the video module's card on the same panel.** It
  concatenated `CAM_FRAME_RATE_LEAD` + path + `_TAIL` instead of calling
  `camPaths.fpsAdvisoryBody()`, which meant every non-video base lost the
  per-panel _"(40 FPS on this panel)"_ the single owner adds. The shell now calls
  the function with the geometry it already holds, the two badges are one string
  (`‹n› FPS ⚠`), and a source-tree test fails any `.ts` file that names the
  instruction's pieces — they exist only so JSX can bold the middle one.

- **`?debug=1` was documented in three places and implemented in none.** The
  per-layer debug overlay is what the hardware checklist's H24/H30 tell a tester
  to read, and the parameter that switches it on was missing from `KNOWN_KEYS`,
  so the display logged it as ignored and the overlay was reachable only by
  editing stored state a panel has no keyboard to edit. It now sets
  `diagnostics.showDebugOverlay` for that load, and the checklist says `&debug=1`
  rather than naming an internal state field.

- **`?pattern=rings` and `?pattern=flat` measured with the configured look still
  running underneath.** Only `pattern=stack` owned the stage, so the ring target
  for the true-visible-radius measurement (H20) was photographed on top of a
  playing video, and H09's "near-static frame whose only moving element is a
  counter" had a video decoder on the frame path. Both patterns now own the stage
  exactly as `stack` does — no module is mounted — whenever `?diag=1` is what
  draws them.

- **The diagnostics build line named a commit whose code was not what was
  running.** `build 0.1.0 6912550` on a build made from a modified working tree
  is the one thing a build identity must never do, and that line is what a bug
  report quotes. The Vite define now appends `+dirty` when `git status
--porcelain` is non-empty, failing soft to the bare SHA wherever git cannot
  answer; CI builds from a clean checkout, and `GITHUB_SHA` bypasses it entirely,
  so a published build never carries the marker.

- **The reduced-motion rule is written down.** `docs/getting-started.md` now says
  what the code does: the configuration UI's animations and transitions collapse,
  the stats module snaps its numbers instead of gliding them, the video
  placeholder's pulse holds still — and the content you chose keeps running,
  because reduced motion is a request about an interface's flourishes, not an
  instruction to blank a panel whose job is moving pictures.

- **A seven-row table of video aspect-ratio labels rode the LCD's first
  download to serve a three-way control.** `SOURCE_ASPECT_PRESETS` and
  `sourceAspectKey()` lived in `src/modules/video/types.ts` — the one video file
  the eager module manifest imports, so it ships in `core` — and four of the
  seven rows (4:3, 1:1, 21:9, 2.39:1) could only ever return a key the shape
  control does not offer, which it discarded for `'auto'`. Nothing rendered any
  of the labels. The three-way match now derives from the control's own rows in
  `VideoConfigPanel.tsx`; stored ratios are still validated and still drive the
  geometry exactly as before. MEASURED: `core` 23.08 → 22.76 kB gzip,
  `displayCriticalPath` 31.9 → 31.6 kB against a 35 kB gate. The same round
  moved the YouTube embed adapter and the four helpers only it uses — the mask
  state machine, the quality policy, the quality watchdog and the IFrame API
  loader — out of `module-video` into a lazily-fetched `provider-youtube`
  chunk, the same trick the embed, resolver and ingest groups already use
  (ranked _below_ `module-video` so it claims the six leaf files and leaves the
  shared `youtube/geometry.ts` where `embedSurface.ts` needs it): MEASURED
  `module-video` 24.1 → 20.2 kB gzip against its 25 kB budget, with a 5.1 kB
  chunk beside it that a panel playing a local clip never fetches, and every
  other chunk byte-identical.

- **The display page downloaded a UI framework to render static DOM. It does
  not any more.** The hidden Kraken Browser's first download was **89.15 kB
  gzip**, and **57.5 kB of it — nearly two thirds — was React**, booted to
  render a shell that is a stage `<div>`, the compositor's root, and four
  advisory cards that are either on screen or not. That shell re-rendered, by
  its own docstring, "at most a handful of times per session". The compositor
  underneath it has been framework-free since the layer work; this finishes the
  job for the shell around it.

  `src/app/display/DisplayApp.ts` now subscribes to the same two external
  sources the component tree read — the store and the geometry value — and
  writes the nodes that can differ, through an ~80-line helper
  (`src/app/display/dom.ts`): `el` to build a node in one expression,
  `setText`/`setAttr`/`setClass` that write only on CHANGE, and `slot`, a fixed
  position in a parent holding zero or one node, which is what `{cond &&
<Card/>}` was doing and is what keeps the stage's z-order stable as cards come
  and go. There is no diffing and no virtual DOM: every caller knows exactly
  which node it owns. `Stage`, `LayerStack`, `LowFpsBanner`, `ModuleErrorCard`,
  `DebugOverlay` and `src/diag/DiagOverlay` went the same way, and the error
  boundary became a `try`/`catch` around the one function that can throw — the
  panel still degrades to a readable card rather than to black hardware.

  **Measured on the same build at the same gzip level: `displayCriticalPath`
  89.15 → 31.94 kB gzip (−57.21 kB, −64.2 %), across 7 → 6 JS requests, 93,472 →
  34,448 bytes of JavaScript on the wire. First contentful paint on the display
  route went 36–40 ms → 24–28 ms and `.kh-stage` was in the document at 36–39 ms
  → 27–29 ms, over seven cold loads per build against a local preview.** The
  budget gate went from 90 kB to **35 kB** — the smallest multiple of five, the
  unit every kB gate in `budgets.json` is written in, leaving at least 5 % over
  the measured figure.

  Nothing about the panel changed: every class, test id and attribute is the one
  it was, the whole 408-test end-to-end suite passes against the new build with
  **zero selector edits**, and `?sim=`, `?diag=1`, `?demo=1`, `&pattern=stack`,
  the DPR handling, the watchdog, the FPS governor, the monitoring feed, the
  storage listener and the lazily-imported sync layer all behave exactly as
  before.

  The saving is enforced rather than remembered: `npm run size` walks the built
  manifest transitively from the display entry and now fails on any reached
  chunk containing `react`, `react-dom` or `scheduler`, reported as its own
  `displayNoFramework` row beside the existing invariant-I8 row — the two are
  separate claims and are named separately. Run against the previous build it
  fails, which is how we know it is checking something.

  **The configuration page is untouched.** It is a real application with forms,
  routing and a component library; it is never downloaded by the panel;
  `vendor-react` still exists for it and its `configUi` budget is unchanged.
  This is not a project-wide framework removal — it is the observation that the
  _display_ was never rendering anything that needed one.

- **CI's actions ran on a runtime GitHub had already deprecated.** Every green
  run carried the same annotation — `actions/checkout@v4` and friends being
  force-migrated off Node 20 onto Node 24 — so the whole set was moved to the
  majors that declare `runs.using: node24` themselves: checkout v7, setup-node
  v7, upload-artifact v7, download-artifact v8, cache v6, configure-pages v6,
  upload-pages-artifact v5, deploy-pages v5, and create-issue-from-file v6. No
  workflow logic changed; every `with:` input in use is still a valid input on
  its new major.

- **The editor's chrome painted over itself, hid what it was for, and lied
  about what could be a background.** Fourteen measured findings from the
  eleventh closing audit's config half, all of them cases of a surface having
  been laid out correctly for a state it is no longer in.

  Two of them were one CSS rule. `CamSetupCard` has two variants with two class
  names — `.kh-setup` under About and `.kh-band` on first run — and only the
  first was given a grid area in the editor's layout, so on a cold profile the
  first-run band was auto-placed into the row belonging to the floating
  selection strip. A grid row holding an 85 px band is an 85 px containing block,
  so the strip stopped floating over the canvas and painted **544 × 40 px** over
  the band's last line and the top half of both its controls, cutting "Frame"
  in half; measured at 866 × 537 and again at 1280 × 800. Overlap is 0 at both
  now, with neither control covered at any corner.

  The rail was a **porthole onto the stack it exists to show**: with seven
  overlays on the panel at 866 × 537 its row list measured 47 px of clientHeight
  — one row of seven — because the base block below it (nine module chips
  wrapping four rows deep in a 268 px column, the paste field, the nav and the
  status line) laid out first and took 286 px. At CAM's height the chip row is
  now one line that scrolls sideways, as the selection strip already was: the
  list is **200 px and four whole rows**, and 225 px and five at 1280 × 800.

  The selection strip's **More** — the door to everything the strip left out —
  was the last control inside the row's own scroller, so on the two kinds with
  the longest declarations it was simply off the window: measured, the strip's
  box is 542 px, Stats' content was 975 px and Text's 958, putting `ops-more`
  at x = 957 and x = 940, with the row cut mid-control on seven of the eight
  overlay kinds and no affordance saying it went further. `More` is pinned
  outside the scroller now, on screen for all nine strips, the scroller fades at
  whichever end it is cutting off, a mouse wheel drives it sideways, and the
  controls' own footprints came down enough to take Stats to 784 px and Text to
  815 in a 471 px box.

  Five of the ten template cards **were a two-stop gradient and nothing else**.
  The preview policy refuses to run an effect in a card — one graphics context
  each, and a grid of them would evict the editor's own — but it applied the
  refusal to the CARD rather than to the layer, so Overlay, Lava lamp + temps,
  Nebula clock, Sunset loop + clock and Focus each rendered as a single `div`
  with a `background` on it, losing the clock, the stats strip, the ring or the
  text that is the whole difference between them. The effect layer is switched
  off and its own still frame painted behind the stage now; every other layer
  composites over it through the same `LayerHost` the live cards use, under the
  same six-slot budget.

  A pairing link carrying an impossible code **said so where nobody could see
  it**: `#/remote?room=UUUUUUUU` rendered its Notice inside the collapsed "Type
  a code instead" disclosure, and `?phone=1&room=UUUUUUUU` — the same code in
  the ordinary query string — was rejected in complete silence, because only the
  fragment was ever read. Both forms are read now and the refusal is above the
  disclosure, in view on arrival.

  Opening the **inspector** from the strip's Effect or Preset showed **0 of the
  12 effect tiles**: the sheet opens at the top, which is Layout, and its body
  is 365 px over 1,651 px of content. A door that names its destination scrolls
  to it — six tiles in view on open, measured, while `More` still opens at the
  top because `More` asks for the sheet rather than for anything in it.

  Two base pickers disagreed in both directions. The rail's chip row was the
  whole registry — nine chips including Text, Icon and Date, which declare
  `roles: ['overlay']` and cannot be a background — while the add sheet's
  Background row was already derived from `roles` and carried a Solid colour the
  rail did not. One derivation now (`editor/basePicker.ts`), read by both, with
  a unit test and an e2e assertion that names no kind.

  **"Save as…" had an ellipsis and no question behind it**: it saved silently
  under whatever the header said, which on an unnamed Look is the empty string,
  so two presses produced two shelf entries both reading "Untitled look". It
  opens a field in the sheet's own footer now — not `window.prompt` — pre-filled
  with the current name, and refuses an empty one.

  `#/library` on an unpaired, non-owning window **rendered the Remote screen**
  under the breadcrumb "Your Kraken / Remote", replaced the address that had
  been asked for, and overflowed CAM's window by 234 px. The route answers for
  itself now: the shelf's own page, saying where the shelf is and offering the
  pairing that would reach it, at `#/library`, page-fit 0.

  Placement **piled under pressure**. The free-slot search asked whether a
  candidate's CENTRE was inside the safe circle, which on a disc is the wrong
  question — the room at a given height is the chord, not the diameter — so an
  auto-placed Date landed with both ends over the bezel reading "…ed, Se…", and
  when the ring walk ran out the layer was dropped on top of whatever was there.
  Candidates contain their own box now, and a layer that will not fit at its own
  size is retried at 85 %, then 72 %, down to the model's floor before it
  stacks. A property test adds one of each kind in twenty random orders and
  asserts no two overlays overlap and nothing but the first is off the glass.

  Also: the first-run screen **offers three Looks to press** (§4 asked for the
  cards and they had never been built — a cold profile had no template card in
  the DOM at all), standing in the canvas column's left gutter rather than in a
  row under the setup card, because that row cost the halo one pixel for each
  of its own and took it from **320 px down to 199** on a cold profile at
  866 × 537 — the gutter is width a square halo leaves over in a column that is
  not square, so the cards are free and the halo is 320 px again, with a compact
  82 px row as the fallback on windows too narrow or too tall to have a gutter;
  on those same narrow windows the **setup card** stops wrapping — at 760 × 537
  its one sentence went three lines deep and the card took **122 px** out of a
  grid whose canvas row is whatever the window has left, so the halo was 196 px
  with the starters row already as small as it goes; under 800 px of editor grid
  the instruction is now a single line with the whole sentence on its `title`
  (still the one `camPaths.ts` spelling) and both actions share one 44 px row, so
  the card is **86 px** and the halo **233** — with the 866 × 537 form, and its
  320 px halo, untouched; the add sheet's tile summaries get the **two lines** the
  242 px card has room for instead of one clipped line losing a third to a half
  of every sentence; the drag HUD and the strip's numeric readouts print a real
  **U+2212** rather than a hyphen among their tabular figures; and
  `budget.ts`'s header claimed a full look "runs past 90 %" when the measured
  reading is **69 %** — a comment naming a number the app cannot produce is
  worse than one naming none, because the next person tunes the marks to it.

- **The LCD read a menu path aloud, the frame counter was unreadable on the
  diagnostic it exists for, and a fresh effect overlay was a lid.** Three
  measured findings from the eleventh closing audit, all of them cases of a
  surface saying or drawing more than it should.

  With no source configured the display played the demo clip and printed
  _"Demo clip — paste a video link in CAM → Lighting → your Kraken → your
  kraken-hub card → Configure"_ as one sentence in a band across the bottom of
  the disc — **three full-width lines of body type** at 640, a five-step menu
  route read out to somebody standing a metre from a screen they cannot touch.
  It is the house instruction card now: **Nothing chosen yet**, _Pick a video in
  CAM_, and the route demoted to the small footer every other card puts it in.
  `CAM_PATH_CONFIGURE` is still the one spelling of that route. Measured at
  device scale 1: **3 text lines at 640** (footer 341 px on one line inside a
  367 px plate), **2 at 320 and 2 at 240**, every line inside the safe circle
  (worst corner radius **178 px** against a 282 px safe radius at 640). Below an
  inscribed square of 300 px the footer is dropped rather than set at the ~4 px
  it would need — an instruction nobody can read is not a smaller instruction.

  The `?pattern=stack` diagnostic draws a large rAF counter so a maintainer can
  film the panel and count distinct values, which is the only way capture-side
  FPS can be measured at all. Over stacks (c), (d) and (e) it drew white type
  with a 6 px shadow straight onto a full-panel plasma: sampled over the effect's
  bright lobe, stroke against ground was **2.4:1** — and about 1:1 on the
  brightest frames. It now carries the same flat, fully opaque black plate the
  stats module's readouts wear, corner-anchored as before, and measures
  **21.0:1** (7.7:1 against the 90th-percentile ground pixel). No shadow, no
  gradient, no stacking literal.

  A fresh **effect overlay** landed as a `1.2 × 1.2` opaque disc in the centre.
  An effect fills every pixel of its box, so that default was a lid over whatever
  look it was added to; it is a `0.6 × 0.6` badge at `(0.45, −0.45)` and 85 %
  opacity now, the same corner and idiom the image module uses. The **base**
  role is unchanged and still wears the whole panel. In the same pass `date`'s
  default moved from `{w:1.2,h:0.28}` @ `y 0.78` — whose bottom edge at `0.92` is
  outside the 0.88 safe ring, on a chord of about 1.25 — to `{w:1.1,h:0.28}` @
  `y 0.66`. `registry.test.ts` checks every registered kind's `overlayDefault`
  against the panel's chord and the safe ring, so the next one cannot ship off
  the glass.

- **Every Look preview card was blank, the rail pushed the page past CAM's fold
  from the fifth layer, and the carousel could not be switched on at all.** The
  tenth closing audit measured the editor's four surfaces and found three
  mechanisms that were built, wired and inert.

  `LookPreview` shrinks a 640 px stage into a thumbnail with
  `transform: scale(calc(var(--kh-lookprev-size) / 640))`, and the token carried
  a unit — `120px`. `scale()` takes a number, `120px / 640` is a length, so the
  whole declaration was invalid and dropped: every card in the Looks sheet
  rendered the top-left **4.6 %** of a running compositor at 1:1, which reads as
  a blank square. The token is unitless now and the unit is applied where a
  length is wanted; the measured visible fraction is **1.0**.

  The layer rail had no scroller of its own, so each row past the fourth made the
  page taller: page overflow at 866×537 went **0, 0, 0, 0, 8, 48, 88, 128 px** as
  layers one to eight went on, and at eight the BASE row — which is also the
  module chip row, the app's oldest gesture — had its bottom edge at y = 569 in a
  537 px window. The row list takes the `kh-sheet__body` treatment the editor's
  sheets already had, and overflow is **0 at every layer count** with the base
  row, the add button and the paste field all on screen.

  The carousel's picks lived only in `state.carousel`, and `state.carousel` is
  `undefined` for anything under two Looks — so the first press computed `[a]`,
  wrote `undefined`, and the second press read an empty list. It could not be
  switched on at any number of presses. The partial pick is component state now,
  only _enabling_ the rotation is gated on two, and the status line reads
  **"1 picked — pick one more"** in between.

- **The budget meter read 100 % on one video background and called it calm.**
  The bar was `min(1, cost.total)` and `lookCost` is normalised so one video base
  is exactly 1.0 — so the commonest Look in the product pinned the meter, eight
  layers on top of it pinned it identically, and a clock read 0 %. It reads
  against the frame governor's own headroom marks now (`DEMOTE_RATIO`,
  `PROMOTE_RATIO`), and the verdict colours the bar: a video base **60 %**, an
  effect base **36 %**, a clock base **0 %**, and a Look past the busy limit in
  red. The label was truncating too — it wanted 275 px in the 182 the header can
  spare, so every sentence ended in an ellipsis where the honesty was — so the
  meter says _Estimate_ / _Keeping up_ / _Falling behind_, out of the claims
  registry, with the full sentence in its tooltip.

- **The layer cap is visible before it is reached.** It was a disabled button and
  a native `title`, which is the exact ESC failure `research-esc-ux.md` §127
  names: invisible until you hit it, then announced by a tooltip a touch screen
  never shows. The rail counts — **"7 of 8 layers"** — and at the cap says
  _"This look is full — eight layers is the most that fits on the wire."_

- **The editor stopped passing off the simulator's numbers as readings.** With no
  telemetry the halo runs the real stats renderer against
  `platform/simulator.ts` — the right call, because an empty gauge teaches nobody
  anything about the face they are arranging — and it read _41 °C · CPU · 16 %
  load_ with nothing anywhere saying so. One claim, through the presence spine:
  **"Sample readings — until CAM sends real ones"**, on the halo and under the
  Looks grid, with the affected cards marked.

- **The Looks sheet moved off the halo.** It was `position: fixed; left: 12px`
  and 560 px wide over a halo running x = 84…499, so browsing Looks covered the
  one thing on the screen that shows what a Look looks like — while the editor's
  other two sheets stood politely over the rail. It takes the rail's column now,
  with the sheet body scrolling and a two-column card grid, and the page grows by
  nothing in either direction.

- **Readable numbers, an honest taxonomy, and four smaller things.** The drag
  HUD printed `0.04, −0.68` — the model's diameter units — and now reads
  **x 26 · y −435 · 100 % · 0°**, with the inspector's Layout fields converting
  at the same edge (px from the centre, %, °) while the document keeps its own
  units. The add sheet's Background row is derived from `layer.roles` rather than
  a hand table, so Video, Effect, Picture, Clock, Stats and Shape are all
  reachable as backgrounds and Text, Icon and Date — overlay-only in their own
  manifests — cannot appear there. A locked layer stays selectable from the rail
  (refusing it put the layer's own inspector behind its own lock) and the strip
  says why its controls are grey. A room code arriving in a link with an `I`,
  `L`, `O` or `U` in it is now spoken — _"That code has a letter Crockford codes
  never use"_ — through the same refusal path a typed one uses, instead of
  silently showing the pairing card. Rail rows are 40 px, and a sheet's close
  button is 44×44 on a touch screen rather than 26×26.

- **The editor's overlay follows your finger, several layers can be moved at
  once, and every layer can be locked.** The editor audit measured a set of
  controls that were drawn but not wired: the selection box and its five handles
  did not move during a drag (the cursor travelled −90, −90 and every handle
  centre travelled 0, 0 until release), ⌘A and a marquee marked rail rows while
  the canvas showed zero selection boxes and offered no group operations, Escape
  did not deselect, the budget meter's bar was 0 px wide and read `—`, and
  `document.getAnimations()` was empty after adding a layer, removing one and
  switching the background.

  The overlay now follows the layer with **one attribute write on one `<g>` per
  frame** — `M(now) · M(start)⁻¹`, the affine that takes the box from where it
  was to where the finger is — so the box, the handles and the HUD travel with
  the layer while the one-commit-at-release contract and invariant I4 stay
  exactly as they were. Guides only re-render when the guide set actually
  changes, which takes a drag from a React render per frame to none.

  A selection of two or more draws a box per layer and one around the group,
  with the same corner handles and lollipop; a group move, scale or rotate is one
  `transformMany` and therefore **one undo step**, and the strip becomes the
  group's: six alignments, a reference (the canvas or the selection's own box)
  and distribute. `Layer.locked` is a new optional field — the schema stays at 7
  because it is optional, `validateLook` is its only gate and repairs anything
  that is not a boolean to absent — and a locked layer is not hit-testable, not
  draggable, not in a marquee, and refuses every transform op with a typed
  `'locked'` reason.

  Alongside them: Escape deselects (standing down while something is open or the
  caret is in a field); the arrow keys nudge **one panel pixel**, ten with Shift,
  rather than a unit-hundredth that meant 3.2 px on an Elite and 1.2 on a square;
  `data-testid="ops-more"` is on the button only rather than on the button and
  its wrapper, which was a strict-mode violation in the repo's own e2e; the
  budget meter's track has a definite width and prints the estimate as a
  percentage rather than an em-dash; the rail's z-order arrows are 24 × 24 rather
  than 24 × 18; a strip's long choice scrolls sideways instead of wrapping to
  four rows (Stats was 131 px tall and Text 108, over a halo the strip now floats
  on); and `--kh-surface`, used five times in `ui.css` and declared nowhere, is
  declared.

  **`More` opens an inspector**, in the rail's column, rather than the home
  screen's module options panel: Layout as typed numbers through the same ops a
  drag uses, the kind's own panel, Visibility and Advanced, closed with Escape.
  The halo does not shrink for it. The floor-yielding panel is unchanged on the
  phone's single-column home, where there is no rail to open a sheet in — and
  when it does open at editor widths it now takes the canvas column, because as
  a full-width row underneath it left the rail overflowing into it and the module
  chips unclickable.

  §7's motion is real: a layer fades and scales in on arrival, fades out before
  it unmounts, and a base switch reuses the Look switch's existing 350 ms
  cross-fade rather than growing a second mechanism. All three honour reduced
  motion by not running, and all three are WAAPI, so `settle()` can see them.

  The add sheet gains **Sticker** — the image kind with the two settings a
  transparent PNG needs already answered — and a **Solid colour** background
  entry that uses the shape module's own `SOLID_BASE_CFG` rather than a second
  opinion about what "solid" means.

- **The display's download is counted honestly, and the vocabulary stopped
  riding along on it.** `rolldown-runtime` — the bundler's own module-registry
  shim, a _static_ import of the display entry, which `displayGraph` (I8) has
  always reported as reached — was not in `displayCriticalPath.chunks`, so
  0.19 kB the Kraken Browser downloads before the LCD paints was not weighed.
  It is now: the gate reads 90.4 kB rather than 90.2, and the number moved
  because the measurement got more honest, not because the app got bigger.

  Alongside it, `src/config/words.ts`: the app's dictionary
  (`config/vocabulary.ts`) is config-only prose, and exactly one eager,
  display-path file said a word from it — `modules/video/index.ts`, whose
  one-line summary reads "kept on this PC". The two terms it needs now live in
  their own dependency-free file that `vocabulary.ts` re-exports, so there is
  still one spelling of each word and `vocabulary.test.ts`'s single-source rule
  still holds, and the display no longer _imports_ the dictionary. The bytes do
  not leave `core` yet: that group claims `src/config/` by PATH rather than by
  importer, so vocabulary rides along regardless of who imports it — the same
  shape `lazy-shared` was invented for, and a one-line chunk-group change worth
  a measured 0.6 kB (90.4 → 89.8 kB) — since made: `config/vocabulary.ts` and
  `config/knownHosts.ts` moved into `lazy-shared` (`core` 24.75 → 24.22 kB,
  `lazy-shared` 4.79 → 5.43 kB), taking the display's critical path to **89.8 kB**
  under the 90 kB gate with `displayGraph` (I8) still clean, while `words.ts`
  stays in `core` because the display genuinely reads it.

  And the same shape once more, for the same reason: **the selection strips left
  the LCD.** Nine manifests declared `editor.strip` inline — five control
  declarations each, plus the swatch tables, font lists and segment labels only
  the strip reads — and the manifests are eager, because the registry validates
  stored config before anything renders. So the Kraken Browser downloaded the
  editor's entire control vocabulary before it could show a frame, on a page
  that has no editor: 3.2 kB raw of config-only data on the critical path.

  `KrakenModule.editor` is now `{ loadStrip: () => import('./editor') }` and each
  kind's declaration lives in `src/modules/<kind>/editor.ts`, which the existing
  `module-<kind>` chunk group claims with no build-config change. The contract
  did not get weaker: `defineModule()`'s DEV assertion and the registry
  conformance suite both **await** the loader, and the suite iterates the whole
  registry — every kind still has to prove ≤ 5 controls with `More` last, unique
  ids, a `'layer'` control that addresses only `t.*`, and a path that resolves
  against its own defaults — with one test added to prove that all nine loaders
  resolve to nine distinct strips, so laziness cannot hide a kind. The config
  page loads a kind's strip when a layer of that kind is first selected and
  caches it per kind; the row reserves the 26 px its controls occupy meanwhile,
  so the strip measures 40 px before, during and after the load and neither it
  nor the halo moves. Measured on a preview build: 42–82 ms from click to
  controls on the first selection of a kind (the strip's own chunk is a few
  hundred bytes; most of that is the module chunk carrying it), 19–36 ms once
  warm.

  Alongside it, `src/modules/swatches.ts`: `text`, `date` and `icon` each
  declared the same five `#rrggbb` literals and `shape` declared four that agreed
  with three of them. There is one list now, and shape composes its `none`/white/
  black/amber/cyan row from the same named inks — a consistency fix rather than a
  size one, and the reason "the same five, everywhere" is a test instead of a
  sentence in four doc comments.

  Net: `core` 69.46 → 66.13 kB raw, 24.46 → 23.63 kB gzip, and the display's
  critical path **89.8 → 89.0 kB gzip** with `displayGraph` (I8) clean and the
  reached-chunk set unchanged — and then the nine declarations left the display
  chunks too: a `module-editors` group (priority 93, above the module groups)
  claims every `src/modules/*/editor.ts` plus the shared `swatches.ts` into one
  1.35 kB gzip chunk, so the first selection of a video layer fetches that
  instead of the 24 kB player, nine kinds cost one round trip rather than nine,
  the ink table leaves `core` (23.54 → 23.38 kB gzip) and the critical path
  settles at **88.9 kB gzip**; the loaded strip is cached in a map inside
  `src/app/config/editor/strip.ts` rather than on `EditorContract`, so the
  manifest type the display compiles against is the loader and nothing else.

- **The stats faces stopped chunking, went hue-led, and grew three more.** A UX
  audit sampled the arc's `stroke-dasharray` every animation frame on
  `?module=stats&layout=single` and found it changed **13 times in 8 s** — one
  step per second, on a face whose whole point is that it glides. It changed
  86–115 times in the same window when a diagnostic stack put another animated
  layer beside it, which was the clue.

  - **F4 — the module's own timer was killing its own tween.** `stats` keeps a
    1 Hz `setInterval` so a host that never calls `frame()` still paints and so a
    feed going away is noticed. That interval called `step(1000 ms)`, and a `dt`
    of a whole second settles every glide in one step by design. It was started
    at mount, a beat after the simulator's own 1 Hz feed timer, so on the
    display the two fired in the same millisecond in that order: the sample
    re-targeted every tween, and the module's own timer snapped all of them to
    the target before a frame could run. The 420 ms tween only ever ran when
    something else shifted the timer's phase. It now settles from the interval
    only when **no frame has arrived in the last 250 ms**, so whichever clock is
    actually driving the module owns the glide. Measured on a preview build at
    640, distinct arc values in 8 s: **single 13 → 46, grid 86 → 472**, and the
    hero's distinct readings on the grid face 25 → 27. Two tests pin it — one
    asserts at least eight distinct arc values inside a single `TWEEN_MS`, the
    other fakes the timers while leaving `performance` real so the interval
    fires mid-glide and has to leave it alone.

  - **M7 — the faces were monochrome; the prototype was never.** The default
    theme was `mono`, so every face read as a grey dial on a grey panel. The
    resting hue is now **teal** — the same `#4fd8d2` as `--kh-accent` in
    `src/ui/ui.css`, carried in `STATS_PALETTES` because `ui.css` rides the
    config chunk and the display page never loads it — with the track a lighter
    step of that hue, exactly as `docs/design/layers-prototype.html` draws it.
    The digits stay ink at every state: text wears text colours. `mono` is still
    on the list. The one-hero faces gained the prototype's sub-line —
    `48% load · 4.8 GHz` — built only from fields CAM actually publishes
    (`cpu.load`, `cpu.freqMhz`, `gpu.*`, `ram.usedMiB`/`totalMiB`), with an em
    dash in place of any the feed does not carry. Because that line no longer
    repeats the component's name, the hero is labelled again: the single face
    used to hide its own `CPU`.

  - **M8 — the triple face collided with itself.** The two outer readings sat at
    `left: 33%`/`67%`, which on a full panel is exactly where the innermost arc
    passes at the height they were on: the ring struck through both labels, and
    the whole group sat ~30 px above centre. Measured on a 640 panel before:
    the arc crossed the outer labels' band; after, the furthest corner of any
    glyph is 111 px from centre against an inner radius of 141 px, the group
    spans 236–398 px for a midpoint of 317 against the panel's 320, and the
    face has four distinct baselines instead of two. A unit test now pins that
    every slot's label is the metric that slot displays, on every face, with a
    metric set deliberately unlike the defaults — and that a metric is labelled
    twice only when it was configured twice.

  - **Three more faces, for parity with CAM's own modes.** `bar` (three linear
    gauges stacked), `vertical` (the same three stood on end) and `chart` (the
    sparkline promoted from a garnish to a face: sixty seconds per slot, the
    endpoint emphasised, no axis chrome). All three read the SAME three metric
    slots the ring faces read, so switching face never changes which sensors are
    on the panel, and all three obey the module's dataviz rules — thin marks
    with rounded ends, tabular numerals, one accent hue, a threshold that never
    travels without its word, tweened values. They are three more segments in
    the face chooser that already existed: the editor strip still carries
    exactly five controls.

    The linear gauges are two boxes rather than an `<svg>` line, and that is a
    correctness point rather than a preference: a gauge has to stretch to its
    row, which means `preserveAspectRatio="none"`, which distorts a round cap —
    and `vector-effect="non-scaling-stroke"`, the usual answer, moves the DASH
    into viewport units too, so `stroke-dasharray="100 100"` repeats every
    hundred pixels and paints a row of ticks. That is what the face rendered
    before it was replaced.

- **A text layer's visual centre is its anchor.** `.kh-text` is a flex box that
  centres both axes — the cross axis always, the main axis from `align` — rather
  than centring one and leaving the other to `text-align`, which positions
  glyphs inside a line box that still spans the whole layer. The rendered line
  now hugs its words, so anything measuring it (the editor's outline, a test, a
  person with a ruler) measures the words. Measured on a preview build, glyph
  centre against host centre: **−1 px vertical, 0 px horizontal** on a 384 × 96
  layer at 640, unchanged by the edit — the audit's reported ~32 px offset did
  not reproduce in this module, and the shots it came from show a selection
  outline left behind by a drag rather than type sitting high in its box. The
  rule is now structural and asserted against the shipped stylesheet, so it
  holds for a line that wrapped and for a box far taller than one line of type.

- **Two parity kinds, and the solid base.** The editor spec's §10 checklist names
  a set of kinds that must exist; an audit of it against the registry found three
  missing. Two are now modules and one turned out to be a config.

  - **`icon`** — one glyph from a curated set of **forty-eight**, drawn in this
    repository on one 24×24 grid, in five drawers (hardware, ambient, symbols,
    arrows, shapes). No icon font and no third-party set: a font is a network
    request on the display path and there is no network in CAM, and a borrowed
    set is a licence file somebody has to keep true. A glyph is either drawn
    (one stroke, whose width is the config's weight) or solid (filled, and the
    weight does nothing) — a heart with a hole in it is not a lighter heart, it
    is a different symbol. Overlay only, `resize: 'frame'`, `static`. The
    strip's first control is an `action` rather than a row of segments, because
    forty-eight options is not a strip control at any width: it opens the
    module's own panel, where the grid has a search field and five category
    drawers. Every glyph renders exactly one `<svg viewBox="0 0 24 24">` with
    exactly one `<path>`, asserted over the whole table, so a `d` drawn on
    somebody else's grid fails in CI rather than on a panel.
  - **`date`** — today, in one line, in six locale-aware presets plus `iso`.
    Five of them are the browser's own idea of how the reader's locale writes a
    date; `iso` is `YYYY-MM-DD` by definition, assembled from the date's LOCAL
    fields, because `toISOString()` is UTC and would print yesterday all evening
    west of Greenwich. An unknown language tag falls back to this machine's
    locale rather than blanking the layer. The tick budget is the point: one
    integer compare per frame, one `Intl` format per minute against a cached
    formatter, one DOM write per day — which is what lets `cadence: 'tick'` and
    `motionLevel: 'static'` both be true. Overlay only: the clock already offers
    a date line on a base that also tells the time, so a date base would be a
    worse clock with a setting missing.
  - **The solid base was already there and could not be reached.** The shape
    kind is base-capable and a full-panel `rect` IS §10's solid base; what was
    missing was the config that makes it one, because the module's defaults are
    a translucent rounded scrim — the right default for a band under a caption
    and emphatically not a flat ground. `SOLID_BASE_CFG` (opaque,
    square-cornered, unstroked, edge to edge) now lives next to those defaults,
    so the add sheet and the templates share one idea of "solid" instead of each
    writing down their own.

  Both kinds have their own chunk group and both pass the registry conformance
  suite, the strip enumeration and the two-instances suite with no test written
  for them — which is the deal `docs/modules.md` §11 makes with a contributor.
  Documented in [`docs/modules-icon-date.md`](docs/modules-icon-date.md).

  **Not built, deliberately:** Sticker (an image overlay tile) and the Bar,
  Vertical and Chart gauges (stats faces) — both are other kinds' work, not new
  modules. **Unverified:** the two rows added to `tests/e2e/modules.spec.ts` were
  NOT run; another agent held the ports the Playwright config pins.

- **Looks arrived on the screen.** The format, the ten designed templates and the
  gallery data landed in the previous wave and had nowhere to be seen; the Looks
  menu was a dropdown of one base-only Look per module kind, derived from the
  registry, with a comment saying so. It is now a sheet with four groups —
  **Templates**, **Your Looks**, the **Gallery** and the **Carousel** — and a
  file row underneath it.

  - **Every card is the Look running.** A real `LayerHost` per visible card, at
    the panel's own pixel size and scaled down by CSS, through the same preview
    registry the editor's canvas uses — so a card is a true likeness rather than
    a screenshot that can quietly stop matching its file. Two caps keep a grid of
    those honest about its cost: **six live at once**, claimed as cards scroll
    into view and released as they leave, and **an effect is never live in a
    card** (one WebGL context each, and a browser's per-page limit is small
    enough that a grid would evict the editor's own canvas — so an effect card
    paints the still frame the effect module itself falls back to, which is the
    user's own palette).
  - **Applying is one operation and one undo step.** A Look is an arrangement
    AND the settings its base wears, and those live in two places in the
    document; writing them in two commits would be two synced snapshots, with a
    peer seeing the new arrangement in the old settings. `useEditor.applyLook`
    writes both in one `commit` and pushes one history entry, so undo crosses a
    Look switch in a single press. The canvas cross-fades for 350 ms, driven by
    the Web Animations API rather than by React (I4).
  - **Undo across a base-KIND change was silently reverted, and is not any
    more.** `validateAppState` rewrites `look.layers[0].kind` from
    `activeModuleId` for this release, so an undo that restored a look with a
    different base wrote the look and left the flat field behind — and the
    validator put the base back on the way to storage. Pressing undo did
    nothing, twice. The history's `setLook` now goes through `withBaseKind`,
    which is the one place in `src/app` allowed to write that field. Found by
    the new test, not by a report.
  - **Files.** Export writes a `<name>.krakenlook` — on CAM's configuration
    window only; the display has no file manager to find it with. Import takes a
    file picker, a drop on the sheet, or a paste of the JSON itself, and all
    three end at the same total parser. Its five refusals each get a card that
    says what the file is and what to do about it; a person is never handed
    `wrong-format`. Media the receiving machine does not have becomes a card
    naming the missing file, with the move that surface can actually make.
  - **Your Looks.** Kept in this browser profile
    (`kraken-hub:v1:looks`), not in the document — fifty complete arrangements
    would be a hundred kilobytes on an 8 kB sync envelope describing panels
    nobody is looking at. Rename, duplicate, favourite, drag to reorder, export,
    delete-with-a-confirm, capped at fifty with a card that names the way out
    (export one; a file has no limit). One corrupt row costs one Look, not the
    shelf. The live Look's NAME moved in here too, out of the single-purpose key
    W5 parked it in, and the old key is adopted once and retired.
  - **The Gallery** reads `looks/index.json` with an ordinary `fetch` for a file
    next to the page, so a fork reads its own. A deployment that ships the app
    without the folder gets a card saying exactly that and pointing at the
    repository, rather than an empty group that looks like a bug. The folder now
    lives at `public/looks/`, the one directory the build copies next to the
    page, so a built site serves the catalogue and its ten files at
    `<base>/looks/…` and the sheet shows the grid rather than that card.
  - **The carousel** rotates a chosen set of two or more saved Looks on an
    interval from 30 seconds to an hour. It runs **only in the window that owns
    the saved-Looks store**, and the UI and the docs say so: the ids name rows in
    one browser's storage, so no other window — the display least of all — can
    turn "the next id" into a Look. The panel renders whatever `look` it was last
    given. Putting the look BODIES in the document so the display could rotate
    them itself was considered and rejected on the wire budget. A rotation is not
    an edit and does not enter the undo stack. **And it reads the media library
    only when a rotation is actually on** — at mount if it already is, on the
    switch-on, or on a tick that has to resolve media — because reading it at
    mount opened the library database on CAM's boot path, listing every clip and
    picture and running the legacy→merged picture migration, for a feature that
    is off by default; booting the home screen with `?cam=1` now opens **no**
    database (was one), and `looks.spec.ts` counts `indexedDB.open` to keep it
    that way.
  - **`carousel` is the first additive field not to move the state schema**, and
    `src/state/schema.ts` and `src/state/migrations.ts` both carry the argument
    rather than leaving it to be re-derived: every past bump protected a value an
    older reader would have destroyed, and this one is a pointer into a store an
    older build never reads or writes. It is optional, the validator repairs it,
    and a set that shrinks below two turns itself off instead of rotating between
    one Look and itself.
  - **The LCD pays nothing for any of it.** `src/state/look/templates.ts` (the
    ten designed Looks) and `src/state/look/file.ts` (the reader/writer) live
    under `src/state/`, so vite's `core` group claimed them by path and wiring
    the sheet up took the display's first download from 88.4 kB to **90.6 kB
    against a 90 kB gate**. They are now a `looks` chunk — the `lazy-shared`
    shape exactly, ranked below `core` with the matching lookahead in `core`'s
    own test, because a dynamic import alone does not move a module out of a
    group that claims it. Measured after: **88.6 kB**, with `config-ui` at
    57.3 kB against 140. A grep test keeps `src/app` from ever importing the
    template table statically.

- **The LCD's first download stopped paying for code it never runs.** Counting
  the compositor (`render-shared`) in the display critical path — correctly, it
  is statically imported by `LayerHost` — pushed the measured total to 93.76 kB
  against a 90 kB gate. The gate was not loosened and no function was removed.
  Both chunks the LCD downloads before it can paint claim their contents by file
  PATH rather than by importer, and a static-import walk from
  `src/app/display/mount.tsx` showed what that had quietly bought: the display's
  sync half (`display/sync.ts`, `replicaFeed.ts` — behind `await import('./sync')`
  and only when a room is configured) and nine shared leaves whose every importer
  is a lazy chunk (the IndexedDB media store and its wrapper, replica thumbnails,
  the diagnostics capability probe, the known-host table, curation, chunked
  telemetry, the library packet). They are now two new groups, `display-lazy` and
  `lazy-shared`, fetched alongside whichever lazy chunk actually wants them.
  `core` 25.67 → 21.91 kB, `display-shell` 5.82 → 2.98 kB, path **93.76 → 87.2 kB**
  — inside the design's ≤ 88.5 kB target with 2.8 kB of headroom against the gate.
  This is a split, not a re-label: nothing moved that the boot path imports
  statically, and the `displayGraph` (I8) walk and the per-module chunk-isolation
  e2e both still fail on a real leak.

- **Round 9 — four parked product decisions, made, plus the phone bug they
  surfaced.** Every item here had been deferred for the same reason: the code
  already supported both answers and nobody had chosen. Deferring a choice is not
  neutral — it ships one of the answers silently, with no control and no words.

  - **The YouTube player shape is the user's again.** `youtube.mode` has always
    had two values and the engine has always read both — `square` makes the
    iframe as tall as it is wide, so YouTube's own chrome is pushed outside the
    crop; `tight` makes it exactly as tall as the video plus its bar-safe
    padding, which is ~25 % fewer composited pixels for the same picture. The
    round-1 census killed the control, which left a field with exactly one
    reachable value. It is back as a two-segment **YouTube player shape** row
    inside the video module's one Advanced door, with words that say what the
    trade IS rather than labelling one of them "(recommended)", and with a helper
    line admitting the one case where the app overrides it (a Kraken short of
    frames uses Tight regardless). No schema change: the field, its validator and
    its default were all still there. The 5 → 6 migration still deletes what it
    deleted, and a comment there now says why that is a historical record rather
    than an oversight.

  - **Storage persistence is a state, not a warning.** The app has called
    `navigator.storage.persist()` since M1 and CAM's webview **grants** it — the
    diagnostics report reads `persisted: true` on real hardware — and the Library
    warned about eviction next to it anyway, in orange, forever. Three things
    changed. `ensurePersisted` no longer short-circuits on a `persistGranted`
    flag the app wrote down (site data gets cleared and profiles get copied; a
    remembered `true` promises a durability the browser has revoked) — it asks
    `navigator.storage.persisted()` every time. It runs on **every** add rather
    than the first, and it fires at the TOP of the ingest rather than after the
    quota check, the metadata probe, the thumbnail and the write — the request
    Chromium is most likely to grant is the one made while the press is still the
    reason the page is doing anything. And it moved to `platform/idb`, because it
    was in the clip store, which meant a library of pictures had never asked at
    all. The shelf then says one of exactly two true things: a quiet **Kept
    safely on this PC** when the grant is held, or the existing warning, with its
    tone and its remedy, when it is not. The warning can no longer appear
    alongside a grant.

  - **One way into CAM.** The install band and the About card each offered two
    equally-weighted install buttons, the second for a channel almost nobody is
    on. One primary **Open in CAM**; **Open in CAM Beta** is a plain text link
    inside the _Show the address_ reveal — still reachable, still one press, no
    longer a question asked of somebody in their first minute.

  - **A phone gets the remote, and only the remote.** Typing the site URL on a
    phone, following an old `#/library` bookmark or landing on `#/about` now
    resolves to `#/remote`, in page, by rewriting the hash (invariant I1/I2: the
    app still performs no navigation anywhere). Every configuration screen is
    advice about a PC — _point CAM at this address_, _raise the frame-rate
    slider_, a shelf backed by a file picker, a broker field — and a phone is not
    that PC; this is the argument `ownsBytes()` has always made about the
    Library's file controls, applied one level up to the pages themselves. The
    phone keeps everything that drives the one Kraken from somewhere else: the
    ring, the transport, the A–B loop, the link field, **Send a file** over the
    LAN, the Library (the same wire-fed shelf `#/library` would have drawn) and
    the whole of pairing. It loses the About page's connection plumbing, so the
    remote stops rendering a link to it there — a link that resolves back to the
    screen it was pressed on is worse than no link. The gate is
    `(max-width: 700px) and (pointer: coarse)`: the device, not the width, so
    dragging a desktop window narrow never changes which app you are using. A
    desktop browser is untouched (it is the same remote at a desk, and it is also
    a machine that can install CAM), and CAM is never gated at any width.
    `?phone=1|0` overrides the measurement, the same simulator seam `?cam=` is.

- **W0 — the layers spike: measure first, design second.** Before the layers
  architecture commits to stacking up to eight absolutely-positioned hosts on
  the LCD, the cost of doing that is now a number rather than an estimate.
  `?kraken=1&diag=1&pattern=stack&stack=a|b|c|d|e` composes five stacks of
  increasing cost out of the modules that already exist — video + stats strip,
  video + stats + clock + text, a procedural gradient base + stats, that base
  plus four translucent overlays, and eight layers — each drawing the H09 rAF
  counter on top so the panel can be filmed and counted. Measured on the
  simulator at `targetFps` 40 over a 12 s window: eight layers cost **0.022 ms
  of JS per tick in total**, `achievedFps` does not move from the shallowest
  stack to the deepest (40.03 → 39.97), and `longFrames` is **0** everywhere.
  Layers that do not animate implement no `frame()` and are never called at all.
  Numbers and method: [`docs/design/w0-measurements.md`](docs/design/w0-measurements.md).

  Two things came out of it beyond the numbers. The debug overlay grows **one
  line per layer** — `p95` and EMA of that layer's `frame()`, accumulated in
  closure state and read once a second, so nothing per-frame ever touches React.
  And the DOM question the whole reorder design rests on is settled in Chromium:
  a `<canvas>` moved with `insertBefore` keeps its WebGL context, its
  `isContextLost()` stays false and its pixels survive; an `<iframe>` moved the
  same way has its window and document **replaced** and re-navigates. That is
  the reason the base layer never moves in the DOM — a YouTube base would reload
  — and it is carried as a unit test, not a comment.

  What the spike deliberately cannot answer is what CAM's compressor does to any
  of this: nothing inside the page can see the capture pipeline.
  `docs/hardware-checklist.md` gains rows **H24–H28** for the same five stacks on
  real hardware, ending in the explicit question _"does compressor load reduce
  page `achievedFps`?"_ with a space for the answer — because that answer decides
  whether a layer governor can see overload coming at all, or whether declared
  layer costs stay estimates forever.

  The spike is **throwaway** and says so in every file header
  (`src/render/compositor.spike.ts`, `src/diag/patterns/stack.ts`, the
  `&stack=` flag, the `?pattern=stack` branch): it is reached only through
  dynamic imports behind the diagnostics flag, the build manifest confirms
  `display-shell` never statically imports it, and it is deleted when the real
  compositor lands.

- **The editor is a model, not a mouse.** Every edit a look can undergo now
  exists as a pure function in `src/app/config/editor/` — `ops`, `gesture`,
  `snap`, `bounds`, `history` — with no DOM, no React and no registry import.
  The halo handles, the phone ring and the chip row (W5/W6) may call these and
  nothing else, which is what will make a drag on a phone and a drag on a
  desktop provably the same edit rather than two implementations that agree
  until they don't.

  - **A limit is a refusal with a reason, never a silent drop.** `addLayer`,
    `duplicateLayer` and `setConfig` return `{ ok:false, reason }` for the five
    cases that can actually happen: a ninth layer, a second video, a third
    effect, a kind this build has never heard of, and a look that would cross
    3 kB. The byte cap has to be refused _here_, at op time, because the wire
    refuses to truncate `layers` — so if an op quietly dropped an overlay the
    user would lose work with nothing on screen to explain it. Every op leaves
    through `validateLook`, so no op has to remember that the base carries no
    config and none of them can write a document the display would repair.

  - **Snapping is stated in units, so two Krakens agree.** There is not a pixel
    anywhere in `snap.ts`: the centre crosslines, the twelve clock angles, the
    rings at `0 / 0.5 / safeRadiusPct`, the tangent that puts a layer's farthest
    corner exactly on the safe circle, the other layers' centres and edges, and
    a square panel's edges and thirds — all against `1.0 = radiusPx`, all with
    one 0.03 u threshold. A 640 round Elite and a 240 square Kraken 2023 snap
    identically because the only thing the function learns about the panel is
    its shape. The centre crosslines deliberately snap centres only: let a box
    put its _edge_ on `x = 0` and "drag it to the middle and it lands at 0,0" —
    the first snap anyone tries — stops being true for every layer wider than
    the threshold.

  - **A drag is one edit.** `beginGesture` captures the layer as it was,
    `applyGesture` answers "where would it be now" without committing anything
    (the caller feeds that to the live preview — one style write, never a React
    render), and `endGesture` produces the single look that lands in the store
    and the single entry that lands in the undo ring. Undoing a drag returns to
    where the finger went down, not to the penultimate frame. `endGesture` is
    also where the resize split lives: a clock commits its _box_ and leaves
    `t.s` at 1 (re-layout, crisp text), an image commits `t.s` (no re-layout, no
    decode).

  - **Undo takes somebody else's edit as an entry.** 50 look snapshots per
    editing window, never synced and never persisted; a change arriving from
    the phone or the other CAM browser is pushed like any local edit and clears
    redo. The alternative is a merge, and this document is last-writer-wins by
    design — so undoing after a remote edit walks back through what actually
    happened to the panel rather than through a story about it.

  - **One geometry, three surfaces.** `src/render/layerBox.ts` is the only place
    a layer becomes pixels: `hostBox`, `layerGeometry` (each layer's own
    `--kh-safe`), `hostStyle` (exactly the compositor's declaration block, `{}`
    for the base so the one-layer DOM stays byte-identical), `layerMatrix`,
    `layerBounds` and a rotation-aware `hitTest` that never returns the base.
    The compositor, the phone replica and the editor share it, so the editor's
    handles cannot land somewhere the display did not put the layer.

  - **The registry arrives through a port.** `registryPort.ts` states the three
    facts the editor needs — `roles`, `maxInstances`, `resize`/`minFrame` — as a
    structural subset of the real `LayerPlacement`, injected. The editor never
    imports the eager module registry, and its tests state the placement they
    are testing against, so "a third effect is refused" is a fact about the op
    rather than about the effect module.

- **A module now says where it may sit, and what it costs to put it there.**
  `KrakenModule` gains one optional block, `layer` — `roles`, `maxInstances`,
  `resize`, `minFrame`, `overlayDefault` and a pure `cost()` — and the four
  shipped modules declare it. Nothing else about them changed: a build with one
  module in its look renders exactly the bytes it rendered before, and a fork's
  module with no `layer` at all keeps working, because `placementOf()` derives
  the conservative legacy answer (base only, one instance) for it.

  - **The rules run in exactly one place.** `src/modules/stack.ts` is the only
    file in the codebase that knows a video cannot be an overlay.
    `normalizeLook()` turns a stored look into a render plan and a list of notes,
    and it **never edits the document**: an unknown kind is skipped at render and
    kept verbatim, so a look made by a newer build survives a round trip through
    an older one; a base-only kind found at index 2 is planned off with a note
    somebody can be shown; instances past `maxInstances` — and past `Σ decoders ≤
1`, `Σ gl ≤ 2`, which are hardware limits rather than per-kind ones — are
    planned off in array order, so the layer you added first is the one that
    survives. When nothing is wrong it returns the ORIGINAL array by reference,
    which is what lets the compositor and the home screen memoise on it.

  - **A look has a price, and it is honest about being an estimate.**
    `lookCost()` implements the design's formula — cadence × painted area ×
    entropy, plus a charge for the compositor surface a translucent layer forces
    — normalised so one video base is exactly 1.0. It is a DECLARED cost, not a
    measured one, because the expensive half of this machine is CAM's capture and
    compressor and nothing on the page can see it. The word "estimate" travels
    with the number.

  - **`ctx.layer` and the end of "the" instance.** A renderer is told which layer
    it is, and the replica thumbnail seam is keyed by layer id instead of being a
    single slot — the slot was exactly right while a look could hold one module
    and exactly wrong the moment it could hold two pictures, where the second
    mount would have overwritten the first and unmounting either would have
    blanked both. The old single-slot API is still there, still meaning the base,
    because that is what today's replica feed publishes.

  - **The two-instance test.** Every overlay-capable module is now mounted TWICE,
    into two hosts with two different layer ids, driven on one, and asserted
    unmoved on the other — including through an unmount. It runs off the
    registry, so a new module gets the guarantee, and the failure, for free.
    Alongside it the conformance suite asserts every registered module declares a
    valid placement, that `cost()` is pure, small and in range, and that
    `motionLevel` and `cost().cadence` tell the same story.

  - **Stats grew the face the overlay was for.** `layout: 'strip'` is a scrim
    along the bottom of its own box with three compact ring meters on it — CPU,
    GPU, liquid — flat fills, tabular numerals, no gradient. It is the config a
    stats overlay starts with, and the opacity is not a compromise: over a video
    an opaque scrim _reduces_ the area CAM has to compress, because the pixels
    underneath it stop moving.

- **Three of the seven backgrounds could not be reached with a mouse at CAM's
  window.** The rail's BASE chip row is the background picker, and at
  `max-height: 640px` it was a one-line hidden-scrollbar scroller with none of
  the machinery that makes one usable — no measured `data-clipped`, no edge
  fade, and a vertical mouse wheel that left `scrollLeft` at 0. MEASURED at
  866x537 with seven overlays up: a 221 px box over 417 px of chips, so Image
  was sliced at the edge and Shape, Effect and Solid were off-screen, and the
  BASE label beside them opened nothing. The chips WRAP onto two lines there
  now — the padding, the gap and the type give back the pixels — which puts all
  seven on the screen (7 of 7 inside the box, page-fit 0) while the layer list
  still shows four whole rows: 176 px against the 172 that four rows of forty
  need, where the scroller's own number was 202. Both variants were measured
  before choosing. The `BASE` label is a real disclosure as well: it opens
  **+ Add a layer** at its Background row, all seven as tiles, so there is a
  path to every background with no sideways gesture in it. The strip's scroller
  machinery moved to `app/config/editor/scrollEdges.ts` and the chip row uses
  it, so a row that ever IS clipped fades its cut edge and answers a wheel
  instead of simply hiding a control.

- **Selection was carried by an accent colour and nothing else, so a
  high-contrast theme erased it.** Under `forced-colors: active` the user agent
  replaces author colours with the theme's two, and MEASURED at 866x537 the
  selected base chip came out identical to the unselected ones in background,
  text, border and weight — which background is on the panel became
  unanswerable from the screen (WCAG 1.4.1). Selection now says itself in system
  colours — `Highlight`/`HighlightText` for chips, segmented options and tiles,
  a 2 px `Highlight` outline where a fill would hide the thing being chosen (a
  colour swatch, a whole rail row) — and `tap-targets.spec.ts` asserts a
  selected control differs from an unselected one in at least one computed
  property under that emulation.

- **The paste placeholder was cut mid-word at every width the phone rule did not
  cover.** `text-overflow: ellipsis` on `.kh-paste__input` was written inside
  `@media (max-width: 700px)` — the one range where `HomeView` already swaps in
  a shorter placeholder, so the rule could never fire where it was needed. At
  866, 760 and 1280 the field read _"Paste a video link — YouT"_, clipped by the
  property's initial value. Hoisted to file scope, with the computed style
  asserted at four widths.

- **The config page's own frame-rate banner told a Kraken Z to raise a slider
  that has one position.** The display side of this landed in the same round;
  this is the other surface that prints the instruction. `homeState.fpsIsAtPanelMax()`
  compares the reported frame rate with `maxTargetFpsForPanel()` for the panel
  that actually reported, and at the ceiling the banner keeps the reading — 1 FPS
  is still why a video stutters — and swaps the instruction for a claim that says
  so (`CLAIM_FRAME_RATE_AT_MAX`, through the claims registry like every other
  sentence about the panel). An unrecognised panel still gets the advice.

- **Undo and redo were two glyphs with an empty tooltip.** 26x26 icon-only
  buttons with an `aria-label` and `title=""`: a screen reader was told and a
  mouse was not. They carry their words now. The label is the word rather than
  the shortcut, because the keyboard map accepts ⌘Z and Ctrl+Z alike and nothing
  in the build detects which one this machine prints.

- **`sync-remote.spec.ts` asserted a desktop-only card at a 640 px viewport.**
  The test's own preamble says the install card appears "at a DESKTOP width
  only" and `RemoteView` gates it behind `PHONE_QUERY`'s 700 px; the page ran at
  the suite's 640x640 default, so the assertion was failing at HEAD on its own
  terms. It sets 1000x900 first, like its sibling three hundred lines down.

- **`?fit=contain-circle` was documented, implemented everywhere, and rejected
  by the URL parser.** The mode is declared by `RenderSettings`, accepted by
  `validateRenderSettings`, drawn by the compositor, offered by the config panel
  as **Circle**, and introduced by a state migration written for no other
  purpose — but `src/state/urlParams.ts` listed three of the four framing modes,
  so the one mode a ROUND panel actually wants was the one a kiosk link could
  not ask for. It came back as an "ignored or coerced" note in the diagnostics
  readout, which is the app telling the truth about the wrong thing.

- **`?loop=<start>-<end>` is an A-B loop now, not an unparseable boolean.** The
  getting-started URL table has always promised `loop=<start>-<end>` in seconds;
  the parser ran every `loop` value through `parseBoolParam` first, so `12-31.5`
  failed and the range never reached the video module at all. `?loop=` takes
  both spellings now — `1`/`0` still means "loop the whole clip" — and the range
  (two non-negative seconds, `start < end`, decimals allowed, canonicalised so
  `012.50-31` reaches the module as `12.5-31`) becomes `{ enabled: true, start,
end }` through the existing `applyUrlParams` seam. The END is deliberately not
  checked here: nothing on this side of the app knows how long a clip is, and
  the module's own loop rules already clamp an end past the duration at play
  time. An unusable range is refused with a reason rather than silently
  half-applied.

- **`?mute=` now has a row in the URL table**, which it never had, and the
  `loop` row says what it actually accepts.

- **`?pin=1` is gone.** It was a known key assigned to `flags.pin` and read by
  no file in the tree. URL parameters already win: `src/app/display/mount.ts`
  installs the parsed patch as a store OVERLAY, so a parameter keeps beating
  anything the configuration browser writes later, without persisting. A
  documented escape hatch that does nothing is worse than the precedence
  surprise it was meant to mitigate — a reader who followed the advice got an
  "unknown parameter" note and concluded the override had failed. The
  architecture doc's mitigation row says what actually mitigates it (the
  diagnostics readout listing every parameter and every reason).

- **The phone cannot reach the About page, and `docs/remote-control.md` said
  twice that it could.** On a phone every route resolves back to the remote
  (`usePhoneOnly`), so `RemoteView` suppresses the About link — the doc's own
  §"A phone is a remote, on every address" already said so, two hundred lines
  above two paragraphs that told the reader to "follow the **About** link at the
  bottom of the remote" to reach the connection settings and the hardware-report
  pull. Both are rewritten as what is true: those are PC surfaces, reached from
  the CAM configuration browser or a paired desktop browser, and what the phone
  keeps instead — pairing, the ring, the transport, the presence line — is named
  rather than implied.

- **Pinch and two-finger rotate on the phone editor have end-to-end coverage for
  the first time.** `page.touchscreen` has one finger and `page.mouse` has none,
  so nothing in the suite could reach `EditorCanvas`'s second-finger branch and
  the whole of §8's two-finger model shipped unexercised; round 13's audit read
  the resulting silence as a defect. `tests/e2e/remote-editor.spec.ts` now puts
  two real fingers on the glass through the DevTools protocol
  (`Input.dispatchTouchEvent` with a list of touch points, which Chrome expands
  into one `pointerdown` per point), and `touch-taps.spec.ts` asserts that
  harness claim on its own. Measured: two fingers spreading 30 px → 60 px about
  the layer's centre grow a clock overlay's frame by 2.00× and leave `t.s`
  alone — a kind whose `resize` is `'frame'` commits a pinch into `layer.frame`
  by design, which is exactly the "`t.s` stayed 1" the audit reported; a 30°
  twist lands `t.r` on 30, a tick of the same 15° ladder the desktop rotate
  handle uses; the selection survives both, including the realistic sequence
  where the second finger lands 60 ms after the first. No product code changed:
  the gesture model was right and the measurement was not.

- **Trivia, all of it measured rather than remembered:** the architecture doc's
  "~80-line" `src/app/display/dom.ts` is ~110 lines; a square panel's
  `safeInsetPx` is `round(min(w,h) · safeAreaPct)` — 19 px on the 240 px
  Kraken — not the zero the doc claimed; `docs/editor.md` said "100 %";
  `src/state/look/file.ts` counted four ways to refuse a Look file and listed
  five; and `design-ossDx.md`'s corrections table now records that
  `src/platform/fpsAdvisor.test.ts` and the `?fpshint=0` parameter it describes
  have never existed.

### Fixed

- **Changes made in CAM's configuration window stopped reaching the display once
  a phone had joined the room.** Reported as "clicking on stuff on the PC doesn't
  change anything; only my phone changes the live display", and that is exactly
  what happened: the click went green, the LCD held its old module for as long as
  anybody watched, and the setting was quietly rewritten back to what it had been
  a second or two later. It needed all three windows to show up — a display, a
  phone with its Remote tab open, and CAM's configuration browser on its Home
  screen — which is why every existing test passed.

  Two things met. CAM's configuration browser never joined the room from Home:
  the sync layer was started by the About, Library and Remote screens only, and
  Home — where the module chips, the looks, the editor and every setting live —
  started none, so a person editing there sent nothing to the room and reached
  the LCD only by writing the browser profile's shared settings document. And on
  the display, the first snapshot from ANY peer — a phone merely opening its
  Remote tab was enough — created an entry for every setting there is, including
  settings nobody had touched, and those empty entries then covered the shared
  document completely. From that moment the display could not see CAM's writes at
  all, and its own routine two-second save wrote the covered version back over
  them, which is why the configuration window looked dead too. The phone kept
  working throughout, because a phone's changes travel as timestamped messages
  the display compares and accepts, while CAM's travelled as a document nothing
  compared.

  The editor showed the same fault with a second turn of the screw, because
  every add is built on the look the editing window is holding and the editing
  window reads that look back out of the same document: add a Clock overlay, add
  a Text overlay a second and a half later, add a Date overlay after that, and
  each one REPLACED the last — the layer list emptying about 1.2 seconds after
  every add, and three overlays ending as one.

  Both halves are closed. `ConfigApp` now starts the sync layer at the app root,
  so a paired CAM publishes from Home like every other screen (About, Library and
  Remote still own the one connection when they are on screen — there is never a
  second). And the display now treats the shared document as a real write
  channel: a change made by the other browser on the machine is stamped and
  published like any other decision, so an UNPAIRED CAM — the shipped default —
  reaches both the LCD and the phone. It is narrow on purpose: only the display
  adopts, only what the write actually changed, never a page's own write coming
  back at it, never the routine save a page makes to write down what the room
  told it (`AppState.writerOrigin` is new and says which is which), and never
  from a browser the display already hears state from, so a paired CAM's own
  messages still carry its changes and still carry its clock. The display's own
  routine save also waits for that decision rather than landing on top of it,
  which is what makes a run of edits in the editor accumulate.

- **Phone editing dead-ended on Effect / Preset / Colours.** Every strip control
  declared `control: 'action'` except source, loop and quality was mapped, on the
  phone, to an escape called `more` — and `more` closed the editor and opened
  nothing. On the effect module, which is the background half the shipped
  templates use, that is three of its four controls; the icon picker was the
  fourth casualty. No `InspectorSheet` and no module `ConfigPanel` was mounted on
  a phone at all, so the twelve-tile effect catalogue, the preset chips and the
  colour wells were genuinely unreachable there. The only way to them was to
  drag the browser window past 700 px, which swapped the phone app for CAM's —
  and CAM's editor was deriving its touch behaviour from the _width_ breakpoint,
  so the workaround handed a thumb 24 px handles, no pinch, no two-finger
  rotate, no long press and 28–39 px strip buttons.

  Five changes, and none of them relaxes the phone's bytes rule (a preset is a
  number in the synced document; a colour is a hex string — neither is a file):

  - The phone mounts the **same `InspectorSheet`** as a bottom sheet — Layout's
    five numerics through the same pure ops, the kind's own `ConfigPanel`
    through the same lazy loader, Visibility, Advanced — registered as the
    `inspect` stage so the 44 px and page-fit sweeps measure it. Every action
    control opens it with the desktop's own reveal mechanism (section + nonce),
    so **Preset** opens _at_ the panel rather than at the top.
  - **Loop** and **Quality** no longer evaporate: `RemoteView` scrolls the A-B
    scrubber or the quality ladder onto the screen after the editor closes, the
    way **Source** has always focused the paste field.
  - The remote's **Showing** row is `baseOptions()` from `basePicker.ts` — six
    base-capable kinds plus Solid colour, the same seven the add sheet's
    Background row and CAM's chip row offer. It was `listModules()`: nine
    options including Text, Icon and Date, whose manifests declare
    `roles: ['overlay']` and cannot be a background at all, and no Solid.
  - **Looks on the phone**: templates, the project's gallery, and _Your Looks_ —
    apply, **Save a copy…** with a name field, rename, favourite, delete. All
    document operations against this device's own namespaced storage, and the
    sheet says _"Saved on this phone"_ rather than implying the PC's shelf.
    Import, export, the gallery download and the media library stay off the
    phone; the carousel is reported there and driven by the window that owns the
    looks store.
  - **Touch is a pointer fact now, not a width fact.** `useCoarsePointer()`
    (`(pointer: coarse)`) feeds `coarsePointer`/`touch` on the desktop canvas
    and the 44 px strip-button floor keys on it as well as on the width, so a
    tablet at 800×1180 and a phone-landscape window at 780 px get 44 px handles,
    pinch, two-finger rotate and the long-press sheet — which is now one shared
    `LayerContextSheet` rather than a copy per surface.

- **Five things the closing audit measured, all of which were invisible to the
  test suite because they were about pixels, contrast or the passage of time.**

  - **The text-first stats face had no meter at all.** `--kh-stats-dial`
    computed to `0px` on `layout: 'grid'`, so its six `<svg>`s were 0 × 0 — and
    the renderer went on writing a fresh `stroke-dasharray` into every one of
    them, forty-two times a minute, to elements with no box. Six numbers with no
    mark is a table, and the module's whole threshold contract needs a mark for
    a colour to live on. The face's dial is sized against a TILE rather than
    against the layout box (98 px on a 640 Elite, 49 px on a 240 Kraken 2023,
    was 0 px on both), and the reading now sits inside a thin accent arc with
    the label under it and the state chip in the arc's own bottom gap. **And the
    strip face's reading is genuinely centred on its ring now:** the stylesheet
    claimed an absolutely-positioned grid child lays out inside its grid area,
    Chromium resolved the readout's containing block as the whole tile
    (`top: 49.05px` + `bottom: 49.06px`, summing to the tile's height) and the
    number sat 12.16 px low on every panel — so the ring and its reading are one
    `position: relative` box, and the offset measures 0.00 px at 640, 320 and
    240 with no magic constant to keep in step.
  - **The date layer overflowed both round panels.** Its shrink-to-fit compared
    the line's scroll width — glyphs PLUS the layer's safe inset as padding —
    against the host's width, which cannot converge, because the padding does
    not shrink when the type does: `Wed, Sep 2` came out 673.9 px wide inside a
    640 px panel and 337.2 px inside a 320 px one. Both measurements are taken
    inside the inset now (639.2 px and 317.3 px), which is also what puts the
    glyphs inside a circle's chord rather than inside the corners of a bounding
    box a circle does not have. The e2e suite asserts it at every preset with
    the longest weekday and the longest month en-US has, at the schema's largest
    size, in the heaviest weight, uppercased.
  - **The effect picker showed two of twelve effects.** Inside the inspector
    rail the card strip is 203 px of client width against 1192 px of scroll
    width, with no scrollbar drawn and nothing to say the other ten existed — at
    a 1280 px window as much as at 866 px, because the rail's width does not come
    from the viewport. The cards are a two-column grid now, all twelve in the
    sheet's own vertical scroll; the horizontal scroller survives behind a
    CONTAINER query for a control that is genuinely 560 px wide. Roving focus and
    the arrow keys are unchanged.
  - **The simulator could not reach a single one of the stats module's
    thresholds.** Its load walk asymptoted at about 71 °C against a default warm
    point of 80 °C, and the GPU's curve topped out at 78 °C, so every threshold,
    every state chip and the whole colour-never-travels-alone contract was dead
    code on the only data anybody develops against — including the editor's
    sample halo, which shares the generator. A machine does not random-walk: it
    idles, something runs, it gets hot, it cools. Every 40–90 s the load ramps to
    a burst peak for 15–25 s (84–88 °C CPU, 82–86 °C GPU) and comes back, and a
    seed makes the whole walk reproducible so "crosses 80 °C within 180 s and
    returns" is a test rather than a hope.
  - **The diagnostics' frame counter was printed over the reading it was there
    to time.** `pattern=stack` puts a stats overlay at `y = 0.6` and the counter
    at the bottom CENTRE, so on a 640 Elite its box (251.8–388.2 × 413.3–519.0)
    landed on the hero at ~(320, 490). It sits in the bottom-left corner band
    now, derived from the same safe inset every layer is, where the panel's
    centre is unreachable by construction. In the same stacks the overlay's
    near-white readings measured **1.1:1** against the plasma base underneath
    them: the scrim used to belong to the `strip` face, and it belongs to the
    type — the readout, label, sub-line and chip each sit on a flat opaque plate
    that is invisible over the black stage and measures **18.9:1** for the hero
    and **5.0:1** for the smallest type over the brightest pixel a base can
    produce.

- **A setting changed on the phone went green and came back half a second
  later — the settings-revert class, ended by replacing the merge rather than
  patching it again.**

  Three designs were tried. Ordering by ARRIVAL lost every edit a stale snapshot
  landed on top of: each peer publishes a full snapshot through a 200 ms
  throttle, and in a three-window room there is nearly always one in flight that
  was taken before whatever you are about to tap. Ordering by the Lamport `rev`
  in the storage document compared two counters that had never met — CAM shares
  a document with a display persisting twice a second, so its counter ran far
  ahead of a phone's for reasons that had nothing to do with who decided what.
  Ordering by an ACKNOWLEDGEMENT map — "may this frame overrule my edit? only if
  it has seen my edit" — was correct about causality, and that turned out to be
  the problem: **causal order is not a total order.** Two people touching the
  same setting at the same moment have seen nothing of each other by definition,
  so the rule had nothing to say about them, and each patch for that reopened
  something else. Four independent reproductions, each deterministic:

  - a frame this page overruled still contributed the sender's `seen` map
    wholesale, so a peer back from a blip advertised a value its own body
    contradicted and a third window dropped a fresh commit (5/5 runs);
  - two live peers writing one leaf **deadlocked permanently** — `acknowledgesUs`
    was measured against this page's latest publish, which moves on every store
    notification, so between two peers that both republish on every change it
    could never become true. `SPLIT phone=clock CAM=stats display=clock`, stable
    at +15 s and +30 s, ~240 frames exchanged, both maps frozen;
  - the same deadlock at tap gaps of 0, 60, 150 and 300 ms, 4/4 red on three
    independent runs, and in the physical lock/unlock script;
  - in the room the product ships in most — one display, one phone, CAM's window
    NOT open — a refusal was **terminal**: the display never publishes state, so
    a refused frame generated no answer, no second chance and no recovery. A
    reloaded phone's first tap was lost for good, not for a timeout.

  **What ships is per-leaf last-writer-wins ordered by a hybrid logical clock**
  (Kulkarni et al., 2014), which is a total order that AGREES with causality
  wherever causality has an opinion.

  - A **leaf** is a merge unit, and there is now exactly ONE function that says
    what one is (`src/sync/leaves.ts`, pinned by a test): every top-level key,
    `render` per key, `modules.<kind>.cfg` per key, `playback` whole (a position
    and its timestamp are only meaningful together), one leaf per LAYER of the
    look and one for the z-order, and `activeModuleId` and `look.layers[0].kind`
    as the SAME leaf, so the field mirrored for schema-8 compatibility can never
    disagree with the layer it mirrors.
  - A **stamp** is `{t: physical ms, c: counter, s: writer}`. A local write takes
    `t = max(now, the latest stamp this page has seen)`; a receive folds the
    frame's stamps and the sender's clock into it. Merging keeps the greater
    stamp per leaf.
  - That merge is **commutative, associative and idempotent**, so convergence is
    a theorem rather than a hope, and it is one every special case can be deleted
    against: a retained replay, a keepalive republish, a failover redelivery and
    an out-of-order frame are all no-ops on their own merits. The proof sketch is
    in `src/sync/merge.ts` and the three laws are asserted over 40 random
    register sets in `mergeLaws.test.ts`.
  - The page's clock and its **whole register table** are persisted in one slot
    (`kraken-hub:v1:sync-clock:<role>`, slot version **2**, missing = epoch), so
    a reload keeps its ordering and its authored leaves keep their stamps.
  - A page that has heard NOTHING yet holds its writes as **intents** and
    re-stamps them against the first inbound frame's clock — the newcomer whose
    device clock is behind the room's would otherwise write into the past.

  **Deleted, not deprecated:** `Envelope.seen`, `Envelope.orig`, `StateReceipt`
  and the three-way applied/overruled/refused protocol, `dominates()`,
  `acknowledgesUs`, `retireSettled`, `pruneConverged`, `applyCausally`,
  `inheritSeen`, `STAMP_TTL_MS` and its liveness scan, and the per-peer `rev`
  floor that dropped the retained bootstrap on **every** reload. The `local`
  precedence layer is gone too: it existed to defend an unacknowledged edit, and
  a stamped write needs no defending — `defaults < persisted < merged < url`.
  The store's API is untouched and no app file moved.

  **Protocol `v` moved to 2.** A `v: 1` peer sends no stamps, so its writes would
  read as older than time and be silently dropped; a mixed-build room refuses
  outright instead, which is a fault somebody investigates rather than a setting
  that quietly stops taking.

  **The look now travels** (§6.1): `SyncStateBody` carries `look` plus the
  derived `activeModuleId`, an older body projects through `baseLook`, and the
  trim ladder (§6.2) is the module bank down to the base kind (`partial: true`,
  taking the stamps of the leaves it dropped with it) → a rotating slice of the
  remaining stamps → refuse and log. **`look.layers` is never
  truncated or stripped** — a look with a layer missing is not a smaller look, it
  is a different arrangement. `lookWireBudget.test.ts` builds the worst legal
  document (8 layers with full configs, a four-kind bank, a full stamp map) and
  asserts it fits one 8 kB envelope with every layer intact.

  **Clock skew, stated honestly** in `docs/remote-control.md`: sequential edits
  always win regardless of skew, because a page stamps in ROOM time — the latest
  wall-clock reading it has heard from anybody, folded by `max`, clamped to a
  day, never negative, and kept across a reload — on top of the wall-clock floor
  `t = max(now, seen)`. Only edits concurrent _within the residual skew_ of two
  devices that have heard nothing of each other are decided by whichever clock
  reads later, and they are decided identically on every screen, so nothing is
  ever left split.

  **Then four skeptics attacked it, and the core held: no split-brain, no clock
  runaway, 16/16 concurrent-write schedules converged, stamps survived every
  reload. Every refutation was at the EDGES. Three seams were sealed in the
  first round and four more in a second, each with the skeptic's own schedule as
  a permanent test — 254 tests in `src/sync` now, from 211.**

  - **A stamp and the value it described were written by two different acts.**
    Stamps went into the clock slot on every commit and on `stop()`; values went
    into the state document only through the 2 s-throttled `persistNow()`, which
    `sync.persistRemote: false` switches off entirely. A page that closed inside
    that gap restored the ROOM'S NEWEST STAMP against a SUPERSEDED VALUE — and
    because the two then tied on stamp, the tie-break written for two leaves
    NOBODY has stamped settled a real argument by JSON string order. Half the
    time the stale value won, on every peer, forever: measured as a display
    showing 90° while the phone showed 270° for as long as anyone watched, and
    as a three-peer room reverting the author's own edit through a THIRD peer's
    reload. **The slot is now a self-contained register table** — `{stamp,
value}` per leaf, slot version 2, a v1 slot discarded rather than mis-paired
    — the document is consulted only for whether the leaf still exists,
    `stop()` flushes values before stamps, and the slot is written whether or
    not `persistRemote` is on (that flag governs whether REMOTE state is
    authoritative on a cold boot, never whether a page may remember what it
    decided). **And the tie-break is guarded**: `canonical(value)` applies only
    when BOTH stamps are `EPOCH`; a real stamp against two different values is
    corruption evidence, so the INCOMING register wins and a mispaired page
    relearns the room from the next frame instead of defending a lie forever.
    Eight cases in `persistSeam.dom.test.ts`, every one in both value orders,
    because the defect was invisible in one of them.
  - **A value could travel without its stamp, and a stampless value is not less
    information — it is a positive claim of `EPOCH`.** `wireStamps()` shipped the
    newest 32 stamps and the whole body, so a leaf buried under 33 fresher edits
    went out bare and could never climb back: a peer that was not listening when
    the stamp was fresh never converged. Measured: a phone locked while CAM
    picked a module and then tuned 34 settings still showed the old module after
    thirty seconds of continuous republishing by both sides. **The fixed wire cap
    is deleted.** `fitStateEnvelope`'s byte ladder is the only trimmer, measured
    against the real 8 kB budget, and its new last rung ROTATES the stamp window
    so every stamped leaf travels with its stamp within a bounded number of
    frames. (That parenthesis used to read "in practice the rung never fires,
    because the worst legal document plus its whole stamp map is inside the
    cap". The worst legal DOCUMENT does fit; a user tuning settings on top of a
    full look is not sending the worst legal document, and round 6 measured the
    rung firing on 96–101 % of frames. See round 6 below.) A hard
    count survives only in the localStorage slot, where a dropped register costs
    ordering after a reload and misleads nobody. `wireStamps.dom.test.ts` and the
    rotation bound in `lookWireBudget.test.ts`.
  - **…and then the ladder's own first rung turned out to be the same lie.** It
    dropped the stamps of every leaf whose value equalled the built-in default,
    while shipping those values anyway, on the argument that "a receiver that
    does not get one keeps what it already holds, which for a defaulted leaf is
    the same value". The premise is false in exactly the case that matters: the
    receiver is not holding the default, it is holding the value the ROOM agreed
    on, and the unstamped default reads as `EPOCH` and loses to it forever.
    Setting anything BACK to its default — `render.fit` to `cover`, "undo my
    crop" — was unsendable the moment a frame crossed 8 kB, on every frame,
    permanently; unlike the rotating rung, nothing repaired it. Measured: CAM
    tunes 150 knobs and commits `contain`, the room agrees, the phone commits
    `cover` 1.5 s later, and eleven seconds and ~700 frames on the room still
    holds two values, stably. **The rung is deleted**, and with it `defaultish`
    and the default-leaf enumeration that existed only to feed it. The ladder
    now has exactly one stamp-dropping rung and it rotates.
  - **A stamp could travel without the value it described — the converse, which
    had no owner.** The body comes from the store and the stamps come from the
    register table, and the restore was allowed to pull them apart: it kept a
    slot register only when the persisted DOCUMENT still named the leaf, and
    `look.order` is in every document while `look.layer.<id>` for a layer the
    document has not learned yet is not. So a reload restored the ORDER of a
    two-layer look without the layer, published a one-layer body under the
    two-layer order's stamp, and every receiver saw the same stamp against a
    different value — which the merge treats as corruption and resolves by
    preferring the incoming one, so the two sides swapped the overlay on and off
    forever. Measured with `sync.persistRemote: false`, and again on default
    settings with a quota-refused document write: an overlay blinking on the
    actual LCD, no clock skew, no blip, no reorder. **The document gate is
    gone** — since slot v2 the register carries its own value, so the document
    has nothing to contribute — **and `wireStamps()` states the converse
    invariant directly**: a stamp travels only for a leaf whose value in the
    outgoing body is the value that stamp describes, and `fitStateEnvelope`'s
    bank trim drops the stamps of the leaves it drops. Either fix alone closes
    the trace; both are in, because the invariant is the one that closes the
    class. `layerSeam.dom.test.ts`, plus the eight damaged-slot cases from the
    same skeptic kept as pins.
  - **Room time was folded only from `state` frames, in a room where nobody
    publishes state.** A display applies state and never publishes it, and a peer
    never applies its own echo — so a phone alone with a display receives no
    state frame in its entire session, and ended it having learned nothing about
    the room's clock. Worse, "has heard the room" was inferred from "has a
    persisted HLC", which are different questions and come apart in exactly that
    room: the reload then disarmed the intent layer for a page that genuinely
    knew nothing, and its first tap was stamped 90 s in its own past and lost for
    good. **Every inbound envelope now folds room time** — `tele` and `cmd` as
    well as `state`, so a display's telemetry teaches the room's clock without
    making the display a state publisher — **and `heard` is a persisted fact**
    in the clock slot, read as false when absent (the conservative direction,
    which is why the slot version did not have to move and discard every
    existing register). Same seam, third clause: **`SyncService.stop()` now
    flushes a snapshot held in the publish throttle** before the transports
    close, because a tap and then a lock is how a phone is used and in a
    display-only room there is nobody to ask for it afterwards. Measured at
    `display=90` after the user left the room on 180. `displayOnlyClock.dom.test.ts`.
  - **A backward clock step wedged the publisher for the length of the step.**
    Both throttles computed `elapsed = Date.now() - lastRunAt`; after a step back
    that is negative, so the immediate branch was skipped AND the trailing flush
    was scheduled `|step|` into the future, behind a guard that swallowed every
    request until it fired. An NTP correction, a fixed timezone or a Kraken with
    no RTC reaching a time server was enough. Measured: one state frame in the
    ten seconds after a one-hour step, thirty seconds of two values held with no
    outage, no error and no status change — the room split in two in silence, and
    the silence scaled linearly with the size of the step. **Both throttles are
    on a monotonic clock now** (`src/lib/monotonic.ts`), with a negative elapsed
    read as "the clock moved, publish now" and the timer delay clamped to one
    throttle period. **And room time is projected on the same monotonic clock**:
    the stamping base is the highest room-time reading this page has taken plus
    the monotonic time since it took it, so a device that steps back does not
    write into its own past — freezing the base is NOT enough, because a phone
    that steps back and then locks its screen for six seconds needs the six
    seconds counted. `clockSkew.dom.test.ts` counts frames on the wire after
    steps of 1 s / 10 s / 1 h and pins the sequential and contended scripts.
  - **`MAX_ROOM_OFFSET_MS` was a cliff, and is a bound.** A reading more than a
    day out used to be discarded whole, which does not remove the peer from the
    room — its own stamps still ride on every frame — it only stops everybody
    else tracking it. It is clamped to a day instead. The honest limits are now
    written down in `docs/remote-control.md` rather than implied: a CONNECTED
    room converges on whoever tapped last whatever any clock says (the HLC floor
    already does that, measured with a peer three days fast, in both directions);
    a device coming back from an outage is covered up to the clamp; past that a
    wrong-clock peer wins those ties until its clock is corrected, and there is
    no fix for that without a consensus round. **No receive-side stamp cap was
    added**, deliberately: no schedule discriminated one, and any cap computed
    from the receiver's own clock gives two receivers two different stamps for
    one write, which is the property the merge's convergence rests on.
  - **The wall-clock floor said nothing about writes a device never heard.** `t =
max(now, seen.t)` is exactly right for a peer that stayed connected, and
    every write made during an outage is one the offline device has not seen — so
    a phone whose clock was behind by more than the length of the gap stamped its
    first tap back in the past and lost it. The tap went green and came back,
    which is the original bug report verbatim: measured fine at 3 s behind, lost
    at 10 s and at 90 s, on a 6.5 s screen lock. **A page now keeps a room-clock
    offset** beside its HLC, folded by `max` over the clock readings on inbound
    frames (the sender's `ts` as well as its HLC `t`, because a room whose only
    writer is the slow device advertises nothing else), clamped to a day, never
    negative,
    and persisted in the v2 slot. `clockSkew.dom.test.ts` gives every device its
    own wall clock and pins the S2-contended script at 0, −10 s, −90 s and +40 s,
    all six ordered sequential pairs, a seven-tap chain, an hour-long clock jump
    and a reload made while 90 s behind.

  The 2.5 s optimistic hold on the shelf (`RECONCILE_GRACE_MS`) is unrelated to
  the merge and stays: curation rides `cmd`/`tele`, which carry no state at all.

  **Round 6 — the two channels the room-clock work never reached, the frame
  budget's own delay, and one residue that is stated rather than fixed.**

  - **`cmd` and `tele` were still on raw wall clocks, and `cmd` carries every
    control there is.** The staleness gate subtracted two of them — `Date.now()
    - env.ts > 15 s`— so a phone more than fifteen seconds BEHIND had every
command it ever sent dropped on arrival: play, pause, seek, setModule,
requestLibrary, the lot. One-directional, with a clean cliff at exactly the
bound (measured: 0 s → 3 of 3 heard, +90 s → 3, −14 s → 3, −16 s → 0, −90 s
→ 0), and nothing in the room ever corrects it, so in a display-only room`useSync`'s cold library pull retried forever into the void and the shelf
stayed blank for the life of the device, across every reload, with the
status line reading online. Separately, `sendCmd`'s per-op throttle and
`publishTele`'s were `Date.now() - lastAt`seeded`0`— the arithmetic`publishState`had already been repaired for — so one backward NTP hour
silenced both for the hour (measured: one play landed, then four taps
produced nothing). **Both ends now compare ROOM time**:`appSync`'s
`roomNow()`is passed to the service, writes the`ts`on every outbound
envelope and answers the age gate, so a peer that has heard one frame from
anybody — telemetry included — is corrected before its first command, and a
peer that has heard nothing is no worse off than before. Both throttles
moved onto`monotonicNow()`, seeded `-Infinity`. `cmdChannelSkew.dom.test.ts`;
      the harness's telemetry beats now read the device clock at fire time, which
      is what made the display-side clock step measurable at all.
  - **The rotating stamp window took twelve seconds to carry the tap somebody
    had just made.** Under a full look plus 300 tuned knobs — 336 leaves, 29
    stamps to a frame — the newest stamp rode on one frame in seven, and a
    DISPLAY is a passive peer, so there is no ping-pong to make the writer emit
    faster than its ~2 s persist tick. Measured, with no race, no reorder, no
    skew and one writer: a rejoining display learned a plain sequential edit
    after **10.2 s**. The scaling law sat just above the documented ceiling —
    150 knobs → 26 ms, 200 → 176 ms, 250 → 4.2 s, 300 → 10–12 s — which is why
    nothing shipped had seen it. **The newest eight stamps now travel on EVERY
    frame** (`RESERVED_NEWEST_STAMPS`) and the remaining budget rotates over the
    rest, so the leaf a receiver most urgently needs to order arrives on the
    next frame while a buried leaf still climbs back within
    `ceil((n − r) / k)`. `lookWireBudget.test.ts` pins both halves — the newest
    stamp on every frame, and a real rotation bound instead of `frames < 300` —
    and `newestStampReserve.dom.test.ts` runs the room-level schedules. And a
    frame the ladder REFUSES (500 knobs on the active module make the bare
    envelope 8767 B, which no rung can shrink) is no longer silent: it says
    _"Too much to send — this arrangement no longer fits on the wire"_ on
    `SyncStatus.lastError`, which the connection panel already renders.
  - **A badly-wrong clock costs more than the docs claimed, and two of the
    three residues have no fix at this layer.** The shipped claim — "the room
    converges on whoever tapped last whatever any clock says" — is true of a
    CONNECTED room and only of one; the test that measured it never muted
    anybody. Add a 6.5 s outage and: a peer more than a day SLOW loses its
    first tap back every time (at 23 h it lands, so the boundary is exactly
    `MAX_ROOM_OFFSET_MS`); and one far-future stamp pins every peer's ordering
    clock at its own reading until real time catches up, during which the total
    order degrades to a per-peer counter and then to the writer's client id in
    string order — measured, the later tap lost to alphabetical order, with the
    bad peer's process, slot and clock all gone from the room, and neither
    correcting the clock nor reloading the page unsticking it. Both proposed
    caps were tried and both are worse: capping the LOCAL floor splits the room
    (with it, the shipped "does not let a peer three days fast own every
    setting" test reads `90` everywhere where it wants `180`), and capping the
    incoming REGISTER stamps costs the merge its "one write, one stamp,
    everywhere" property. So the residue is **stated** — `docs/remote-control.md`
    rewritten to say exactly what is lost and that the mitigation is to set the
    device's clock — and pinned by `hlcFloorPin.dom.test.ts`, which asserts what
    the code does rather than what one would like it to.

  **Round 7 — the cliff that only moved, the slot cap that reverted a user's own
  edit, and the torn read at the root of both.**

  - **Room time did not close the command cliff; it moved it to 24 hours.** Two
    peers' `roomNow()` readings agree only when the sender has folded at least
    one frame AND its skew fits `MAX_ROOM_OFFSET_MS` — `noteRoomTime` clamps at
    24 h by design, so a device further out keeps a residual error and a gate of
    fifteen seconds cannot survive it. Measured, with the room settled and
    online: −23 h → 3 of 3 commands heard, −24 h → 3, **−24 h 20 s → 0, −25 h →
    0, −3 d → 0**, +3 d → 3 (still one-directional, because the subtraction is
    signed). Permanent, too: reload → 0 of 2, a 2.5 s radio drop and back → 0 of
    1. Two more shapes fell out of the same subtraction — a phone that taps
       BEFORE its first inbound frame loses that command at −16 s or worse (`cmd`
       has no equivalent of the state channel's intent layer, and cannot have one),
       and a phone with a PERFECT clock loses its first command after a peer three
       days fast has joined, written and LEFT, because the poison is the receiver's
       own persisted `roomOffset` (measured: honest visitor 2 of 2, after the liar 1
       of 2). **The gate is now self-referential per sender**: the first command
       from an unseen `src` is accepted unconditionally, and afterwards a frame is
       dropped only when it lags the newest `ts` THAT SAME SENDER has delivered —
       one device's clock against itself, skew-free by construction. Redelivery was
       never this gate's job: `(src, seq)` dedup does that, and no shipped transport
       replays `cmd` at all (ntfy's recovery poll asks for `state` alone, `since=10m`;
       its live `/sse` carries no `since=`). `types.ts` says so now, where it used
       to claim the opposite. `cmdChannelSkew.dom.test.ts` gains the offsets past
       the clamp, the tap-before-first-frame schedule, the departed-liar case, both
       recovery paths at −25 h, and a stale-replay pin so the widening cannot
       quietly become "accept everything"; the shipped unit test that asserted the
       old contract was rewritten against the new one and its untrue justifying
       comment removed.
  - **The clock slot's cap evicted the one register the room had not heard.**
    `saveClock` packed newest-first under `MAX_SLOT_REGISTERS = 32`, and
    `types.ts` claimed a dropped register "costs ordering after a reload and
    nothing more". It costs the user their edit. A phone offline taps
    `render.fit=contain` — the one leaf the room already holds a register for —
    then turns N other knobs and reloads: at **N = 30 the fit survives; at N = 31
    and N = 35 it is gone**, the room's stale `cover` wins on every screen, and
    the other 31 offline edits all land, because the room holds no register to
    argue with them. No notice, no `lastError`, no way to tell which edit was
    undone. The boundary is exactly the cap, and 33 stamped registers is not a
    stress figure — a settled room measures 21 after twenty ordinary config
    writes. **A cap may now only evict a register the room already holds**:
    `appSync` tracks an `unshipped` set (added on local commit, cleared when
    `SyncService` reports the frame carrying that path's stamp actually went out
    on the room's transport, online) and `saveClock` packs it in a first pass
    under its own safety bound, the rest newest-first after it — the slot-side
    twin of `RESERVED_NEWEST_STAMPS`. Two smaller repairs rode along: the byte
    rung `continue`s instead of `break`ing, so one oversized register no longer
    discards every older one behind it (measured before: a 200 kB config value
    wiped the whole slot), and a register whose leaf the document no longer has
    is dropped on commit, so a deleted module-config key stops holding a capped
    slot forever. `slotCapUnshipped.dom.test.ts`.
  - **The first frame of every local commit claimed the value had never been
    written.** `store.commit` fires the storage bus synchronously, so the page's
    own write came back through `watchState`, re-resolved the snapshot and
    NOTIFIED — all before the commit listeners, where the sync layer stamps, had
    run. The config page publishes on every notification, so the order on a plain
    tap was `value published → stamp assigned → value republished`, and a missing
    stamp is not less information: it reads as `EPOCH`, the strongest possible
    claim that nobody has ever written that leaf. Convergence survived because
    the next frame was stamped, which is why no reading ever disagreed — but it
    is the same torn read that produced the phone's undo bug, which
    `lookHistoryStore` had worked around with a microtask flush. **Fixed at the
    root**: a per-store re-entrancy guard in `src/state/store.ts` suppresses the
    notification a commit provokes through its own storage write, so a commit
    runs its listeners and notifies ONCE, stamped. The snapshot re-resolution the
    store's comment protects is untouched, and the guard is per store, so the
    display's watcher still fires for CAM's commits. `lookHistoryStore`'s
    coalescing stays and says why in its own doc — it still guards `replace()`
    and the `setResolve` path, which raise several notifications in one turn.
    `storeSeam.dom.test.ts` measures both sides: the wire (no value ever ships
    ahead of its stamp) and the store (one notification per commit, the other
    window still notified, the re-resolution intact).

  Regression cover: all four reproductions are permanent tests and every one of
  them is red on the previous build. `twoPeerDisplayOnly.dom.test.ts` is a new
  suite for the room with no CAM in it (a reload then a tap 1.8 s later; two
  phones, one muted, tapping concurrently and rejoining after 6.5 s; a tap held
  against the retained bootstrap; a reloaded phone moving its own previous
  session's key). `threePeerConvergence.dom.test.ts` gains the laundering
  schedule, same-key contests at 0/60/150/300 ms between CAM and a phone and
  between two phones, the lock/unlock contended case, and three seeded schedules
  on a wire that reorders (alternating 320/40 ms), duplicates and replays. The
  contested cases assert one value everywhere, that it is one somebody actually
  chose, and that it is the LATER tap whenever the gap is at least 150 ms; the
  reorder seeds settle in **3 s rather than 9**, because there is no liveness
  timeout left to wait out. The harness the three suites share now lives in
  `src/sync/roomHarness.ts` — every skeptic had pasted their own copy of it, and
  each copy modelled a slightly different room.

  **Round 8 — four narrow seams, each one a place where a rule was true for
  exactly one page load, one frame, or one sender.**

  - **Shippedness did not survive a reload, so the second one evicted the edit.**
    Round 7's slot rule — a cap may only evict a register the ROOM already holds
    — rests on `appSync`'s `unshipped` set, and that set lived only in memory.
    So a page load that never reached the room restored the registers, started
    with an EMPTY unshipped set, and re-packed the slot as if everything had
    shipped; `stop()` alone is enough to trigger it. A phone edits offline and
    reloads twice without a round trip to the room — a lift, a locked screen, a
    tab the browser discarded and restored. Measured, as registers before /
    after reload #1 / after reload #2: **N = 20 → 22/22/22 and the edit
    survives; N = 31 → 33/33/32, N = 35 → 37/37/32, N = 60 → 62/62/32 and it is
    gone**, `fit` reverting to the room's stale value on every screen in both
    value orders. The boundary is exactly `MAX_SLOT_REGISTERS`, and the
    gap-filling knobs all land as before, which is what makes the loss invisible.
    **`StoredClock.unshipped` now writes the set down** beside the registers,
    `readStoredClock` reads it defensively, `startAppSync` seeds the live set
    from it intersected with what actually restored, and a MISSING key reads as
    "every restored register is unshipped" — the conservative direction, the
    same argument `heard` makes, and why the slot version did not have to move.
    `persistShippedness.dom.test.ts`, including the older-build slot with no such
    key at all.
  - **The command gate accepted a first sighting at any age.** Round 7 made the
    gate self-referential per sender, which closed every skew cliff and left one
    word open: FIRST. `clientId()` is minted fresh on every page load, so a
    display that reboots — or rebuilds its `EventSource` after
    `NTFY_LIVENESS_MS` — meets every peer as a stranger, and every command in a
    broker's replay cache is a first sighting. Measured on a cold display, one
    hand-built `seekBy(+10)` per row, fresh `seq` so dedup has nothing to say:
    **20 s old → executed, 6 h old → executed, 3 days old → executed**, and a
    frame flagged `retained` executed too, though `CmdOp` has said since it was
    written that a command is NEVER retained. The safety argument was prose, and
    the capability model contradicted it: `TransportCaps.replayMs` was
    transport-WIDE, ntfy declared 600 000 ms, and `NtfyTransport`'s own comment
    still promised a defence round 7 had removed. **Three gates now, none of
    which subtracts one device's clock from another's**: a retained-flagged cmd
    frame is refused outright; a frame more than `CMD_MAX_AGE_MS` behind the
    newest BROKER stamp that link has delivered is refused (`FrameMeta.ts` was
    decoded and thrown away — it is server time against server time, one clock
    against itself, and it is the only reading a receiver with no history of the
    sender has); and round 7's per-sender gate stays, because it is the only one
    that can catch a peer re-sending out of its own past, whose frame is FRESH at
    the broker. The high-water is fed by `state` and `tele` and never by `cmd`, so
    a command cannot vouch for itself. **`TransportCaps.cmdReplayMs`** makes the
    claim a capability rather than a sentence: zero on all four transports, each
    with the reason it earns that written beside it, and the ntfy comment
    corrected. `cmdReplayGate.dom.test.ts`, with the fresh-command control that
    says the gate measures age and not strangeness, and a three-days-fast phone
    that reloads with a corrected clock and is still heard.
  - **The wire reserve answered the wrong question.** `RESERVED_NEWEST_STAMPS`
    reserves the newest eight stamps on every frame, which asks "was this the
    last thing touched?" — and one ordinary multi-leaf config commit issues a
    stamp per leaf, so tapping FIRST and tuning the module's settings after (the
    order a person actually works in) pushes the tap out of the newest eight
    before the next frame goes out. The suite's own DECISIVE schedule with its
    two acts swapped: **150 knobs → the returning display learns after 2.1 s,
    300 knobs → 20.2 s, 400 knobs → 96.2 s**, one writer, no race, no reorder, no
    skew. **`wireStamps` now hands the unshipped paths over with the map** and
    `fitStateEnvelope`'s rotating rung takes them first — the wire twin of
    `saveClock`'s two passes, and the invariant is the same in both places: a
    budget may only drop a stamp the room already holds. Two details the
    measurement forced: the newest few of the unshipped head are reserved rather
    than rotated (a cursor walking a list that loses an entry per shipped stamp
    does not stay pointed at anything — the tap's own stamp missed eleven
    consecutive frames), and the reserve for what the room HAS heard is taken
    before the unshipped head is allowed to rotate (~600 bytes of 8192 for both
    reserves, and a tap that shipped on the frame right after it was made queued
    behind 300 fresh knobs and arrived 20 s late). If the unshipped head alone
    does not fit, it rotates within itself and the page raises
    `WIRE_TOO_LARGE_CLAIM`, as the slot already does.
    `newestStampReserve.dom.test.ts` gains the flipped order at 150/300/400 and
    keeps every original row, `lookWireBudget.test.ts`'s newest-stamp-on-every-
    frame assertion unchanged.
  - **The persisted stamping base was written from before the clock moved.**
    Room time is an anchor plus a monotonic projection, and during an outage a
    page makes no commits and folds no frames, so nothing advanced the anchor and
    `saveClock` wrote down a reading from whenever the page last stamped
    something. Worse, `roomNow()` advances the anchor only on the branch where
    the WALL CLOCK wins — and after a backward step the wall clock never wins
    again, so even calling it first would have persisted the pre-step value.
    Measured: a phone steps its clock back during an outage and RELOADS while
    still dark, then taps before anything inbound has landed — **−1 s the tap
    wins, −10 s and −1 h it is silently reverted** (`loss = min(step, elapsed
since the last save)`), while the identical script with any local commit
    before the reload passes, because that commit's `nextStamp()` calls
    `roomNow()`. **`saveClock` now persists `roomNow()`'s return value**, and
    `StoredClock.baseAt` records `Date.now()` at save so the restore can project
    across the gap under a `Math.max(0, …)` a backward step cannot drag down.
    `anchorPersist.dom.test.ts` — both backward steps, the forward step, and the
    local-commit control that pinned the mechanism.

  The harness gained three things the round needed and a real device already
  has: the broker stamps what it delivers from a clock no peer can move (and can
  hand over a message with the stamp it was first accepted with, which is what a
  replay IS), a peer's `stop()` runs on that peer's own clock — the shutdown
  flush writes `base` and `baseAt`, so running it on the test's clock handed a
  skewed phone a correct one for the one write where it matters — and
  `readClockSlot` lets a test model a slot written by an older build.

  **Round 10 — one class, three ways: a write made while the device was
  OFFLINE.** Every one of the nine rounds before this had measured the room with
  the writer connected, or connected to something. The remaining hole was the
  other case, and it produced the settings-revert report verbatim on a build
  sealed against it twice. All three are now the same sentence — **a write the
  room has not heard is an INTENT**: it takes effect locally at once, it is
  re-stamped against the first frame folded after the link is back up, it
  survives a reload, and it ships oldest-first.

  - **The wire shipped the NEWEST unheard write first, so an offline tap made
    before a config edit never travelled at all.** Round 8 gave
    `fitStateEnvelope` an unshipped head that rides ahead of everything else and
    ordered it by stamp RECENCY — which is the same mistake `RESERVED_NEWEST_
STAMPS` made one round earlier, one level down. An ONLINE peer never noticed,
    because its head drains a few stamps per frame as they ship; a peer that is
    offline while writing has nothing draining, so when the radio returns the
    head is the whole write set and a tap made BEFORE a multi-leaf config commit
    is at the very back of it. Measured on the shipped eight-layer look, the
    phone taps 90 offline, tunes 400 knobs, and reconnects for six seconds:
    **28-29 state frames leave it and NOT ONE carries `render.rotate`'s stamp**,
    so the value travels BARE, reads as `EPOCH`, loses to the room's stamped 270,
    and the tap is reverted on the Kraken and on CAM permanently — `lastError`
    null, status line reading online. As convergence time, with the phone tapping
    last so it must win the merge: **300 knobs 2.7 s, 350 → 5.1 s, 400 → 11.0 s,
    450 → 13.9 s, 470 → 32.5 s** (above 500 the frame is refused whole and the
    transport re-asserts the pre-tune frame, which did carry the stamp, so the
    room converges in ~100 ms — the failure peaks exactly where the frame still
    fits but the stamp does not). **`appSync` now records an `unshippedSeq`** when
    a path enters the unshipped set, `wireStamps` hands the head over oldest-wait
    first, and pass 1 reserves BOTH ENDS of it — the oldest few because they are
    at greatest risk of never travelling, the newest few because that is the leaf
    somebody just touched. The reserve is SPLIT rather than doubled, which is a
    correctness constraint and not a saving: taking sixteen starved the reserve
    for what the room HAS heard and cost round 8's own script its convergence.
    The claim at `SyncService.ts` that "the unshipped and the newest `r`" travel
    "within ONE" frame was true only while `u ≤ r`; the bound is now stated in
    the four parts it actually has. `offlineWireOrder.dom.test.ts` — the stamp on
    the FIRST frame back at 400 and 470 knobs, and the six convergence rows.
  - **Intents did not survive a reload, so a phone that opened with no signal lost
    its tap forever.** `heard` is persisted in the v2 slot and so is the register
    table, but the `intents` SET was in-memory only: the restore rebuilt the
    registers, seeded `unshipped`, and seeded nothing into `intents`. So a session
    that ended having heard nothing came back holding its offline writes with the
    skewed stamps they were born with, and `foldRoomFrame` had an empty set to
    drain — the write ordered by the phone's own wrong clock, permanently, across
    every subsequent reload. **This is not the documented residue**, which needs a
    peer more than a day out: measured over both value orders, it fires at
    **−3 s, −10 s, −90 s and −1 h** and passes only at −1 s. The seeding needs no
    new slot key and no version bump, because a page whose previous session heard
    NOTHING has by construction only its own writes in the table — `heard` is set
    by the first inbound frame on any channel, so a restored register cannot have
    come from a merge. `intentReloadSkew.dom.test.ts`, 14 rows including the
    skew-0 and heard-first controls.
  - **The intent layer armed on "have I ever heard the room?", and the question is
    "have I heard it since I went dark?"** Measured with EVERY clock in the room
    correct: phoneB taps and locks its screen, phoneA's wall clock steps forward
    (an NTP correction, a timezone fix), phoneA taps, and 6.5 s later phoneB
    unlocks and taps at once — **at +10 s and +1 h phoneB's tap is reverted on
    every screen**, at 0 and +1 s it lands. So the boundary was never the clamp
    the code and the docs both named; it is the ROOM's forward clock motion
    during the deaf window, which any in-clamp skew on ANOTHER device produces.
    A local write is now an intent whenever the room's transport is not online,
    or nothing has arrived for `ROOM_SILENCE_MS` — five seconds, twice the
    display's 2.5 s monitor beat and well inside the shortest outage a person
    notices. The heuristic half is documented rather than hidden: in a room with
    no telemetry at all, a quiet stretch makes the next tap an intent too, which
    widens the "genuinely simultaneous" case by one round trip and is the cheaper
    of the two errors. `intentReconnect.dom.test.ts` at steps 0/+1 s/+10 s/+1 h
    plus the static +1 h control that pins the mechanism.
  - **One shipped assertion flipped, and it is `hlcFloorPin`'s A3.** That test
    pinned "the last finger lost to alphabetical order of client ids" under a
    far-future pin, and said in as many words that if a future change made the
    later tap win it should be rewritten loudly. A re-stamp under a pinned `t` is
    `(t, c + 1)`, one past the clock the returning peer has just folded, so
    **CAM's later tap now wins: `good=270 CAM=270 display=270`.** The pin itself
    is untouched and A2 still measures it — two peers that were both connected
    the whole time hold no intents, neither re-stamps, and that contest is still
    decided by counters and then by client id. `docs/remote-control.md` and
    `appSync.ts`'s residue note say so.

- **"I had to click things twice on my phone."** Reported against the remote's
  Library, investigated with real touch emulation, and it is two separate
  things — one reproducible here, one structurally impossible to reproduce in
  Chromium and now held by a build rule instead.

  - **Hover-gated content (the iOS cause).** A touch browser has no pointer, so
    it decides what a tap MEANS: iOS Safari delivers the first tap as a hover
    whenever hovering would reveal, hide or move something, and withholds the
    click. The library tile's Pin/Rename/Delete row was `opacity: 0` until
    `:hover`, with an `@media (hover: none)` block putting it back — same pixels
    on a phone, and the `:hover` rule that makes Safari choose hover was still
    written. It is hover-first now: the actions are visible by default and only
    `@media (hover: hover)` ever hides them, so a touch browser never reads a
    rule it could swallow a tap for. Chromium has no such heuristic at any
    emulation setting, which is exactly why this is enforced by
    `scripts/check-invariants.mjs` rather than by a test: any `:hover` selector
    outside `@media (hover: hover)` that sets `display`, `visibility`, `opacity`,
    `pointer-events` or `transform` now fails `npm run check`, with a
    `hover-ok:` escape hatch for the cases that genuinely cannot bite.

  - **A tap that was not acknowledged.** Pressing a tile is a state commit, and
    the state channel is last-writer-wins — a frame already in flight when the
    press landed can answer with the previous tile, and a highlight that flicks
    off is read as "that did nothing", which is answered by pressing again.
    `RemoteLibrary` now holds its own press for `RECONCILE_GRACE_MS`, the same
    grace and the same argument `curationOptimistic` already uses for pin,
    rename and delete: act as if it worked, and be told otherwise. Bounded, so a
    press that genuinely did not take still ends up telling the truth. Pressing
    the tile that is already showing remains harmless — `showTile` writes an
    absolute value rather than toggling.

  - Both are covered by a new e2e suite under real touch emulation
    (`hasTouch`, `isMobile`, a coarse pointer, `tap()` rather than `click()`),
    which also sweeps the segments, the transport and the shelf's select mode:
    one tap, one effect, and the state to prove it.

### Changed

- **Design audit round 8 — the claim in its non-sentence forms, and the two
  scans that could not see it.** Round 7's closing audit found the same failure
  three more times, in three shapes neither round 6's grep nor round 7's type
  was looking at: a **dot**, a **card headline** and an **instruction**. All
  three assert something about the LCD panel that the window has no evidence
  for; none of them is a sentence, which is exactly why they survived a rule
  about sentences.

  - **The live dot is evidence now, on all four modules.** `describeStatus`
    returned `live: true` as a literal for clock, stats and image — the presence
    was threaded into the verb one line below and thrown away for the dot — so
    the first screen a user ever sees, with the CAM install band still on it,
    burned a live dot beside "Showing Clock". This is not a bug beside the
    claim, it IS the claim: `panelClaims.panelVerb` documents the collapse of
    the `showing` tense onto exactly that pixel — the word may stay in the
    participle **because** the dot is what asserts "this second" — so a hardcoded
    dot spent a tense nothing had paid for. It is `panelIsLive(presence)` for
    every module now, the way the video path has read it since round 6, and the
    e2e suite pins the verb and the dot together across all four modules in all
    three states.

  - **"Paired with your PC" waits for the PC.** The remote's card said it on
    `paired && roomCode !== null`, two facts a phone produces entirely on its
    own: **Create a code** mints a room and joins it in one commit, so a phone
    that had never been near a Kraken announced a pairing with one. The card is
    gated on the presence derivation the sub-line 200 px above it already
    consumes. The room is real either way, so the code, **Unpair** and **Pairing
    options** stay exactly where they were; pre-evidence the headline reads
    **Your pairing code** and the card spends the space on the thing a code with
    no Kraken behind it actually needs.

  - **…which is a route into CAM, and the old copy named one that does not
    exist.** The phone's unpaired card read _"Create a code here, then scan it
    from the CAM window on your PC — nothing to type"_. There is no QR decoder
    anywhere in `src`, CAM has no camera, the phone draws no square of its own
    below 700 px, and typing is the only way a code minted on a phone reaches
    CAM: the sentence asked the one device that can scan to be scanned by the one
    that cannot, and closed by ruling out the only route that works. Each reader
    is told the route its own hardware has — CAM hands a code out; the phone
    takes one with its camera, or types one in — and the phone-created path names
    **Remote** and **Type a code instead**, both real controls on the surface
    named. `docs/remote-control.md` gained the phone-created case and the
    evidence rule; the old sentence is in `RETIRED_PHRASES`.

  - **The literal scan reads what the formatter wrote.** `vocabulary.test.ts`'s
    extractor was two line-anchored regexes, and Prettier is house style at
    `printWidth: 100` — so the reflow that makes a paragraph readable is the
    reflow that makes it invisible, and a sentence long enough to be a claim is
    by construction long enough to be wrapped. Eighteen prose nodes on the config
    surfaces were unreadable to it. It parses now (`ts.createSourceFile`, which
    is error-tolerant and so safe on comment-stripped source): a JSX element that
    directly contains prose is joined from its children, inline elements
    flattened and `{' '}` spacers taken as the space they are, so what is scanned
    is the sentence a reader sees. A fixture holds the three escaped shapes,
    because a rule proved only against a clean tree is proved against nothing.

  - **…over a wider verb family, and it caught one immediately.** The family was
    the verbs round 7's findings happened to use; _running_, _looping_,
    _mirroring_, _displaying_, _up on the panel_ and _is live_ assert what
    _playing_ asserts. The low-frame-rate banner shipped **"Your Kraken is
    running at 1 FPS"** — flat, present progressive, from `readDisplayFacts()`,
    which reads `localStorage` and therefore outlives the session that observed
    it: a window opened a week later asserted a frame rate on the strength of a
    record. It is `CLAIM_FRAME_RATE` through the spine now, and only the verb is
    tensed — the reading and its consequence are facts either way.

  - **The honesty property runs over a registry, not over the exports.**
    `panelClaims.test.ts` walked `Object.values(claims)` and so reached 6 of the
    module's 18 claims: the six composed ones are module-private on purpose, and
    all five `SITUATION_VERB` rungs live in a record, so eleven three-tense
    sentences were unreachable by the one test that exists to check three-tense
    sentences — and the guard against the walk finding nothing (`>= 6`) was
    satisfied by the exports alone however many private claims were added beside
    them. `claim()` is the only constructor and it registers, so privacy is a
    property of the door rather than of the check; the vacuity guard is now the
    module's own `claim(` count. The literal scan's exemption of `panelClaims.ts`
    and this registry are halves of one bargain, and each file says so.

  - The mini-halo's echo of the status line's name is **audited and kept**: at
    thumb size the seven-character middle ellipsis is the only identity the bezel
    has once the poster is gone, which is not the same object R11 removed. The
    comment sits where the next auditor will look.

- **Design audit round 7 — a claim about the panel is a TYPE, not a phrase.**
  Round 6 built two spines and this round measured what each one bought. The
  **paste** spine held, because `pasteLink.ts` owns a door: there is no way to
  submit a link except `pasteAction`, so a field that bypasses the mapping is a
  compile error. The **presence** spine leaked, because it was enforced by a
  two-phrase grep that a file satisfied with a single import — `HomeView.tsx`
  names `panelPresence` once, so all 1,382 of its lines passed, including
  `<b>Playing through YouTube</b>` and _"your Kraken is playing it straight from
  the web"_: two unconditional present-tense claims about a panel the window may
  never have heard from, six pixels from a card that asks the question properly.

  - **`src/app/config/panelClaims.ts` — the claim, as a type.** A claim is a
    `PanelClaimSpec`: the same sentence in three tenses, one per presence state
    — _live_ "Playing through YouTube", _quiet_ "Plays through YouTube",
    _never-seen_ "Plays through YouTube when your Kraken connects". The only ways
    to turn one into words (`panelClaimText`, and the `<PanelClaim>` element
    beside it) **require** a `PanelPresence`, so there is no signature that
    renders a claim without asking. Where a claim deliberately collapses two
    states, the triple makes that an explicit, reviewable decision per sentence
    instead of an accident of whichever boolean the author reached for.
    `panelPresence.ts` keeps the derivation and nothing else.

    Every claim moved: the spine-wired ones (`settledReceipt`, `linkReceipt`,
    `nowShowingBadge`, `showingTile`, `handoffHeadline`, `playingLine`), the
    status line's one-word verb — which was typed in three files — the CORS
    sub-line, the accepted-link sub-line, the "streaming from the link" headline,
    the install band's headline, and the tail of all four `failureLine`
    sentences, whose reason clause stays where it belongs because a full disk is
    a fact about a machine rather than about a panel.

  - **The enforcement is structural.** `vocabulary.test.ts` no longer greps for
    two phrases. It extracts every **string literal and JSX text node** from
    every config surface, keeps the ones that read as prose, matches them against
    the present-tense panel-verb family (`playing`/`plays`, `showing`/`shows`,
    `on screen`, `streaming`/`streams`, `fetching`/`fetches`, `picks it up`), and
    requires each to live in `config/vocabulary.ts` or `app/config/panelClaims.ts`
    and nowhere else. A raw literal anywhere else fails by existing. A second
    test reads the claims module's own source and requires every exported
    function to take a `presence`, because a future `export function
nowPlaying(name)` would type-check perfectly and reopen the exact hole. The
    old import check is kept as a belt.

  - **F1 — invented durations, at the three consumers round 2 missed.**
    `LOOP_MAX_SEC = 3600` is a rail length, not a duration. Round 2 stopped it
    being _printed_ as a total and left it feeding the seek input's `max` and the
    handles' range, so a tap two thirds along the bar reported a playhead at
    forty minutes of a video nobody had measured, and a drag on **B** persisted
    `loop.end = 2177` into the synced document. Same narrowing as the quality
    ring: **without a known duration the control withdraws rather than
    degrading.** The rail is decorative — no seek input, no loop band, no
    progress fill — the handles are disabled with the honest line _"Loop points
    unlock when your Kraken reports the length"_, and
    `src/app/config/loopPoints.ts` is the single guard every write path goes
    through, unit-tested directly. Both consumers (the phone remote and CAM's
    home Loop panel) get it, because it is the component's rule rather than a
    caller's.

  - **F3 — one group, one answer.** The three transport buttons greyed out on
    `displayOnline` and the rail above them did not: a tap on a dead link moved
    the thumb, sent a `seekTo` into a room with nobody in it, and left the bar
    showing a position no display had ever reported. The seek gates on the same
    freshness.

  - **F4 — a receipt that named a shelf the shelf then denied.**
    `LINK_RECEIPT_UNSEEN` opened _"Saved to the library — …"_ and the Library
    page renders it directly above **Nothing kept here**: an announced library
    entry and an empty shelf, in one frame. Nothing has been fetched and nothing
    has been kept; what was saved is the choice. It reuses `SAVED_HEADLINE`'s
    frame — the word the ladder's settled card already uses — so the two receipts
    cannot drift into two words for one fact, and the old spelling is a retired
    phrase.

  - **F5 — CAM's `#/remote` is the pairing surface.** One page was served to
    every window, and in CAM's Configuration Browser that page was a remote
    control for the machine it was running on: a replica ring above that window's
    own live mirror, a scrubber for a panel whose real transport is one click
    away, a Library that IS this window's database, and a card announcing
    **Paired with your PC** — to the PC. Unpaired it was worse, because it was
    advice: _"scan it from the CAM window on your PC"_, printed inside that
    window. CAM now gets pairing and only pairing — **Scan with your phone**, the
    QR up front at the size a camera resolves, the room, rotate and copy — and
    every window that really is remote keeps the instrument. `ownsBytes()`
    decides, so no fifth signal was invented.
    [`docs/remote-control.md`](docs/remote-control.md) described this flow
    already; the UI matches it now.

  - **F6 — receipts are keyed to STORY time.** The ladder's retirement timer
    started on mount, so "four seconds old" meant four seconds since React
    rendered. Reopening CAM on a day-old stored state replayed the whole ladder —
    _"Sent to your Kraken · On screen now"_ — narrating yesterday as news, and
    holding the halo down to a 64 px thumb for four seconds while it did it.
    `receiptIsCurrent` measures against the flow event's own clock: a download
    job's `updatedAt`, or the instant this window itself accepted the link. No
    known moment means no narration, which is why a state committed yesterday, or
    from a phone, is not replayed — the status line under the halo still carries
    the steady state.

  - **Minors.** The phone's own **Add** panel had the desktop placeholder (the
    one `pasteAction` call site that never passed the width) and stood above a
    second link field for the same module — one field per screen now, the Add
    panel wins while it is open. The phone's empty shelf is the framed card CAM
    draws rather than a grey caption under the Add button. The quality row said
    **Auto** twice within thirty pixels — once as the selected segment, once at
    the head of the description — so the description now says only the half the
    segment cannot show. A stats dial is labelled once: the sub-line already
    opens with the component's name, so the standalone label under the number
    goes. All four legacy routes (`#/module/<id>`, `#/preview`, `#/sources`,
    `#/diag`) share one behaviour — two were listed in `mainKey` and two were
    not, so half of them rewrote their hash and then tore the screen down and
    rebuilt it. And the companion health probe runs in a **worker**: Chrome logs
    a failed subresource load from the renderer before any `catch` sees it, so
    every user without the downloader collected `net::ERR_CONNECTION_REFUSED`
    for a component behaving exactly as §6.4 specifies. A worker's fetch failures
    do not reach the page console; the probe, the timeout and the fallback are
    otherwise unchanged.

- **Design audit round 6 — two missing spines, and the enumerations that keep
  them.** Every previous round named a class, fixed the instances somebody had
  photographed, and watched the class survive on the surfaces nobody had. Round
  6's findings all orbit two absences, so the work is the two absences rather
  than the six screenshots — plus two tests that FIND violations instead of
  asserting a list of known ones.

  - **One paste mechanism (C1).** `pasteAction` — the mapping that decides
    whether a link field is the _video_ field or the _picture_ field, based on
    what is actually on the panel — reached two of the app's four link fields.
    `RemoteAdd` and `LibraryView` still called `submitVideoLink`
    unconditionally, so a picture pasted into either **Add** panel landed in
    `modules.video.cfg.url`, silently switched the active module to video and
    printed a success receipt: the exact three lies round 5 removed from the
    remote's other field. Both panels go through the mapping now — module-aware
    label, placeholder, submit verb and validator, with the quiet _"Play
    something"_ for Clock and Stats — while their file halves keep their own
    kind-routing, because what a file IS is a question about its bytes.

    The door is shut behind them: `submitVideoLink` and `submitImageLink` are
    module-private, so `pasteAction` is the only way to commit a pasted link and
    the compiler enforces it. `tests/e2e/paste-spine.spec.ts` is the other half —
    it walks every route in every module state, asks the DOM which text inputs
    accept a URL, and requires each one to carry `data-paste-field`. A link field
    added later fails that test **by existing**; a URL that is a _setting_ (a
    broker address, a proxy base) declares itself at the field with
    `<TextInput settingUrl>` rather than being listed inside the test.

  - **One presence truth (C2, C3, C4, C5).** Four surfaces asserted the state of
    the LCD panel without ever asking whether a panel had been heard from, and
    each had its own private notion of "connected" — `paired`, `displaySeen`,
    `displayOnline`, `sync.monitor !== null`. `app/config/panelPresence.ts` is
    the one derivation: **never-seen**, **quiet** (seen once, not lately) and
    **live** (telemetry is fresh), from two injected facts, with no clock and no
    storage of its own. Every claim about the panel is routed through it.

    - **C2** — the download ladder settled on _"On screen now — Playing on your
      Kraken"_ on a first-run window, at the same moment and on the same screen
      as the band explaining how to install CAM. With nothing ever seen it says
      what is true: **Saved — plays when your Kraken connects**. The status line
      under the halo consumes the same signal, so the two cannot disagree about
      one panel eighteen pixels apart, and the same question now gates the
      Library's _"is on your Kraken"_ receipt, both shelves' **On screen** badge
      (**Next up**, when nothing has been seen) and the ladder's _"Sent to your
      Kraken"_ card.
    - **C3** — the remote mounted the video instrument (title, scrubber, A-B
      handles, ±10, quality) whatever the synced state said was on the panel, so
      a phone paired to a Kraken showing a clock was offered a scrubber for it
      under a heading naming an `.mp4`. `const live = paired` was one name doing
      three jobs; it is `paired`, `isVideo` and `presence` now. Clock, Stats and
      Image keep their own compact controls — the Showing row, Fit, the
      module-aware link field and the shelf — and get no transport. The
      sub-line is `playingLine`, which returns nothing at all unless telemetry
      is fresh.
    - **C4** — `RemoteRing` mounted a real module renderer with `props.display`
      still `null`, falling back to `RING_PX` and `scale(1)` while `replica.ts`
      fell back to a `0 × 0` geometry: a 640 px dial cropped to the top-left
      corner of a 132 px circle, drawn confidently, on the one surface whose
      promise is that it shows what the panel shows. A replica now requires
      reported geometry; without it the ring draws the treated placeholder card,
      named after the module.
    - **C5** — the remote's _"Sent to your Kraken… a tile appears here shortly"_
      was printed into rooms with nobody listening in them. All three link
      fields print `linkReceipt(presence)`, which says **Saved to the library —
      your Kraken picks it up when it connects** when nothing has been seen.

    The enumeration is in `src/config/vocabulary.test.ts`, extended from the
    "one voice" sweep: it reads the comment-stripped tree for the
    "on your Kraken" / "On screen" claim family and requires every file making
    one to consume `panelPresence`. The display graph is excluded because
    invariant I8 forbids it importing config code at all — a page running on the
    panel does not have to wonder whether the panel is there.

  - **The minors.** The room-code rule was printed twice on a refusal — as the
    field's description and again as the error — and now moves between the two
    rather than being said louder; **Enter** in that field joins, which it never
    did; an `aria-invalid` field gets a visible ring in the palette's danger
    colour, keyed off the ARIA state so the announced and the visible answer
    cannot come apart. `formatBytes` gained a bytes rung and a gigabytes rung, so
    a 70-byte file is no longer **"0 kB"** and a browser quota is no longer
    **"4096.0 MB"**. The Library's quota meter honours the round-2 rule it was
    written for and hides over an empty shelf, instead of reading
    "13 kB of 4.0 GB used" under **Nothing kept here**. A filename in the halo is
    shortened with a middle ellipsis (`lib/text.ts`) rather than broken mid-word
    — the compact bezel drew `demo.mp4` as "dem / o.mp / 4". `DiagView`'s privacy
    sentence read _"Nothing here contacts the network, including X and Y"_, which
    parses as a list of things it does contact; it says **not even** now. CAM's
    tile **Delete** gets the same confirm sheet the phone's batch delete has had
    since wave 3 — `views/ConfirmSheet`, mounted by both shelves — because it was
    the last unconfirmed destructive act in a product with no undo. Two stale
    docstrings (`LibraryView`'s add-panel note, `remote-control.md`'s
    delete-confirm section) match the code again.

- **Design audit round 5 — the app saying something it does not know to be
  true.** Six findings and a batch of minors, and they are one class rather than
  six: a surface asserting a fact it had not checked, could not check, or had
  stopped checking. A receipt for a link that went into the wrong module; a
  progress bar drawing a completed download over a quantity nobody had measured;
  a success line standing over the shelf it said something about, after the thing
  was deleted; two documents declaring a shipped feature impossible.

  - **The phone's link field is the field for whatever is on the panel (S1).**
    The home screen's paste row has taken the active module's noun since round
    2's R9 — "Paste a picture link" / **Show** for Image, the quiet "Play
    something" for Clock and Stats — and the mapping that does it was written
    inside `HomeView`, so it existed on exactly one of the two screens that draw
    that row. The remote called `setVideo({ url })` unconditionally under the
    words _"Paste a video link"_ and a button that said Play: with **Image**
    active, a pasted `.jpg` was written to `modules.video.cfg.url`,
    `modules.image.cfg.url` stayed undefined, the receipt below the field said
    it had been sent, and the panel went on saying "No picture." Three claims,
    none of them true. The mapping is `pasteLink.pasteAction` now, next to the
    two submit functions it chooses between, and both surfaces read it — so a
    module added later gets a row on both screens or on neither, rather than on
    the screen whose author remembered.
  - **The docs no longer declare the LAN transfer impossible (S2).**
    `remote-control.md` described **Send a file** correctly in one section and,
    a hundred lines later, listed _"Cannot: Add files to the clip library"_
    among the remote's limits; `troubleshooting.md` answered the same question
    with _"It cannot, and this is not a bug."_ Both were true right up until
    wave 3 shipped the peer-to-peer transfer, and both went on being read.
    Rewritten to the shipped truth — where the bytes go, what the same-network
    requirement actually is, and where the app says so — along with a promised
    one-click link into CAM that no longer exists on the remote and a claim that
    the remote can only _choose_ from the shelf, which curation retired.
  - **A meter that does not know the percentage says so (S3).** `Meter` rendered
    `pct` as `` `${pct ?? 100}%` `` under a docstring promising an indeterminate
    render, and all four callers that pass `null` pass it for the same reason —
    the total is not known. So an unmeasured quota drew a full disk, and a
    chunked download with no `Content-Length` was a finished bar at byte one and
    stayed finished while the bytes climbed. There is a real indeterminate
    treatment now: a soft pulse travelling the track, **no fill element at all**
    (asserted structurally, so no stylesheet can reintroduce a width), no
    `aria-valuenow`, and a static half-tone under `prefers-reduced-motion`.
  - **Receipts expire, and they invalidate (S4).** A receipt is an assertion
    about the world, and it needs both retirements: it lingers on
    `RECEIPT_LINGER_MS` — the home screen's rule, now shared — and it is void the
    instant its subject stops existing, which no timer can know. The Library
    page's _"Added “x”."_ stood directly above **Nothing kept here** after the
    file was deleted, and a delete performed from the phone left it standing in
    CAM for the rest of the session. Library messages carry a `claim` now,
    reconciled against the tiles the grid itself draws.
  - **A rejected room code is answered (S5).** `normalizeRoomCode` returns
    `null` for anything that is not eight alphabet characters and **Join**
    simply returned on it: no notice, no `aria-invalid`, no clue. The field
    carries both now, naming the rule in the same sentence its hint uses, and it
    filters to the Crockford alphabet as you type — folding `I`/`L` → `1` and
    `O` → `0` on the keystroke instead of silently at submit, and refusing `U`,
    which the alphabet excludes and which has no lookalike to fold into.
  - **Nothing scrolls sideways on a phone (S6).** The About page's **Route**
    control was 364 px of fixed-width segments, so the page somebody opens when
    something has already gone wrong side-scrolled at 320 and 360 px. It wraps
    like every other four-option row, and the property is swept: every route, at
    320, 360 and 390.
  - **Minors.** ONE byte formatter (`src/lib/bytes.ts`), replacing three that
    disagreed — including the home screen's `MB_DECIMALS = 0`, which rendered
    every download under half a megabyte as **"0 MB"** while the bytes were
    visibly climbing, and five separate definitions of `BYTES_PER_MB`. Phone tile
    actions are a two-column grid rather than a wrap that dropped **Delete** onto
    a line of its own, reading as a more serious control than the two above it.
    Doc drift: the one media library's real store names, `.3gp` among the
    rejected containers, pictures where the doc said clips, `?inject=late`'s real
    1500 ms, the shelf's own noun on the remote, and the phone-to-PC transfer in
    the README's feature list.

- **One Kraken, many windows — wave 1 (architecture proposal, phases A and B).**
  The report was _"the library is different on my phone and the files are
  separate."_ It was not a perception problem: `#/library` was routed with no
  surface gating at all, so a phone reached a **second, real, empty library**
  backed by the phone's own IndexedDB — with a quota meter for the wrong disk, a
  drop target, and a working `Browse…` that ingested into a store the Kraken can
  never open. Meanwhile the display had been publishing its actual shelf on the
  `tele` channel for two milestones, and the remote latched the packet, built a
  `name → title` lookup out of it, and threw the rest away.

  The model the whole wave is built on: there is exactly one object in this
  product, and every surface is a _window_ onto it. **Visibility is a property of
  the Kraken; capability is a property of the window.** A window that cannot hold
  the bytes still shows the whole shelf and still routes the play command; the
  only thing it must not do is offer a control whose bytes would land where the
  Kraken can never read them.

  - **The gate (A1).** `mount.tsx` already computed `camDetected` and `role`, and
    they drove exactly one status chip. They are now THE gate, in one pure,
    unit-tested function (`app/config/surface.ts`), and it fails closed: anything
    short of both signals agreeing is a remote. Off the owning surface there is
    no `Browse…`, no drop target, no file input, no quota meter, no persistence
    chip, and no display iframe in the home screen's halo — that iframe boots the
    _real_ display page, which is only true on the window sharing CAM's storage
    partition; anywhere else it is a second decoder and a second download, on a
    battery, reading a database with nothing in it. `?cam=1` / `?cam=0` is a
    simulator seam for both sides of the gate, exactly like `?sim=` for the panel
    geometry.
  - **The wire adapter (A2).** `sync.library.body` → `LibraryTile[]`, through the
    same pure `buildLibraryTiles` CAM's grid uses. `ClipSummary` and
    `ImageSummary` are structural supersets of the builder's input, so the
    phone's shelf cannot drift from CAM's by construction rather than by
    discipline — and a half-read row from a fork or a different build is dropped
    rather than rendered as a tile that does nothing when pressed.
  - **The remote's Library is a PEER of the transport (A3).** Ring → what's
    playing → transport → **Library** → pairing. Not a modal, not a drawer, and
    not a "picker" — the deleted feature that read as a duplicate app. Playing is
    the existing state commit (`showTile`, now shared by both shelves so a tile
    does the same thing in whichever window it is tapped), which already travels
    and is already retained. No new command op was invented for it.
  - **Treated art is the shipping answer (A4).** `TreatedArt` is a deterministic
    pure function of the name, so most tiles are pixel-identical on the phone and
    in CAM for **zero bytes on the wire**. A YouTube source additionally gets its
    public poster, fetched by the phone itself — the still already has an address
    and the phone already has internet. Nothing bulk-pushes thumbnails: that is
    ~14 s of channel-saturating traffic per cold phone through a free public
    broker, repeated on every unlock.
  - **The vocabulary sweep, on a second axis (A5).** The first pass unified the
    _words_ and left the _speaker_ unconstrained, which is how `COPY_HOME =
'on this PC'` — correct and load-bearing in CAM — ended up rendered on a
    phone, where "this PC" refers to nothing the reader is holding.
    `OWNER_ONLY_TERMS` names the terms only the owning surface may import and
    `vocabulary.test.ts` pins the import list, so a phone-visible file reaching
    for one is a failing test rather than a screenshot in the next audit. The
    shelf's six names (Library, Your library, Your pictures, the shelf, the clip
    library, the clip picker) collapse to one noun. The phone says one sentence
    about the one real asymmetry — _"Files are added at your PC."_ — once, as a
    fact. And the remote's link field finally carries the receipt: adding from
    the phone has worked the whole time and only the surface that needed the
    explanation least was saying so. The receipt itself drops "once CAM picks it
    up", which named a program the reader is not running.
  - **A desktop browser is the same remote, at a desk (A6).** Paired, it is
    identical to the phone plus the pairing QR at scannable size. Unpaired, it is
    pairing **and** the install card — the person at a desktop browser with
    nothing paired is very often the person who has not pointed CAM at this page
    yet, and the only door to that instruction was on a screen they could not
    reach from here. Not on a phone: "point CAM at this address" is advice about
    a PC. Never file ingest, at any width — that is a data-integrity lie rather
    than a UI preference. An unpaired remote's `#/library` lands on pairing (a
    hash rewrite, never a navigation — invariants I1/I2) rather than drawing an
    empty grid and calling it your library.

- **One shelf, one set of acts, and a way in from your phone — wave 3
  (architecture proposal, D2 and fork 1).** Waves 1 and 2 made the library one
  library: one store, one order, one packet, visible from every window. What was
  still asymmetric was what you could _do_ with it. The phone could see every row
  and play any of them, and then had to walk to the PC to rename a badly-named
  clip or delete something — and could not add a photo from its own camera roll
  at all. Both of those are now gone, and neither needed a second library to fix.

  - **Curation as commands (`setPinned`, `renameMedia`, `deleteMedia`).** Playing
    something needed no protocol — it is a state commit, and state is a full
    retained snapshot both windows already share. Pin, rename and delete have
    nothing to commit, so they are the first library _acts_ on the `cmd` channel,
    parsed once at the boundary in `src/lib/curation.ts` and applied by the
    display against the merged media store. Three properties carry the design:
    **absolute, never a toggle** (`setPinned` sends the value it wants — the
    `cmd` channel is redelivered by a replaying transport, and this is the
    `seekBy` hazard); **batched by id** (`sendCmd` throttles per op at 200 ms and
    **drops** the rest, so a five-item delete loop would delete one thing — the
    remote's shelf grew a **Select** mode so one command carries every id); and
    **idempotent by id**, which is what makes it safe for this channel to have no
    acknowledgement. `v` stays 1, exactly as it did for `requestDiag`.
  - **Optimistic, then reconciled** (`app/config/curationOptimistic.ts`, pure and
    unit-tested). The tile changes the instant you press; the next library packet
    either agrees, in which case the overlay is forgotten, or it does not — and
    the tile comes back with one sentence saying so. A grace window stops a
    packet that was already in flight from restoring a tile a heartbeat after it
    was deleted, and while anything is unsettled the remote repeats the command
    (it is idempotent) and then falls back to pulling the shelf, because both
    zero-network transports are a **last-value slot rather than a queue** and a
    command can be written over.
  - **Delete asks once, and only on the remote.** Destructive, from a room away,
    over a link with no acknowledgement and no undo. CAM deletes on the press:
    there the row, the finger and the shelf that redraws from a local database
    are all in one place, and a confirm would be a tax on the surface that needs
    one least. **Rename is new on both surfaces** — the name is the one thing on
    a tile a person chose, and for a downloaded clip it was frequently a hash.
  - **LAN file transfer — "Send a file" (fork 1, built).** A photo in a camera
    roll could not reach the Kraken by any path the app had: the bytes have to
    land in the browser profile the LCD page can read, and a phone shares nothing
    with it. So they go **peer to peer over WebRTC**, with the offer, the answer
    and the ICE candidates riding the ordinary **encrypted** sync channel — there
    is no signalling server and there will not be one, so the broker sees
    ciphertext and only a peer holding the room code can start a transfer. The
    **display is the receiver**, because the display is the window that owns the
    store, and the assembled blob goes through the **existing ingest pipeline** —
    same probe, same thumbnail, same quota check, same rejection words as a file
    dropped on CAM's own page. There is still exactly one way a byte becomes a
    row. 16 KB chunks with `bufferedAmount` backpressure; a 500 MB cap; and the
    **quota consulted before a byte moves**, in one round trip, rather than at
    the end of a progress bar.
  - **LAN-grade, and honest about it.** One STUN server and deliberately **no
    TURN relay** — a relay means somebody's server carrying somebody's video,
    which this project will not run and cannot promise. So the constraint is that
    the two devices share a network, and the app says exactly that, once, **after
    a transfer has genuinely failed or timed out** (~15 s). It is not a warning
    shown up front: pre-emptively apologising for the case that almost never
    happens is how a feature teaches its user not to use it.
  - **Nothing new on the LCD's critical path.** The receiver is a lazy import on
    the first `transferOffer` — the same seam `requestDiag` uses — and lives in
    its own `transfer` chunk outside both shells, because anything under
    `src/app/display/` is weighed in `displayCriticalPath`. `displayGraph` (I8)
    and a new eslint layering zone both prove `src/transfer` reaches neither
    `src/ui` nor `src/app/config`.
  - **`Files are added at your PC.` is retired**, because it stopped being true.
    The sentence was wave 1's one honest asymmetry; the control that removes the
    asymmetry now stands where it stood. `#/library` on a remote surface renders
    the same `RemoteLibrary` the remote screen does, so there is one shelf
    implementation with one set of capabilities rather than two that look alike.
  - **Proved end to end.** `tests/e2e/lan-transfer.spec.ts` opens a **real**
    `RTCPeerConnection` between two pages in one browser context and moves a real
    mp4 across a real data channel, then asserts the tile in both windows —
    because every interesting failure in this feature is in the handshake and a
    mocked handshake proves nothing about it. `tests/e2e/curation.spec.ts` pins
    the batching claim as a **number**: three tiles deleted together increment
    the display's applied-command counter by exactly one.

- **One media library, all the way down — wave 2 (architecture proposal, phase
  C).** Wave 1 made the shelf _look_ like one shelf. Underneath it was still two:
  two object stores, two orderings, two localStorage mirrors, two record shapes —
  and, in the image module's own settings panel, a second list of pictures
  sitting beside the unified grid. Their union existed only in the view layer,
  which is exactly why the shelf could look like one shelf and behave like two.
  **Kind is a property, not a place.**

  - **The second picture shelf is deleted (C1).** The design audit parked this
    for the user (§6) and the decision is made: a module panel holds _settings_,
    and there is exactly one shelf. Photos has no separate Videos app. Picking a
    stored picture is what the Library grid's tiles already do, for both kinds,
    through one commit — so this is a deletion rather than a redesign, and it
    took a feature away from nowhere: the same act, on the same picture, is one
    screen over and works from the sofa as well as from CAM.
  - **The stores are merged, and it needed no schema surgery (C2).**
    `platform/mediaStore.ts` is the one library: clips and pictures in `media`,
    bytes in `mediaBlobs`, `kind` on the row. `media` and `meta` were created at
    DB v1 and referenced nowhere outside `idb.ts`, so every install already
    carried an EMPTY `media` store — which is what makes the upgrade safe. **v4
    creates one object store and reads nothing**, so an interrupted
    `versionchange` still cannot leave a library half-migrated; the copy happens
    afterwards in an ordinary `readwrite` transaction, one row at a time, driven
    by what is already in `media`, so idempotence and restartability are the same
    property and an interruption simply means "not finished yet". Nothing is
    _moved_: reads fall back to `clips`/`images` for any row not yet copied, with
    the merged row winning on a collision, so the shelf is complete before the
    copy starts, while it runs and after it ends. A delete removes the legacy row
    too — otherwise the fallback read would put back what the user just deleted —
    and is idempotent by construction, which is what will make it safe to accept
    from a remote. **The old stores are not dropped in this release**: the
    overlap costs a duplicate library on disk and buys a rollback.
  - **One order, and one list on the wire (C2).** `newestFirst` — newest first,
    ties broken by id, so the order is TOTAL — is the comparator the store sorts
    with _and_ the comparator the wire packet trims with. Two files written in
    the same millisecond can no longer swap places between the window that owns
    them and the window looking at them from the sofa. The library packet is one
    `items` array carrying `kind` per row rather than two arrays a shared budget
    split apart and the reader re-joined; a packet whose shape has to be rejoined
    by its reader is a shelf that can be ordered differently at each end. A row
    with no `kind` is read as a clip, so an older display still fills the shelf.
  - **A picture carries a thumbnail, made once, at ingest (C3).** "A picture is
    its own thumbnail" was true and cheap in one window with a short shelf; it is
    a full decode of a multi-megapixel file per tile, on every visit, once the
    shelf is long — and on the display page that decode competes with the
    renderer's frame budget, the one place in this app where a stutter is visible
    on the physical panel. `ImageRecord` gets the same 320-edge WebP
    `ClipRecord` has carried since M1, cropped from the centre so a mixed shelf
    is one shelf visually as well as structurally. Pictures stored before this
    are backfilled on first sight and written back, exactly as clips without a
    frame already were.

### Fixed

- **The silent scale cliff, and the five-minute cold start (wave 1, phase B).**
  Two defects that between them made every other library fix untrustworthy — a
  shelf that is sometimes blank teaches the user it is not the real one.

  - **The index row is ~90 bytes lighter, and the 40-item cap is now shared
    (B1).** `tele` is not trimmed the way `state` is: an envelope over the 8 KB
    ceiling is DROPPED with a `log.warn` nobody is reading on a hidden Kraken
    Browser window. A 40-row clip index was already ~8.2 KB against that ceiling,
    so above roughly thirty-five clips the phone's library went blank **forever,
    invisibly**. `mime`, `width` and `height` are gone from the wire row — the
    tile's detail line has not rendered pixel dimensions since round 2's R7, and
    nothing ever rendered the MIME type — and the item budget is now shared
    across clips and pictures, so a library of 30 and 30 publishes the 40 newest
    things rather than 40 clips and no pictures at all.
  - **Pictures cross the wire (B2).** `publishImageIndex` wrote to localStorage
    only, which reaches CAM's own configuration window over the shared origin and
    reaches a phone never — so the remote's shelf was half the collection and had
    no way to know it. They ride the same packet now, under the same budget,
    because they are one shelf. A shelf too big for one envelope **pages** via
    `chunkedTele` instead of being dropped; the budget arithmetic is unit-tested
    (`lib/libraryPacket.test.ts`) rather than observed as a packet that
    mysteriously did not arrive.
  - **`requestLibrary`, and it sits outside the telemetry gate (B3).**
    `LIBRARY_REPUBLISH_MS` is **300 s**, and `tele` publishes unretained — so a
    phone unlocked one second after a republish waited most of five minutes in
    front of an empty shelf, with nothing on screen to say it was waiting. A cold
    remote now ASKS the moment its transport comes up, and keeps asking on a
    three-second beat until an answer lands, because the request is unretained
    too and a display that was still booting never saw the first one. The
    keepalive stays at five minutes: it is a keepalive, not the cold-start path.
    The command is handled outside the `publishTelemetry` gate for the reason the
    repo already gives for `requestDiag` — that toggle governs the continuous
    stream a display volunteers about itself, and this is a person in the room
    pressing a button; gating it would leave the library permanently blank on a
    phone whose owner once turned telemetry off, with nothing anywhere to explain
    why. Additive, so the protocol version stays 1.

- **The shelf is live in every window, and it has one source (adversarial
  verification of waves 1–3).** The waves were re-verified against a running
  build rather than against their own reports, and the five gaps that survived
  are closed here. The first one is the original complaint coming back through a
  different door.

  - **A change made in CAM reached an already-open phone in up to five minutes.**
    The display re-announced its shelf on four triggers — boot, the
    `LIBRARY_REPUBLISH_MS` keepalive, its own downloader, and a command from a
    remote — and every one of them is something the DISPLAY did. A file added,
    renamed, pinned or deleted in CAM's configuration window, the window that
    actually owns the bytes, was none of them, and an idle remote never asks
    (`PENDING_PULL_MS` only beats while that remote has a change of its own in
    flight). So the phone showed a shelf that was not the Kraken's shelf, with
    nothing on screen saying so — including tiles for rows that had been deleted,
    which play nothing when pressed. Reloading fixed it instantly, which is the
    shape of the bug: the cold path was right and the live path did not exist.
    CAM already publishes both library mirrors on every write, and a
    `localStorage` write fires a `storage` event in every other document on the
    origin — CAM's own grid has listened for exactly that since the beginning.
    The display listens too now, through the same `schedule()` debounce the
    downloader uses. No protocol change, no new command, no new packet.
  - **…and the debounced republish is `immediate`, which turned out to matter.**
    `publishTele` throttles at 5 Hz and **drops** what lands inside the window
    rather than queueing it, while the replica feed publishes a monitoring
    snapshot and a panel thumbnail on that same channel continuously. A dropped
    `videoStats` costs 200 ms of a stale counter and the next one repairs it; a
    dropped library packet is a shelf that stays wrong until the five-minute
    keepalive — the defect above, arriving through a third door. Found by the new
    e2e, which failed six times out of six on a loaded machine and passed alone;
    with `immediate` it is 12 for 12 under the same load, in about four seconds.
    It cannot flood: the debounce already caps it at one per second.
  - **The wire shelf and CAM's shelf had two sources of truth.**
    `publishLibrary` built its packet from `readClipIndex()` + `readImageIndex()`
    — the two **localStorage mirrors** — while CAM's grid built its shelf from
    `listMedia()`, the merged IndexedDB store with its legacy fallback. Two
    readers, two sources, nothing reconciling them: `writeRaw` degrades to an
    in-memory map when localStorage refuses, and an in-memory mirror in one
    window's JS context is invisible to every other window, so a row that reached
    IndexedDB during a failed mirror write was a row the phone could never be
    told about, permanently, with no repair path. It was reproduced, not feared.
    `publishLibrary` reads the store now and `toMediaSummaries` takes
    `MediaRecord`s, so the shelf on the wire is the shelf CAM is looking at by
    construction. The mirrors keep the one job IndexedDB cannot do — telling the
    other windows that something changed — and their key names move to
    `platform/mediaStore` beside the library they describe. `readImageIndex()`
    had no readers left and is gone.
  - **CAM's own Add could not add a picture.** `accept` was
    `video/mp4,video/webm,video/quicktime` and every file went to the video
    ingest — on the surface that OWNS the bytes, on a page whose grid renders
    pictures, under a **+** button labelled "Add a video or a picture", while the
    phone's Add (on a surface that owns nothing) accepted both kinds. The only
    routes to a picture in CAM were a URL or a transfer from a phone in the same
    room. The picker takes `video/*,image/*` now and routes on `isPictureFile` —
    the same predicate the LAN transfer's receiver has used since wave 3 — into
    the same two ingests, so there is still exactly one way a byte becomes a row.
    The sentence above the picker names both kinds, because the control does.
  - **`surfaceName()` is deleted.** A dead export whose only caller was its own
    unit test, with a docstring promising a `data-surface` attribute no component
    rendered. The distinction it named is already drawn where it changes
    behaviour (`data-owns`).
  - **Machine-centric copy is caught by a test, not by a reading.** The remote's
    pin button carried `title="Allow this to be cleared when the disk fills up"`
    — "the disk" is CAM's referent, and from a sofa it names something the reader
    cannot see or act on, which is precisely the failure A5 was written to
    prevent. `OWNER_ONLY_TERMS` pins _imports_, so a string typed inline slipped
    it entirely. `vocabulary.test.ts` reads the remote-rendered files themselves
    for `MACHINE_NOUNS` now. ("Your PC" is deliberately not on that list: a
    paired phone has a real referent for it, and says so on purpose.)
  - **Both defects are pinned by e2e the suite structurally could not have
    caught.** Every existing spec seeds CAM _before_ the display boots, or has
    the display ingest for itself. `tests/e2e/library-live.spec.ts` brings the
    display up, opens the phone, waits for it to settle on an empty shelf, and
    only then lets CAM appear and add a clip — then deletes it and watches the
    tile go. Both were confirmed to fail without the fix.

### Changed

- **The design audit's fourth round: every mechanism reaches every state it
  governs.** (Design audit round 4 — findings F1–F7 and the minors.) The audit's
  meta-finding was that each previous round installed a real mechanism and then
  applied it only to the states that had been photographed. So this round carried
  each one to its whole domain, using the exhaustive-union and DOM-enumeration
  patterns the codebase already had.

  - **The receipt overflowed CAM's window on the flagship path (F1).** The halo
    yields the floor when something opens in its place — a rule written as
    `compact = openOps || loopOpen`, which is a list of the two callers somebody
    had photographed. The paste receipt is a third: ~180 px, in the same slot,
    produced by the app's own primary action. The page ran **179–189 px** past
    the fold for the whole four seconds it was up, and 11 px worse in the error
    state. The rule now asks what is on the screen rather than who opened it, and
    the receipt's retirement moved up from `DownloadFlow` into `HomeView` so the
    composition can see it. Where the receipt and the options panel would compete
    — measured, 148 px and 201 px inside a 537 px composition — the receipt
    yields, because of the two it is the only one that is narration.
    **The class fix:** `FlowStage` is an enumerated list (`flowStages.ts`) rather
    than a bare union, and the page-fit suite iterates it, so every stage the
    receipt can ever be in is a measured state at 866×537, closed and with the
    options open. That immediately found the _other_ unphotographed state: a
    YouTube link makes the video options 84 px taller (the ads notice and the
    bias helper), and the round-3 fit assertion had only ever opened the options
    on the default empty config. The panel's rhythm compresses to hold it.
  - **Control depth moved under the user (F2).** `ModuleOptions` answered "this
    panel has no primary controls" by _relocating_ the advanced ones to the top
    level — so Stats' **Colour** hopped between two levels of the hierarchy
    depending on the Layout segment, a control on the ops strip about something
    else entirely. Depth is a property of the CONTROL: Colour is advanced on
    Clock and on Stats, in every layout. What the empty-room rule changes now is
    whether the door is **open**, which is a statement about this moment rather
    than about the hierarchy. One tap still lands on a control.
  - **There was no reachable exit (F3).** With Advanced open the page is a
    deliberate 1,343 px flow in a 537 px window, and at the bottom of it the
    panel's × was 557 px above the fold — inside CAM's Configuration Browser,
    which has no back button, no address bar and no tab strip. **Escape** now
    closes the options panel and the loop scrubber from anywhere on the page, and
    the panel head — the module's name and its × — is sticky while
    `data-advanced` is true, so an exit is on screen at every scroll position.
  - **Concepts written twice (F4).** The Clock and Stats panels each carried a
    hand-written 26-word sentence about CAM charging for repaints in the frame
    rate you actually get; the Library used **Kept**, **saved** and **stored**
    for one act within 200 px of each other. Both families are constants in
    `config/vocabulary.ts` now (`FLAT_COLOURS_WHY`, eight words; `KEPT_VERB` and
    `NOTHING_KEPT`), and `vocabulary.test.ts`'s grep covers them — a second
    literal copy is a failing test rather than an audit finding.
  - **The identity hue could land on the failure colour (F5).** A library tile
    with no thumbnail is drawn as a treated card whose hue was `hash % 360` — a
    full turn — so six of twenty sample filenames put an ordinary clip in red or
    amber, which this product uses for one thing. `libraryItems.tileHue` clamps
    the hash into a cool band (blue → teal → violet), unit-tested over a corpus
    rather than over six names, and the warm treatment is applied from
    `data-tile-state` in the stylesheet, so it is a fact about the download and
    never about the filename.
  - **A retired CAM path was still shipping on the LCD (F6).** `image/display.ts`
    printed `CAM → Kraken → Configure` in its image-error message while importing
    `CAM_PATH_CONFIGURE` twelve lines above it. Fixed — and the rule is no longer
    "the constants agree with each other": `camPaths.test.ts` greps the whole
    source tree for anything shaped like a CAM menu route and fails on any file
    but `camPaths.ts`.
  - **The cascade bug recurred twenty-five lines below its own warning (F7).**
    `.kh-mods { gap: 10px 12px }` inside `@media (max-width: 700px)` was dead,
    redeclared at equal specificity further down the file — the exact failure
    round 2 root-caused, fixed and wrote a comment about, immediately above it.
    Separately, `.kh-subhead` was two components under one name: a long-dead
    in-panel heading whose declarations were silently styling the sub-page
    breadcrumb 1,500 lines away. Both fixed. **The class fix:**
    `scripts/check-invariants.mjs` now parses every stylesheet and fails the
    build on any selector declared inside an at-rule block and again later at the
    same specificity with a property in common, with a documented
    `cascade-collision-ok` escape hatch.
  - **Minors.** The receipt's sub-line is dropped when it only restates the
    headline ("YouTube video detected" over "a YouTube video"); the remote's one
    link is labelled **About**, which is the page it opens, rather than
    "Connection & diagnostics", which names a page that has not existed since
    round 1; the paired remote's 176 px QR folds into **Pairing options**, since
    on a card that is already paired it is a way to pair a _second_ device and
    was the loudest object on the screen; the ten "…yet" apology strings are
    resting copy that describes what IS ("Auto", "Nothing kept here", "no
    report", "Linked — waiting for your Kraken"); the About page's technical
    drawer no longer reports this project's own measurement backlog; About prints
    the build id once, in the footer that got you there; Video's Advanced door
    gets two subheads (**Framing** / **Delivery**) without gaining a level; and
    four stale comment clusters were corrected against the code they describe
    (`router.ts`'s redirect count, `ConnectionSection`'s switch labels,
    `DiagView`'s section list, and "Forget this Kraken", which has been **Unpair**
    since round 2).

- **The design audit's third round: every fix installs the assertion that makes
  its whole class unrepresentable.** (Design audit round 3 — findings F1–F8, plus
  the minors and the collateral.) The audit's core criticism was not that rounds
  1 and 2 fixed the wrong things — it was that they fixed measured **symptoms**:
  the panel's height rather than the page's budget, an enumerated list of tap
  targets rather than the control inventory, one screen's vocabulary rather than
  the app's. So each finding below is answered twice: once in the product, and
  once in a test that a fourth instance of the same mistake cannot get past.

  - **The Advanced door was inert at CAM's window (F1).** `ui.css` carried
    `.kh-home .kh-disclosure { max-height: calc(100dvh - 268px); overflow-y: auto }`
    inside `@media (max-height: 640px)` — a "floor under the promise" that, with
    the options and Advanced both open at 866×537, silently swallowed **929 px**.
    Pressing Advanced rotated a chevron, produced a scrollbar inside a box, and
    changed nothing else a user could see. The cap is deleted. Opening Advanced
    promotes the panel to an honest full-height flow that scrolls the **page**,
    visibly and expectedly, with the nav row and the footer in flow below it, and
    scrolls the door you just opened into view so the press has an answer.
    `.kh-home[data-advanced]` says which of the two promises is in force.
  - **The budget is the page, and it always was (F2).** With the options open and
    Advanced closed, the composition overflowed CAM's 866×537 window by 14 to
    77 px on every module — the panel ended above the fold and `.kh-more`, this
    app's entire navigation, was bisected by it. Round 2's assertions had passed
    throughout, because they measured the panel's last pixel and called it the
    composition. **A component is never the unit of measurement again:**
    `home-composition.spec.ts` asserts `document.scrollHeight <= clientHeight`
    for **every module × {closed, options, options + Advanced}** at 866×537, with
    the nav and footer whole, `scrollY` still 0, and nothing scrolling inside its
    own box. The rhythm was tightened to hold it: the short-viewport block now
    compresses the shell, the header, the footer and the options rows, and the
    first-run band shrinks the halo while it is on screen rather than pushing the
    navigation off the bottom of the first screen anybody ever sees.
  - **The first open of a module's options no longer animates against a
    placeholder (F3).** `ModuleSettingsView` used `React.lazy`, so the panel's
    opening spring ran for 380 ms against Suspense's `Loading settings…` — a
    different height from the real content — and then hard-cut when the chunk
    landed. Prefetching alone does not fix it: `lazy()` starts its import on its
    first render and suspends on that render even when the module is cached. The
    component is resolved **before the element exists** now, out of a cache
    (`views/configPanels.ts`) that `HomeView` warms whenever the active module
    changes — choosing a module is a decision to look at it. The panel's first
    render is the real panel; the cold path renders nothing for a beat rather
    than something the wrong size.
  - **The flagship receipt never left the screen (F4).** Round 2 gave the paste
    receipt a retirement and hard-coded the stages allowed to use it — `accepted`
    and `stored` — which excluded the single most common thing anybody does with
    this app. A YouTube link produced a 219 px three-card ladder that stayed for
    the session, asserting that a video was playing next to a halo showing it
    playing and a status line saying it was playing: **one fact, four times.**
    The rule is a question about a stage now rather than a list
    (`homeState.receiptPersists`, an exhaustive `switch` over `FlowStage`, so a
    new stage is a compile error rather than a card that inherits "stays
    forever"). Every steady state collapses into the status line; only an
    unfinished download and a failure persist. The _"Ads and all, the way YouTube
    sends it"_ line was a **source property** wearing the grammar of an event —
    it lives in the video module's options, next to the control that answers it.
  - **Doors to empty rooms are unrepresentable (F5).** Three of the four module
    panels opened to a signpost sentence — _"Face, hours and seconds are on the
    strip above"_ — and a closed `Advanced` disclosure: a deliberate second tap
    on the active chip, answered with a paragraph about somewhere else and
    another door to press. Stats' panel had literally nothing else in it. Every
    module builds its options through one component now (`ui/ModuleOptions`),
    which **promotes the advanced controls to the panel itself when there are no
    primary ones**, and has no `hint` slot at all. All four signpost sentences
    are deleted, and the suite asserts, per module, that the options open onto a
    control rather than onto a door.
  - **Touch targets: the inventory, not a list (F6).** Round 2 shipped a
    five-selector assertion that passed while the four **module chips** — the
    app's primary gesture — sat at 36 px directly underneath it, along with the
    options' × (26), Loop (21), every range (18), every field and secondary
    button (39), the scrubber's loop toggle (20), the wordmark (26) and the
    footer link (18). `tap-targets.spec.ts` enumerates every visible interactive
    element (anchors, buttons, form controls, `summary`, ARIA widgets, anything
    in the tab order) on every route at 390 px and holds all of it to 44 px,
    counting an absolutely-positioned pseudo bleed as the target where one
    exists. The exception list is empty, deliberately.
  - **One vocabulary, app-wide (F7).** `LibraryView` still said _"Saving to your
    Kraken…"_ — the exact phrase `HomeView`'s own comment documents as killed —
    and the destination of a kept copy flipped between _"on this PC"_ and _"to
    your Kraken"_ depending on which file you were reading. The words live in
    `src/config/vocabulary.ts` now, every surface imports them, and
    `vocabulary.test.ts` walks the source tree to prove no second **rendered**
    literal survives (comments may still name a retired spelling, which is where
    naming one is useful). The keep-a-copy row is labelled by its destination —
    **On this PC** — so its options can be the verbs instead of repeating it.
  - **In-progress and failed library tiles are things, not holes (F8).** Round 2
    gave stored clips a generated frame with a treated hue-card behind it and
    left the other two states rendering a bare `.kh-tile__thumb` — a ~400 px
    black rectangle. The two tiles a user looks at hardest, because something is
    happening or something went wrong, were the two with nothing on them. Both
    get the same treated card, with the progress meter and the failure line drawn
    **on** it rather than instead of it.
  - **The minors, each with a number or a string behind it.** The first-run band
    overflowed CAM's window by 93 px (227 with the address revealed) and led with
    a garden path — _"then turn CAM → Lighting → your Kraken → Web Integration →
    Frame Rate up"_, a five-step menu route between a verb and its particle; it
    fits now and uses About's grammar, from one source. About printed its own
    name a second time 30 px under the breadcrumb that had just said it. The
    compact mirror row was left-aligned while every other row was centred — one
    orphan x-axis at the moment the halo is least able to anchor anything. The
    Library's corner button rotated its `+` into an `×` and kept the word "Add"
    underneath it, and its add panel gave thirty words of advice about preparing
    a file in the box whose job is to take the file you already have (the advice
    moved to `docs/local-clips.md`). The empty library floated a third of the way
    down its screen. The remote was the one sub-page with no way back below
    700 px. Two stale comments named controls deleted a round ago.

- **A layout bug the audit walked into: `<main>` was not the row that grew.**
  `.kh-shell` was `grid-template-rows: auto 1fr auto`, which is correct for the
  home screen's three children and silently wrong for every sub-page, because
  those have four — the breadcrumb sits between the header and `<main>`, so the
  `1fr` landed on the **breadcrumb**. Measured on `#/library` at 866×537: 199 px
  of empty space stretched under a one-line nav, `<main>` starting 241 px down
  the page, and an empty-state card that could not be centred in its own screen
  because its screen was 251 px tall in a 537 px window. The shell is a flex
  column now, which has no row-counting to get wrong.

- **Collateral: ~131 lines of dead CSS, a dead copy table, and a documentation
  re-walk.** The stylesheet still carried `.kh-cliplist`/`.kh-clip*` (the
  pre-grid library list), `.kh-step--offer` (the downloader pitch card),
  `.kh-op__chip*` (the "Saved locally ✓" readout), `.kh-setup--first`/`__steps`/
  `__hint` (the numbered first-run card), `.kh-tile__badge` (the CLIP/IMAGE
  badge), `.kh-select` (the native picker deleted from the design system in round 2) and `.kh-home__connect` — every one of them a rule for an element no
  component renders. `PROXY_PRESETS` in `video/types.ts` was a two-entry table
  whose labels were the `<option>` prose round 1 deleted; the proxy **field**
  stays, because whether to ship a public proxy at all is one of the audit's §6
  product decisions. The user-facing docs were walked against the **shipped UI**
  rather than against the diffs: `getting-started.md` still described the
  pre-round-1 ops line verbatim (`Loop 0:18 – 0:42 · Fill · Cover · Saved locally
✓`, "scrolled to and focused on the control the line names"),
  `troubleshooting.md` named a _Not detected_ chip that reads **Not running** and
  a `Local downloader → Advanced` path that is the other way round, the README
  linked "Sources" and captioned "the diagnostics page", and `CONTRIBUTING.md`
  sent contributors to a `#/diag` page that has been a redirect since round 1.
  The three design docs' corrections tables now record rounds 1–3.

- **The About page stopped being a wall, and the remote leads with its job.**
  (Design audit round 2, wave B — findings R3, R4, R6, R7, R8, R10, R11.) Wave A
  measured the home screen. Wave B put the same ruler on the four surfaces it had
  not reached, and every number below is a number.

  - **About: 2,225 px → 1,055 px, 498 words → under 200 (R3).** The page a
    person reaches by clicking a version string was four screens of CAM's window,
    headed by internal hardware-checklist ids (`Network reachability (H19)`),
    listing `?kraken=1&diag=1` query strings, a codec matrix, a
    `devicePixelRatio`, a `SHA-256(code)` note and a bulleted inventory of
    transports. Every fact on it was true; almost none of it was for a reader.
    It is three calm sections now — **About** (one sentence, one full-bleed Add
    to CAM card with this installation's address on it exactly once, a version
    line), **Connection** (four settings in plain labels; the transport chips and
    the privacy note one drawer down each), and **Report** (what a report is, one
    primary **Copy report**, a link to the issue form, and _every_ probe behind a
    single **Show the technical detail**). Nothing probes until asked: the frame
    -rate sample and the storage probe run when you press Copy report or open the
    drawer, not on arrival. `#/diag` still resolves here.
  - **The unpaired remote mounts pairing and nothing else (R4).** It used to
    mount the whole instrument with nothing to drive: a scrubber reading
    `0:00 / 60:00` — an hour nobody had ever reported, invented by the fallback
    track length — three dead transport buttons, a video field, two pickers, and
    **two status lines both saying it was waiting**. Now it is the ring, one
    sentence and **Create a code**, with _Type a code instead_ behind a quiet
    disclosure; a test caps the whole screen at four controls. The transport,
    scrubber and essentials appear when a room is live. Where a duration is
    unknown the scrubber shows **no total** rather than an invented one, the
    sub-line only speaks when something is playing, the paired card is the room
    code and **Unpair** (the QR is for the other device, so it is desktop-only),
    and the ring's `NO PREVIEW` is the home screen's treated card and the
    source's own name.
  - **One spelling of two CAM menu paths (R6).** Five were shipping side by side
    across the display's error cards, the config UI, both validators and the
    docs. `src/config/camPaths.ts` exports the two real destinations and every
    surface imports them — including the tests, so a sixth cannot appear.
  - **Library tiles carry information (R7).** A clip stored without a thumbnail
    was a grey rectangle for good; it is generated from the file on first sight
    and written back. Where no frame can be drawn, a treated card hue-rotated off
    the name stands in. The `CLIP` badge over the artwork and the `640×640` on
    every detail line are gone, durations past an hour read `1:30:00` rather than
    `90:00`, tiles are all one height, and the **+** is a labelled **Add** — which
    is what let the empty card stop explaining where its own button was.
  - **No native picker anywhere (R8).** Wave A's rule was true exactly where it
    had been tested. The remote still had three `<select>`s and Connection had one
    plus three browser checkboxes; `Select` and `Toggle` are deleted from the
    vocabulary, and the assertion walks every route with every drawer open.
  - **44 px thumbs (R10).** At 390 px the segments were 27 px and the navigation
    row was 17. The visual size is unchanged; the boxes grew. The loop handles
    are the interesting case: their 44 px hit area was a `::after` bleed, which
    is invisible to every measurement — the dot moved into a `::before` so the
    button itself is the target.
  - **One voice, in the errors too (R11).** "the display" is _your Kraken_ and a
    "local clip" is _your library_, in every message a user can read. The image
    module's empty state is context-aware: inside the config mirror it names the
    field below it, on the real panel it gives the CAM path.
  - **…and a bug the ruler found on the way.** Moving the hardware-report pull one
    drawer down shifted its timing by a tenth of a second, and it began failing
    every run: `SyncService.publishTele` throttles at 5 Hz and _drops_ rather
    than queues, so a routine `videoStats` or `monitor` packet landing 180 ms
    before the answer to **Ask your Kraken** took the answer with it — and the
    card sat there for twenty seconds before reporting that the display had not
    answered. Report chunks publish with `immediate` now, which is the one thing
    that bypasses that throttle, for exactly the reason the answer already
    bypasses the `publishTelemetry` toggle: it is a one-shot reply to a button
    somebody just pressed, not a stream.

- **The options open in the halo's place, and there is one set of them.** (Design
  audit round 2, wave A — findings R1, R2, R5, R9, R11.) Round 1 made the active
  module chip the door to its options and killed the 1,600 px settings wall. Round
  2 put a ruler on the result: the door opened onto a panel that **still ran off
  the bottom of CAM's 866×537 window, by 426 to 888 px, on every module** — because
  it opened _underneath_ a full-height composition instead of in place of one. And
  the panel it opened was a second copy of the strip four inches above it, free to
  disagree with it in wording.

  - **One set of options, in view.** The ops strip _is_ the module's primary
    options now. Clock's panel keeps Show date and its one Advanced door; Stats
    keeps the reading the single-dial layout needs and its door; Video keeps
    keep-a-copy and Quality; Image keeps keep-a-copy and its picture shelf. Face,
    Hours, Seconds, Layout, Degrees, Labels, Fit and Slideshow are asked once, on
    the strip, where you can see them without opening anything. `FramingPrimary`
    is gone — Fit lives on the strip and Zoom moved behind Advanced.
  - **They take the halo's place.** Pressing the active chip cross-fades the
    mirror down to a 56 px corner thumb — still the live display page, still
    ticking — with the status line beside it, and the ~180 px that frees is what
    the panel opens into. Closing restores it, on the same spring, both ways.
    Measured at 866×537: every module's options fully visible, nothing clipped,
    `scrollY` 0. The loop scrubber gets the same treatment.
  - **One control idiom.** A new `Switch` — the house segmented On/Off — is the
    only shape a boolean takes on this screen; the native checkboxes and the
    remaining `<select>`s (clock and stats palettes, the stats reading, the
    quality ladder) are segmented rows. A test asserts there is no native picker
    left anywhere on home or in any module's options.
  - **The primary action is contextual (R9).** The row under the halo takes the
    active module's noun: a video link for Video, and _the_ picture-link field
    for Image — the panel's duplicate second field merged into it, same
    validation, same commit. For Clock and Stats, where there is nothing to be
    handed, it collapses to a quiet "Play something" that switches context and
    hands over the caret, rather than a loud teal `Play` demanding a video link
    for a screen that cannot use one.
  - **One status voice (R5).** The screen said `Streaming clip.mp4` under a
    permanent green `Keeping a copy` badge, about the same file, at the same
    moment. The badge is gone — keeping a copy is a _stage_, not a property — and
    the ladder narrates one story in one vocabulary: _Keeping a copy of X_ →
    _Playing X · 1:24 / 3:02_. "Streaming" is claimed only when nothing is being
    kept: stream-only, or a server that refused the copy.
  - **The receipt gets out of the way (R11).** The three paste step-cards fade
    into the status line ~4 s after a plain success — state, not narration.
    Anything the user has to know (a refused copy, a failed copy, YouTube playing
    its own ads) stays.
  - **The missing 35 px, found (R11).** The home composition measured 572 px in a
    537 px window, with the version line — the way in to About and Diagnostics —
    below the fold, under a comment in `ui.css` promising the opposite. Every
    selector in that short-viewport block was re-declared further down the same
    file at the same specificity, so the later declaration won and the compressed
    rhythm had been dead code. They are `.kh-home`-qualified now, which beats the
    duplicate wherever it sits, and the suite asserts the whole composition —
    nav row and footer included — fits 866×537 with no scroll at all.
  - **One name per module (R11).** `statsModule.name` was "System stats" while
    the chip said "Stats" and the remote's picker said a third thing; it is
    "Stats" at the source. The contextual panel's head carries the module's name
    from the registry instead of the word "Options", so the panel underneath no
    longer prints it a second time. "The demo clip" is printed once.

- **The Remote page is a remote control, and nothing else.** (Design audit wave B
  — findings F5 remaining, F6, F7, F8, F10, F11, F12, and the census's
  REMOTE 22 → 8 verdict.) The audit opened the remote's `More controls`
  disclosure and found **a second complete copy of the app** behind it: fourteen
  controls duplicating the configuration page in different words — the audit's
  example is that home said "Fill · **Cover**", the remote said "Cover — fill the
  panel, crop the **edges**" and the video panel said "crop the **overflow**" —
  plus a clip picker, the room settings, a privacy disclosure nested inside
  another disclosure with `SHA-256(code)` in it, and a hardware-report puller, on
  a 390 px screen.
  - **`More controls` is deleted.** What survives is on the page, with no door in
    front of it and no `Panel` chrome around it: the source field, the module
    picker, **Fit** and **Quality** — the four the census kept. Fit renders from
    the same `FIT_SEGMENTS` list as the home screen and the video panel
    (`src/ui/fitOptions.ts`), so the one setting is never learned three times.
  - **Room settings live in exactly one place**, a new `Connection` section on
    the merged About/Diagnostics page (`views/ConnectionSection.tsx`), together
    with the transport-detail chips, the privacy note and the hardware-report
    pull that used to sit on the remote. The remote reaches it by one quiet
    _Connection & diagnostics_ link — the only navigation on the page.
  - **Zoom, rotation and the clip picker left the remote.** Nudging and turning a
    picture is setup, not remote control, and the clip shelf lives on the machine
    running CAM, where the Library page manages it.
  - A new e2e assertion counts what is on the paired remote and fails above ten
    interactive controls outside the scrubber and the transport.
- **Unpaired pairing is one state, and it never names a code that is not on
  screen** (F5.4). The card used to read _"Point a camera at this code"_ above no
  code at all and two paragraphs above an orange _"No code yet. Press Generate
  code."_, with three equal-weight controls under it where one was the answer. It
  is now one sentence and one primary **Create a code**; the moment a room
  exists it is the QR, the room, and **Copy the link**. Typing a code read off a
  monitor is still there, behind a _Type a code instead_ disclosure, because it
  is the fallback rather than the flow.
- **About and Diagnostics are one page** (F7). They were the same errand behind
  two doors in two type styles — `Diagnostics` in the home screen's quiet row,
  `About` alone in the footer. `#/about` renders the merged page (build, Add to
  CAM, Connection, hardware report, local probes, the display's own report and
  the H-checklist links, in that order); `#/diag` resolves to it by rewriting the
  hash in page, never a navigation (invariants I1/I2), so every doc link and
  bookmark still lands. The disclosure row under the halo is now exactly
  **Remote · Library**, and the footer's version line — the exact string a bug
  report asks you to quote — is the link to everything else.
- **First run is a slim band under the halo, not a card over it** (F7). The old
  card filled the whole 866×537 window CAM actually opens, putting the halo, the
  paste field and the chips below the fold behind a page of prose and four
  competing buttons. The band is one line and **one** primary `Open in CAM`; the
  address, the CAM Beta channel and the CAM-detection readout sit on a secondary
  line behind _Show the address_. The full two-step card is unchanged under
  About, for a second machine. `Ordinary browser` — jargon that named a category
  rather than telling anyone anything — is now `Not open inside CAM`.
- **The type sweep finished** (F8). `--kh-mono` now sets **only** literal machine
  strings: `.kh-code` and the room code. It has left the footer, the tile badges,
  the scrubber's A/B handle labels and the scrubber's times — which stay tabular,
  because that is what `.kh-tnum` and `font-variant-numeric` are for, in the
  system face.
- **Library copy tells the truth about who downloads** (F5.2, F5.3). Adding a
  link used to answer _"Added. Your Kraken is fetching it — progress shows on its
  tile"_ directly above _"Nothing saved yet"_, with no tile: the **display** does
  the downloading, so a tile appears only once CAM picks the job up, and the
  message says so. The empty card no longer says "Press **+** up there" either —
  pressing that button turns it into an `×`, so the instruction named a control
  that was no longer on screen.
- **Warning colour is reserved for warnings** (F10). The storage caveat — _"May
  be cleared if the disk fills up — pin the ones you care about"_ — was drawn in
  orange next to `0.0 MB of 4096.0 MB used` on an **empty** library, where there
  is nothing to pin and nothing to lose. It appears now only when something is
  actually stored or the quota is over half used, and the false precision is
  gone: nothing stored reads _"Nothing stored yet"_, and whole megabytes are
  rendered whole.
- **Motion and surfaces** (F12). The options panel now animates **out** as well
  as in — React cannot animate an unmount, so the panel stays mounted for one
  beat with a `--closing` modifier and a timer, which fires whether or not the
  animation ran. `html` is painted with the ground colour in config mode, so the
  black band above the content on a scrolling page (index.html's critical CSS
  paints `html` black, correctly, for the LCD) is gone.
- **The phone layout is a phone layout** (F11). The paste placeholder is short
  below 700 px instead of truncating mid-word to `…YouTube, MP4, HI`; the module
  chips get breathing room; and the home screen centres in `<main>` rather than
  stacking at the top with ~450 px of dead space under it. The remote's two
  side-by-side controls shrink instead of pushing a 390 px viewport into a
  horizontal scroll.

### Fixed

- **The pairing QR was not a valid QR code, and no phone could scan it.** The
  hand-rolled encoder wrote the 15 format-information bits — the ones that tell
  a decoder the error-correction level and the mask, and the first thing it
  reads after finding the finder patterns — in reverse bit order, and split them
  8/7 between the two copies instead of 7/8, so the eighth bit landed on
  (`size - 8`, 8) and overwrote the always-dark module. Nothing in the previous
  test could see it: the matrix was square, the path was drawable, the picture
  looked exactly like a QR code. Running one through a real decoder rejects it —
  as an iPhone camera did, silently, by showing no tap banner at all. Placement
  now follows ISO/IEC 18004 §8.9, and `src/app/config/qr.decode.test.ts` puts the
  encoder's output back through `jsQR` (a devDependency; it never ships) at every
  payload length from 1 to 271 bytes, which crosses all ten version boundaries
  including version 10 and its two block groups. The three properties a camera
  needs from the drawing — dark modules on a **white** tile regardless of the
  app's dark theme, the mandatory 4-module quiet zone inside the `viewBox`, and
  an absolute `https` payload — were already right and are now asserted against
  the live DOM so a theme token or a tidy-up cannot quietly break one.
- **The pairing QR was a 56 px thumbnail — decorative, not scannable.** At that
  size a version-4 code drew each module at about one and a half CSS pixels,
  which a phone camera resolves as a grey square. It is 176 px now, with the row
  to itself and a caption saying what to do with it, on the desktop pairing card
  that exists to be pointed at. Below 700 px it is still hidden, because there
  the card is the phone's own remote.
- **A second `SyncService` in one document was silently deaf and mute.** Every
  receiver dedupes on `(src, seq)`, and `src` is `clientId()` — deliberately one
  value for the whole page load — but the sequence counter lived on the service
  and restarted at zero for each one. So the second service to be constructed in
  a page sent nothing but `(src, seq)` pairs the peer had already seen, and every
  one was dropped as a replay while the connection cheerfully reported _online_.
  Not hypothetical: it is exactly why **Request hardware report** stopped
  answering once the pull moved from `#/remote` to `#/about`. The counter is now
  per document, which is the scope its uniqueness claim was always about.

### Added

- **The phone edits the same Look.** (W6 — §8, principle 10.) The remote's
  replica ring gains an **Edit this look** affordance: one tap turns it into a
  canvas, with the ring still running the live replica underneath, and Done puts
  the remote back. Nothing about the remote's first job moved — play, hold, skip
  and the scrubber are where they were.
  - **The same editor, not a phone-shaped copy.** The gesture model
    (`gesture`/`snap`/`bounds`/`ops`/`history`, through `useEditor`) and the
    chrome (`SelectionStrip`, `LayerRail` as a sheet, `AddSheet`) are the ones
    CAM uses. The layer above the mirror was extracted from `EditorCanvas` as
    `EditorOverlay`, which both surfaces mount — the desktop with a compositor
    beneath it, the phone with the ring — so a change to how a drag behaves
    cannot land on one surface and miss the other.
  - **Touch, through the same model.** Pinch scales, two fingers rotate, a
    half-second press opens duplicate / front / back / remove, and 44 px handles
    replace the mouse's 24. `editor/touchGesture.ts` translates a pinch into the
    distance ratio and a twist into the angle `applyGesture` already speaks
    rather than forking it, and commits to one interpretation per gesture so a
    sloppy hand cannot leave a resized layer a few degrees off square.
  - **One drag, one undo step**, committed to the same store through the same
    `lookHistoryStore` — undo and redo are on the phone's header; the seam now
    records the look the document SETTLED on rather than the intermediate one
    `store.commit` publishes on its way past storage, which on a phone was the
    room's older document and turned one undo press after add-then-drag into a
    layer that vanished.
  - **The layers are drawn as outlines.** A replica ring runs one module
    renderer, not a compositor, so the phone paints wireframe ghosts positioned
    by the display's own `hostStyle()` — where each layer sits, never a guess at
    what is inside it.
  - **The canvas needs a reported panel.** Edit is disabled until the display
    has published its geometry, which is the rule the replica itself has lived
    by since round 6's C4: no report, no canvas.
  - **A new registered claim, `CLAIM_ARRANGEMENT`.** The sync body does not
    carry `look` yet, so an edit made on a phone reaches the panel only where
    two windows share storage. `views/remote/lookReach.ts` demotes the claim's
    tense on any window that cannot deliver, so the phone says _"Kept here until
    your Kraken is back"_ and never that the Kraken has an arrangement it cannot
    know the Kraken has.
  - **Still a remote.** No file input, no drop target, no library — the surface
    gate is now asserted on the pixels as well as on the boolean.

- **Options became contextual, and the ops strip became real controls.** (Design
  audit wave A — findings F1, F2, F3, F4, F5, F9, F12.) The audit's verdict was
  that the app "has no settings screen at all — it has a 2,121-pixel accordion
  that detonates inside the home page", and everything below follows from
  fixing that one thing.
  - **The active module chip is the door.** Tapping a chip switches modules;
    tapping the one that is already active reveals that module's options in an
    animated panel directly under the chips, on the app's own spring curve. The
    halo never leaves the viewport and the scroll position never moves. Before
    this there was no button anywhere in the product called Settings, Options or
    Edit, and `grep -rn "module/" src | grep href` returned **zero hits** — the
    settings route had no inbound link in the entire app (F1).
  - **The ops strip resolves in place.** `Loop Off`, `Fill · Cover` and
    `Saved locally ✓` looked like three quick toggles and were three doors onto
    the same 1,600 px wall: clicking `Loop Off` grew the home page to 2,121 px
    and jumped `window.scrollY` to 1,363, leaving the halo, the paste row and the
    chips off screen (F2). Fit is a segmented control now, Loop opens the A/B
    scrubber under the halo, and "Saved locally" is a status chip rather than a
    button that was never a button. The deep-link-and-focus machinery is gone.
  - **Loop is the scrubber, everywhere.** `RemoteView`'s two-handle A/B scrubber
    moved to `src/app/config/views/LoopScrubber.tsx` and is shared by the phone
    remote and the home screen. The numeric `Start (seconds)` / `End (seconds)`
    fields — the audit's "single most anti-Apple control in the app", and the
    worst task in its task-speed test at five clicks and a 1,363 px scroll — are
    deleted. On home the rail is a read-only position readout from telemetry,
    because there is no live display to seek from that window.
  - **The video halo shows something true** (`views/VideoHalo.tsx`, F3). Clock,
    Stats and Image have always had a real live iframe in the bezel; video had
    the same frozen blue-purple gradient before you pasted, after you pasted and
    while it played. It still refuses to run a second decoder — and now shows the
    YouTube poster from `i.ytimg.com`, or a stored clip's own thumbnail out of
    IndexedDB, or a treated card naming the source, with the live position arc
    over it whenever telemetry is flowing. The arc geometry moved to
    `views/arc.ts` and is shared with the remote's ring rather than copied.
  - **The status line is in the present tense** (`homeState.describeVideoStatus`,
    F4). `sourceName()` took the last path segment, and every YouTube watch link
    in the world ends in `/watch` — so the app's most common action was answered
    with "Ready to play **watch**". It uses `detect()`'s provider now ("a YouTube
    video"), and upgrades to the real title the moment telemetry carries one. The
    verb ladder is Playing / Holding / Downloading / Streaming, with the
    pre-flight rung reached only when nothing is genuinely happening.
  - **Pasting an `.mp4` is acknowledged like pasting a YouTube link.** The same
    gesture produced three step-cards for one and complete silence for the other
    (F4). New `accepted` flow stage.
  - **`Add anyway` exists.** `ingest.ts` has always told users to _"use 'Add
    anyway' to store it as-is"_ when a file's metadata does not arrive in eight
    seconds, and `grep -rn 'Add anyway' src/` returned exactly one hit: that
    string (F5.1). `ingestBlob` already took `force`, so the Library now offers
    the button the error names.
  - **A segmented control and a `GroupField`** joined the UI kit
    (`src/ui/index.tsx`), and fit/zoom/pan/rotate became one shared component
    (`src/ui/Framing.tsx`) instead of two near-identical copies in different
    words.

- **The look model: what is on the panel, in what order.** (Layers wave W1a —
  `docs/design/design-layers-architecture.md` §1.1, §4.1, §4.3.) The panel has
  shown exactly one module since M0, because the document could only name one:
  `activeModuleId`. The model that replaces it lands first, on its own, with no
  wiring — `src/state/look/{types,validate,selectors,history}.ts`, nothing
  importing them yet, so the schema bump and the sync projection can follow as a
  separate, reviewable step.

  A **look** is `{ layers: Layer[] }` and the array **is** the z-order, bottom
  first. Everything geometric is in unit-radius panel coordinates (1.0 =
  `Geometry.radiusPx`), so a look composed on a 640 Elite lands identically on a
  240 square: there is no pixel in the document to be wrong about.

  - **`layers[0]` is the base, by position, and it carries no config.** The base
    wears `modules[kind].cfg` — the per-kind bank that already exists — and
    overlays carry their own. `validateLook` forces that by INDEX: index 0 gets
    `id:'base'`, `frame:'panel'`, `t:IDENTITY` and has any `cfg`/`v` stripped;
    an overlay claiming `frame:'panel'` gets a box instead. Which means "a
    config has exactly one home" is a structural fact rather than a rule someone
    has to remember, and no code path has to decide which of two configs wins.
  - **The validator is total, module-agnostic, and never deletes your work.** It
    never throws, coerces every leaf, clamps transforms and frames, drops
    malformed or duplicate ids with a note, and is idempotent — the tests run it
    twice on junk, on nine layers, on a base carrying a config, on an overlay
    claiming the whole panel, and assert the second pass has nothing left to
    say. An unknown `kind` is preserved verbatim, so a fork's module survives a
    round-trip through this build. An oversized look is **noted, never
    truncated**: the byte cap is a refusal at op time with a typed reason, and
    silently deleting somebody's overlay because the JSON grew is data loss, not
    recovery.
  - **A look has one z-order, and the invariant script now enforces it.** A new
    rule in `scripts/check-invariants.mjs` fails the build on a `zIndex` /
    `zOrder` / `z-index` literal under `src/state/`, `src/render/` or
    `src/modules/` — the shape where the array says one order, a hand-written
    stacking context says another, and only the LCD can tell you. Stacking
    inside a module's own subtree is legitimate and is marked as such
    (`// layer-order-ok: …`), which is how the video module's mask and overlay
    layers pass.

### Changed

- **The settings census.** (Design audit §2 — the per-control verdicts.) The
  video panel alone carried **24 controls, 23 `<label>`s, 533 words of body copy
  and 171 words living inside `<option>` elements**, and expanded to 2,963 px —
  five and a half screens in the 866×537 window CAM actually opens. Opening the
  video options now adds well under a screen, and the whole home page stays
  under 1,100 px with them open (pinned by an e2e assertion).
  - **Killed, and wired to the default the audit named:** Picture quality
    (already governed by `fpsGovernor` and the perf promoter), Player size and
    Width for vertical videos (compositor internals, and the latter's own help
    text admitted its alternative was unverified on hardware), What "hold" does
    (the alternative raises YouTube's suggested-video grid _inside_ the picture),
    Hide the frame-rate warning (the warning is already conditional on measured
    FPS), Fade across the join (already self-disabling under load, and a second
    decoder when it is not), and the image module's Background colour (a
    free-form hex field for the strip around a picture, on a device whose bezel
    is black).
  - **Moved behind ONE `Advanced` door per module, one level, never nested.** The
    video panel had four disclosures, all four labelled the identical word
    "Advanced"; it has one. It holds the shape override, nudge/turn, the local
    downloader and its policy/port/token, and the last-resort proxy.
  - **`<select>`s of sentences became segmented controls.** Fit, keep-a-copy,
    video shape, clock face, hour format, stats layout, temperature unit,
    downloader policy and slideshow. The 171 words inside `<option>` elements are
    **zero**; what used to be the sentence is the segment's tooltip.
  - **The shape override went from seven options to three** (Auto / Wide /
    Tall). `detect()` already tells a Shorts link from a watch link, which is the
    only distinction almost anyone needs; the other four were film-school trivia
    in front of a paste box.
  - **The video panel's link field is gone.** It sat two inches under the home
    screen's paste row holding the same string. The paste row is the merge.
  - **The downloader left the success path** (F10). A working YouTube video used
    to be answered with an orange four-line paragraph and a primary teal `Get the
downloader` button — an apology and an install pitch, for the first thing that
    ever worked. The capability is untouched and lives in the module's Advanced
    door, where somebody who wants ad-free playback goes looking for it.
- **`#/module/<id>` is a redirect, not a page.** It resolves in place to home
  with that module active and its options open, rewriting the hash underneath —
  a hash rewrite, never a navigation (invariants I1/I2). Bookmarks, doc links and
  forks still resolve. `ModuleSettingsView` now renders only inside the home
  screen's contextual panel.
- **State schema 5 → 6 — the settings census migration** (`state/migrations.ts`).
  The first step that deletes user data, and every deletion is a value the user
  can no longer reach: `video.perf`, `video.loop.mode`, `video.loop.crossfadeMs`,
  `video.youtube.mode`, `video.youtube.portraitWidth`,
  `video.youtube.pauseStrategy`, `image.background`, and a
  `video.youtube.sourceAspect` holding one of the four ratios the three-segment
  override can no longer display. Keys are **dropped rather than rewritten**, so
  each module's own validator refills the default — which is precisely the answer
  the audit named — and a document that never used any of them is returned
  untouched. Fixture tests in `state/migrations.test.ts`.
- **The navigation row is no longer set in a code font** (F8, partial). `.kh-more`
  — `Remote · Library · Diagnostics` — is the app's entire navigation, and it was
  `--kh-mono`. So was the `OPTIONS` panel header, which is now a word rather than
  an all-caps machine string, with an `×` instead of a button labelled "Done".
  The full type sweep is a separate pass.
- **`TelePacket` gained an optional `title`**, type-only, so the status line has
  somewhere to upgrade to when an adapter learns a source's real name.

### Added

- **Quality: show what you're getting everywhere; offer control only where it's
  real.** (`src/modules/video/quality.ts`.) Every provider in this app has a
  different answer to "what resolution is on the panel, and can I change it?" —
  from _exact_ (hls.js hands us a level list with heights) to _nothing at all_
  (a cross-origin YouTube iframe will not tell us and will not be told). The new
  **Quality** row on the video panel's primary surface, and the same control on
  the remote page itself, is built so the UI never has to guess which case it is
  in.
  - **The reading is unconditional.** "1080p · local", "Auto — 720p right now",
    "1080p (asked)" when a pin has not been confirmed yet. It never invents a
    number: a height we requested and a height the provider reported are
    different claims and read differently.
  - **The control is one of four**, chosen by what the mounted adapter can
    actually do: a **picker** built from the levels the display reported (HLS
    `currentLevel`, DASH representations, Twitch `getQualities()`, the
    resolver's source-height ladder); a **bias** for YouTube — Auto / 720 / 1080
    / 1440 mapped onto the 1280 / 1920 / 2560 px geometry rungs, with one honest
    helper line naming who is really choosing; a **read-only reading** for a
    stored clip or direct file; and nothing at all before anything has mounted.
  - **Adapters now report their ladder.** A new `{ type: 'levels' }` adapter
    event fires the moment the list becomes knowable — a parsed HLS manifest, an
    initialised DASH stream, Twitch's READY — and rides the existing 0.5 Hz
    telemetry packet as compact `{h,l}` pairs, so the picker offers renditions
    that exist rather than a guessed ladder.
  - **`Auto` genuinely hands control back**: `currentLevel = -1` and
    `nextLevel = -1` on HLS (setting only the first leaves a pinned next level
    and the ladder never moves again), `autoSwitchBitrate` back on for DASH
    (pinning a representation turns ABR off and it does not come back by
    itself), `auto` on Twitch.
  - **On the resolver path a quality change re-downloads**, because there is no
    in-stream ladder to move. The old clip keeps playing until the new one
    lands, then they swap; both stay in the library, so switching back is
    instant. A pinned height becomes part of the key a clip is remembered by —
    without that, the library lookup would keep finding the old file forever and
    the setting would appear to do nothing after one reload.
  - Video config gains `quality: { mode, height }`, defaulting to
    `{ mode: 'auto', height: null }` — which is exactly what every existing
    installation was already doing, so nobody's picture changes on upgrade.
    Module `configVersion` 1 → 2 and state `schema` 4 → 5 all the same: the
    version is what turns "a v4 build silently drops your pinned resolution on
    the next write" into "a v4 build says the document came from a newer one".

- **The remote's ring is a live replica of the real module, not a stylized
  surface.** (`src/app/config/replica.ts`, `src/app/config/views/RemoteRing.tsx`,
  `src/app/display/replicaFeed.ts`.) The mini-halo now runs the display's
  **actual renderer** — the clock ring is the clock module, the stats ring is
  the stats module showing your real temperatures — driven by synced state.
  - **No pixels cross the wire.** An iframe on a phone would boot a _second_
    display, with a second decoder and a second download, on a battery. So the
    display volunteers only the two things a replica cannot compute for itself:
    five monitoring readings (~60 bytes, on the telemetry cadence) and a ≤6 KB
    WebP thumbnail of the current picture, sent **once** per image and cached by
    content hash. Local time is not on that list, and that is the point — a
    clock replica is correct by definition.
  - **The seam already existed.** `DisplayRenderer.mount()` has always taken
    `geometry()`, `monitoring` and `render()` as injected accessors rather than
    platform singletons, so _nothing in `clock/display.ts` or `stats/display.ts`
    changed for this feature_. The renderers cannot tell they are on a phone,
    which is the strongest available guarantee that the ring shows what the
    panel shows. The replica feeds them a fixed `DisplayInfo` derived from the
    paired device's reported geometry, so a dial tuned for a 240 px square is
    not laid out as though it were a 640 px circle.
  - Loading a module's display chunk from the config page is the **allowed**
    direction: invariant I8 forbids display → config, and `npm run size` proves
    the display graph is still clean on every build.
  - **1 Hz maximum, and fully paused when `document.hidden`** — no timer, no
    repaint. A remote left open in a background tab costs a phone nothing.
  - The video ring cannot be a replica, so it is the still plus a **position
    arc** re-anchored from telemetry, which advances smoothly between packets
    instead of stepping twice a second. YouTube's still is the public
    `i.ytimg.com` poster, fetched by the phone itself.

- **A shared chunked-telemetry channel** (`src/lib/chunkedTele.ts`). The
  diagnostics report's split-and-reassemble transfer, generalised so thumbnails
  can ride it too. Every subtlety moved with it — the shared `ts` per capture
  that lets a newer payload discard a half-arrived older one, the `.fill()` that
  stops a sparse buffer completing on its first part, the uniform `part 1 of 1`
  shape, and the two-bytes-per-character budget for JSON-in-JSON escaping.
  `src/diag/wire.ts` keeps its exact public API and now delegates.

- **The display's continuous stats packet carries the source duration.** The
  display never publishes `state`, so a freshly opened remote had no timeline at
  all and the scrubber fell back to a one-hour track. It is on the wire now,
  which is also what makes the ring's position arc drawable.

- **“Get the downloader” — the guided connect panel.**
  (`src/modules/video/resolver/ResolverConnectPanel.tsx`.) The resolver
  companion is optional and always will be, but _optional_ had become _hidden_:
  its only mention lived three disclosures deep in the video settings, so the
  ad-free permanent local copy — the best thing this product does — was
  effectively unshipped for anyone who had not read the README. The no-companion
  YouTube card and the video panel's “Not detected” card now both carry a
  primary CTA (`data-testid="resolver-get"`) that opens it.
  - **One download button.** NZXT CAM is a Windows application, so the PC with a
    Kraken attached is a Windows PC; everyone else is a developer and gets the
    copyable `npx kraken-hub-resolver` line. The link is
    `…/releases/latest/download/kraken-hub-resolver-win-x64.exe`, built by
    `releaseAssetUrl()` in `src/buildInfo.ts` from `package.json`'s
    `repository.url` — so a fork offers its own build and invariant I4 holds —
    through GitHub's `latest` redirect, so it never needs a version number. The
    asset itself is built by a follow-up change; the link resolves once it is.
  - **The SmartScreen warning, in advance.** An unsigned open-source binary
    trips Windows' reputation check, and a user who meets that dialog with no
    warning concludes the app is malware. The steps say it before it happens.
  - **Live detection, then it just happens.** While the panel is open the
    companion is probed every 2 s with the 60 s health memo dropped each time.
    On the first healthy answer the panel flips to _Connected ✓_ and writes one
    timestamp to `kraken-hub:v1:video:resolver:ping`
    (`src/modules/video/resolver/resolverPing.ts`); the **display** window —
    which is where the video is, and which memoized “no companion” before the
    user installed one — drops its own memo and re-resolves the source it is
    already playing. The link pasted before installing anything downloads and
    plays with nothing to press and nothing to paste again. Proved end to end
    against the real companion process in `tests/e2e/companion.spec.ts`.
  - `vite.config.ts`: the `provider-resolver` chunk group now matches `.ts$`
    only. That `$` is invariant I8 in one character — the group outranks
    `config-ui`, so without it the new `.tsx` panel (and with it the whole config
    vocabulary) would have been pulled into the chunk `display.ts` imports for
    `resolverClient`, putting the configuration UI on the LCD's network path.

- **“Halo” — the configuration UI, rebuilt around the screen itself.** The
  approved design direction is
  [`docs/design/halo-prototype.html`](docs/design/halo-prototype.html) (“Halo”,
  2026-08-31): the app is organised around **the object** rather than around the
  codebase. The old app had six tabs named after implementation phases — Setup,
  Sources, Preview, Remote, Diagnostics, About — and a home screen that was four
  numbered steps. The new one has no tabs and one home: the LCD, live, with the
  controls arranged around it. Everything technical still exists, one level down,
  where the curious will look.
  - **A live mirror of the panel** (`src/app/config/views/HomeView.tsx`). The
    halo runs the real display page, `./?kraken=1&sim=<preset>`, in an iframe on
    the same origin — the simulator surface the Preview tab used to hide, now
    promoted to the thing you always see. Same origin means shared
    `localStorage`, so an edit below is reflected above through the production
    storage-event path, not a lookalike React tree. The device preset comes from
    what the **display** published (the `DiagReport`, else the video module's
    telemetry mirror), falling back to the Elite.
  - **Except for video, which gets a stand-in on purpose.** A second player on
    one origin means a second decoder, a second download and — on a YouTube
    embed — a second set of ads, on a page whose whole job is to watch the first
    one. The video mirror is a stylized surface, and the truth about what is
    playing comes from the telemetry the display already publishes, in the
    status line under the halo (`live` dot, name, `m:ss / m:ss`, tabular).
  - **One primary action.** A paste row — “Paste a video link — YouTube, MP4,
    HLS…” and a Play button — routed through the _existing_ `validateUrl`, so a
    link that cannot play says so inline, in the same words the module panel
    uses, before anything is stored. Warnings never block; errors do.
  - **The download-first story, told in plain words.** When the display is
    fetching, the `kraken-hub:v1:video:downloads` mirror drives three step cards
    (detected → “Saving to your Kraken” with live progress → “On screen now”).
    The app's biggest differentiator used to happen silently.
  - **Module chips, not a settings page.** Four `aria-pressed` chips switch the
    active module through the store, and a contextual inline-ops line under them
    (`Loop 0:18 – 0:42 · Fill · Cover · Saved locally ✓`) opens that module's
    existing full panel in a disclosure below, in place.
  - **The low-frame-rate advisory now fires only on a number the display
    published** (`src/app/config/homeState.ts`). This window's own geometry
    fallback is 640/30 in any ordinary browser, so the previous
    always-on Step 1 warned users about a slider they had already raised. It
    carries the exact CAM path, and it is hidden otherwise.
  - **A quiet way down.** `Remote · Library · Diagnostics ⌄` under the fold, and
    About in the footer next to the version line. Every existing route still
    resolves; `#/preview` folds into the mirror with an in-page hash rewrite and
    no navigation (invariant I1).
  - **The whole composition fits CAM's window.** At 866×537 — the size the
    Configuration Browser actually opens — the prototype's spacing put the
    `Remote · Library · Diagnostics` row about a hundred pixels below the fold,
    which in an app with no tabs means the navigation is invisible on arrival.
    A `max-height: 640px` rhythm compresses the vertical scale proportionally
    (halo 236 → 204 px, the margins with it) so halo, status, action, chips, ops
    and the way down are on screen at once. Above 640 px tall the spacing is the
    prototype's to the pixel.
  - Stable `data-testid` hooks on every new control (`mirror`, `paste-input`,
    `paste-submit`, `module-chip-<id>`, `ops-<key>`, `fps-banner`, the
    disclosure links), used by the e2e suite.
  - **The phone remote is a media remote now**
    (`src/app/config/views/RemoteView.tsx`, prototype screen 3). It was nine
    stacked panels reproducing every configuration control on a 390 px screen.
    It is now a mini-halo, a title and a `Playing on your Kraken · 1080p local`
    line off telemetry, a scrubber, three transport buttons sized for a thumb,
    and one pairing card — with the source field, the module picker, framing,
    the clip list and the room settings intact one level down under **More
    controls**.
  - **The A-B loop is two draggable handles, not two number fields.** Real
    pointer capture (so a drag never falls off an 18 px target on a phone),
    `role="slider"` with `aria-valuenow`/`aria-valuetext`, and full keyboard
    control — arrows nudge half a second, Page Up/Down jump ten, Home/End go to
    the ends. A handle may not pass the other one, moving one turns the loop on,
    and every write goes through the existing 5 Hz throttle with a trailing
    flush, so the value you released on is the value that lands. The seek
    control underneath is still a real `<input type="range">`, laid over the
    track and under the handles: tapping the bar seeks, and the platform's own
    touch and keyboard behaviour comes with it for free.
  - **The mini-halo is a stylized surface, deliberately, and only here.** The
    home screen's halo can run the real display page because it shares CAM's
    origin and storage. A phone is a different browser on a different machine,
    so an iframe there would boot a _second_ display — a second decoder and a
    second download, on a battery — showing what the phone thinks rather than
    what the cooler shows.
  - **Five transport chips became one quiet line.** `mqtt — online`,
    `local bus — idle`, `display seen 2s ago` were all facts about plumbing;
    exactly one question was being asked, so the line answers it in words
    (_Linked to your Kraken · seen 3s ago_) and carries the same facts as
    `data-network` / `data-transport` / `data-failover` for the e2e suite. The
    plumbing itself moved into the **Diagnostics** disclosure next to the
    hardware-report pull, which is unchanged in behaviour.
  - **The remote connects with zero taps.** Scanning the pairing QR opens
    `#/remote?room=CODE` and the phone is joined before the card first paints —
    no Join button, no code typed off a monitor in another room. Three sources,
    in order: the link's own fragment, the state document if this device is
    already paired, and a remembered room for a plain `#/remote` opened from a
    home-screen bookmark. The paired card shimmers **Connecting…** until the
    transport is actually up, because a card claiming "Paired with your PC"
    through a second of radio warm-up is claiming something it cannot see.
  - **A pairing that sticks, and a way to end it.**
    `src/app/config/rememberedRoom.ts` writes the code to
    `kraken-hub:v1:remote:room` — deliberately NOT the state document, which is
    shared, published and remotely writable, so a phone's pairing survives that
    document being cleared, migrated, or replaced by a retained frame from a
    room this device has left. Reads verify with `isValidRoomCode` rather than
    `normalizeRoomCode`, because the forgiving normaliser folds
    `{"not":"a code"}` into the valid-shaped `N0TAC0DE` and the sync layer would
    then derive a real key for a room nobody is in. **Forget this Kraken**, in
    the pairing disclosure, clears all three places a room hides: the remembered
    key, the state document, and the code still sitting in this page's own
    fragment from the link that opened it.
  - **The room code stays in the FRAGMENT.** `remoteLinkUrl()` in
    `src/app/config/qr.ts` is now the single builder of the pairing link, and
    `qr.test.ts` pins that a URL built from it has an empty `search` and a `hash`
    carrying the code. This is a security property, not a style: a fragment is
    stripped before the request leaves the browser, so it never reaches an
    origin server, a CDN, a proxy, a `Referer` header or an analytics beacon. The
    room code is not a revocable session id — the topic is `SHA-256(code)` and
    every payload is AES-GCM encrypted under a key derived from the same code —
    so anyone reading it out of an access log can decrypt the room, and there is
    no server of ours to notice.
  - **Fixed: `#/remote?room=…` did not route to the remote at all.** `parseRoute`
    split the fragment on `/` without stripping its query first, so
    `remote?room=ABCD1234` was an unknown head and fell through to the home
    screen — a scanned QR opened the wrong page.
  - **Fixed: a local `sync` setting was silently rolled back by the first remote
    frame.** `appSync` re-resolves `persisted < remote < url` on every state
    message and replaces the snapshot with the result, and `useSync` handed it
    the persisted document **as read at boot** — so anything committed since was
    discarded, and `sync.*` is exactly the family that never travels on the wire
    and so never comes back. Measured on the new auto-join: the phone paired from
    the link and unpaired itself about a second later, when the display's first
    state frame arrived. `useSync` now re-reads the persisted layer at the moment
    it starts a service.
  - **Fixed: a stopped transport still reported itself online.** `useSync` kept
    the last `SyncStatus` after the service was torn down, so "Forget this
    Kraken" left the quiet status line reading _Linked to your Kraken_. Every
    reading is now derived from whether a room exists at all.
  - **Phone chrome.** `theme-color` (`#0C1017`, which is `--kh-ground`, so the
    address bar and the page are one colour) and the `apple-mobile-web-app`
    tags, so Add to Home Screen looks like an app rather than a browser window.
    `index.html` changes are **meta only** — the file is shared with the display
    page, where these are inert, and its inline critical CSS is untouched.
  - **Pairing is one card.** Unpaired, it is the biggest thing below the
    transport: QR, code field, Generate. Paired, it collapses to
    _Paired with your PC · ROOM XXXX-XXXX_, with everything that changes a room
    one tap down. Transport buttons grey out when no display has been heard from
    in twelve seconds — a Play button that does nothing three times reads as a
    broken app, not as a closed CAM.
  - **Six tabs → zero, for real.** The header is a wordmark. Sections live
    behind the home screen's `Remote · Library · Diagnostics ⌄` row, About sits
    in the footer, and `ROUTES` is gone from `router.ts`.
  - **`#/sources` → `#/library`.** "Sources" is a word from the architecture; a
    library is what a shelf of clips is called. The old hash still resolves and
    rewrites in place, no navigation (invariant I1/I2), exactly like `#/preview`
    before it. The view is reskinned with plain-language copy, a quota meter,
    thumbnails and pin/delete per clip.
  - **First-run setup, done the Apple way** (`src/app/config/displaySeen.ts`).
    The CAM install card — frame-rate slider, install URL, one-click open —
    sits at the top of the home screen while **no display has ever connected**,
    and afterwards lives quietly under `#/about` as _Add to CAM_. The trigger is
    evidence, not a dismiss button: the first time anything the DISPLAY
    published is seen on this origin (its `DiagReport`, else the video module's
    telemetry) the answer is latched into `kraken-hub:v1:config:displaySeen`,
    because the evidence itself is perishable and a user who finished setup last
    week must not be shown step one again on a cold boot.
  - **Module panels reskinned, with a hard line through each one.** The controls
    a person uses are on the surface in plain words; everything that exists
    because of how the thing is built is behind a per-panel **Advanced**
    disclosure — YouTube geometry, the CORS proxy, crossfade, pan/rotate,
    colour themes, the downloader's policy/port/token. The resolver companion
    card is now **Local downloader**, with _Downloader detected_ / _Not
    detected_; no primary control says "adapter", "resolver policy" or "source
    URL" any more.
  - **Inline ops land on the control they name.** `Fill · Cover` opens the
    module's panel _and_ scrolls to and focuses `#video-fit`. The three ids the
    home screen points at are pinned to the primary surface by a note in each
    panel — a line that names a control and then hides it inside a collapsed
    disclosure is worse than no line at all.
  - **Module order is the prototype's**: video, clock, stats, image
    (`src/modules/registry.ts`). Ordered by how often a chip is pressed rather
    than by how the code is grouped; the module picker follows it everywhere.
  - `Disclosure` joins the UI kit (`src/ui/index.tsx`) — a `<details>` with the
    house frame, so "disclosure over density" is one component rather than a
    convention.
  - Verified at 866×537 (CAM's window) and 390×844 (a phone): the halo scales,
    nothing is clipped, nothing scrolls sideways. Stable `data-testid` hooks on
    every new control, and the touched e2e specs updated to match — `#/sources`,
    the loop drag, the keyboard handles, the collapsed diagnostics pull, the
    status line's data attributes.
  - **Detection is named, and progress is a sentence.** The first step card says
    _YouTube video detected_ rather than _Link detected_ — the whole point of
    the flow is that detection is legible, and a user who pasted a YouTube link
    wants the app to agree it was one. Anything the host cannot name confidently
    falls back to _Video link detected_ rather than guessing at a brand. The
    percentage moved into the sentence (_Downloading locally — 40%_), so the bar
    runs full width instead of making room for a label that repeated it, and the
    finished card reads as a receipt: _128 MB · kept in your library_.
  - **One press gesture, one enter animation.** `scale(.96)` on press now
    reaches the module chips and the inline ops, not only the primary buttons;
    the three step cards rise in sequence (0/70/140 ms) instead of appearing as
    a block; and the prototype's `rise` moved from three individual views onto
    `<main>`, keyed by route, so every screen enters the same way rather than
    only the two that remembered to ask. All of it on the one curve, all of it
    under `prefers-reduced-motion` — including the stagger's delays, which the
    blanket duration override does not reach.
  - **The details that were cheapening it.** The inline-ops dashes were drawn at
    60% opacity against the prototype's 19%, so a quiet affordance read as a
    dotted rule under every word. `<input type="range">` was tinted with
    `accent-color` alone, which leaves the _unfilled_ half of the track at the
    UA's light-theme default — a near-white bar across a dark panel — so the
    track, progress and thumb are drawn explicitly now and match the remote's
    scrubber. The `Stats` chip said “System stats”, breaking the four-one-word
    rhythm of the chip row; `KrakenModule` gained an optional `chipName` and the
    module is still “System stats” everywhere it is named at length. Disabled
    transport buttons went from 0.35 to 0.5 opacity — an unpaired remote looked
    broken rather than waiting.
- **Remote diag pull — a hardware report off the CAM machine, from any browser.**
  The diagnostics hand-off was same-machine only: the display wrote its
  `DiagReport` into `localStorage` and `#/diag` read it back, which works because
  CAM's two browsers share one storage partition — and fails completely when CAM
  runs on a Windows PC and you work on a Mac. There was no way to get the JSON
  out at all, and the docs' copy flow quietly assumed one machine.
  - **`requestDiag`, a new `cmd` op** (`src/sync/types.ts`). Additive: the
    envelope's `v` stays 1, because a peer that has never heard of the op already
    ignores it. Only a peer holding the room key can send it — the command
    arrives decrypted or not at all.
  - **The display answers whether or not it was booted with `?diag=1`.** That is
    the whole point: nobody can edit the URL of a hidden Kraken Browser window
    from another computer. `src/app/display/sync.ts` gains a ~40-line seam whose
    heavy half is behind a dynamic `import()` — the same lazy pattern
    `DiagOverlay` uses — so the LCD's critical path does not grow and
    `npm run size` proves it on every build (78.0 kB gzip against a 90 kB
    budget, `diag-core` reached only through a dynamic edge).
  - **A budgeted quick probe set** (`src/diag/collect.ts`). Everything
    synchronous runs immediately, H12's 3 s rAF sampler gets its window, and the
    whole collection is capped at 5 s: a probe that hangs yields a report with a
    null field, never a request that never answers. The measurements that
    genuinely need a minute of watching (H04) stay honestly absent.
  - **A chunked `tele` payload that respects the 8 KB cap** (`src/diag/wire.ts`).
    The report is serialised with no whitespace and no null-valued keys, then
    split into `{ kind: 'diagReport', part, of, payload }` parts spaced 250 ms
    apart — above `SyncService`'s 5 Hz telemetry throttle, which _drops_ rather
    than queues. Parts of one capture share the capture's timestamp, so a newer
    capture discards a half-arrived older one instead of being completed by it.
  - **A Diagnostics card on the Remote page.** Request → progress hint → a
    summary (panel, DPR, target FPS, Chromium, `window.nzxt`, rAF p50, build), a
    collapsed raw-JSON block, **Copy JSON**, and a direct link to the
    hardware-report issue form (derived from `package.json`, so a fork links to
    the fork). It gives up after 20 s with _the display did not answer — is it
    online and paired?_, and a report that predates the request is never
    rendered as the answer.
  - **It answers even with telemetry switched off.** `publishTelemetry` governs
    the continuous stream a display volunteers; a report is a one-shot reply to a
    button somebody just pressed, and gating it on that toggle would make the
    button silently do nothing.
  - `#/diag` keeps its localStorage path unchanged and now says in as many words
    that it is same-machine only, and where to go when it is not.
  - Tests: `src/diag/wire.test.ts` (compaction, the envelope cap asserted by
    actually encoding an envelope, chunk/reassemble with a forced-oversize
    report, out-of-order delivery, the timeout state machine), a `requestDiag`
    round-trip in `src/sync/SyncService.test.ts`, and an e2e case in
    `tests/e2e/sync-remote.spec.ts` where a remote pulls a report from a display
    page opened **without** `?diag=1`.
  - Docs: a **From another machine** section in
    [`docs/hardware-checklist.md`](docs/hardware-checklist.md) and the new card
    in [`docs/remote-control.md`](docs/remote-control.md), both of which note
    that CAM caches the integration — a display running an older build ignores
    the request until CAM restarts or reloads it.

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
- **The companion now ships as a standalone Windows executable** — one file,
  with the Node runtime inside it, at a permanent URL:
  `/releases/latest/download/kraken-hub-resolver-win-x64.exe`. The previous
  instruction everywhere was `npx kraken-hub-resolver`, which asked a user who
  wants ad-free video on an LCD to first install Node, and which 404s regardless
  because the package was never published. Built with Node's Single Executable
  Application support (`companion/resolver/sea-config.json`,
  `scripts/build-sea.mjs`): `tsc` as usual, then esbuild collapses `dist/` into
  the one CommonJS file SEA requires — a format conversion, not an optimisation,
  and nothing external is pulled in because the package still has zero runtime
  dependencies — then the blob is injected into a copy of the host's own `node`
  with `postject`. `npm run smoke:sea` starts the built binary on an ephemeral
  port and drives the real v1 protocol against it (`/health`, `/resolve` →
  `/job` → `/stream`, unknown id → 404) with the stub extractor, because a SEA
  can be injected perfectly and still die on its first `require`.
- **`--install-autostart` / `--uninstall-autostart` on the companion CLI**
  (`companion/resolver/src/autostart.ts`). Windows only, by product decision:
  CAM is a Windows application. One `REG_SZ` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, written with the
  `reg.exe` that ships in every Windows — no native dependency, no shortcut
  parsing, and `HKCU` means it never asks for administrator rights. The value
  points at whatever executable invoked it, so the standalone exe registers
  itself and a `node dist/cli.js` checkout registers both paths, each quoted.
  Command construction is a pure module and the tests assert the exact argv;
  `reg.exe` is never executed in a test. On macOS and Linux the flags print
  "run it manually" and exit 0.
- **A startup banner.** Someone who double-clicked an exe gets a window that
  says the port, that "kraken-hub will detect this automatically", that closing
  the window stops it, and that `--install-autostart` exists. The structured log
  lines are still there underneath for whoever has to debug it later.
- **`.github/workflows/companion-release.yml`** — builds the exe on
  `windows-latest` (there is no cross-compiling a SEA), runs the companion's own
  suite, smoke-tests the binary, and publishes it. A `resolver-v*` tag makes a
  permanent release; a manual dispatch moves a rolling `resolver-latest`
  release. Deliberately never a prerelease, because `/releases/latest/` skips
  those and this release exists to be that target. Both this workflow and
  `release.yml` end by asserting that whatever `/releases/latest` now resolves
  to actually carries the exe — a broken download link is otherwise invisible
  until someone clicks it.

### Changed

- **The Library page is your library — one grid, and a `+`.** It had grown into
  four stacked sections, two of which were ways of _putting_ something in the
  library rather than the library itself, and the split was the code's shape
  rather than the shelf's: "Add a video", "Downloading now", "Your clips", "Add
  a file by hand".
  - **One grid** (`kh-grid` / `kh-tile`) holds clips and pictures together,
    badged by kind, each tile carrying the real stored metadata — duration, the
    dimensions the file actually is (including the quality-aware heights the
    resolver path now records), and its size on disk. The tile on the panel
    right now is marked **On screen**; hover or keyboard focus reveals **Pin**
    and **Delete**, and the tile itself is the play button.
  - **A download in flight is a tile in that grid**, with its percentage over
    the space its thumbnail is about to occupy and a **Cancel** beside it — the
    way everyone else does it, instead of a separate list. When it completes it
    becomes an ordinary tile _in the same slot_: `buildLibraryTiles`
    (`src/app/config/libraryItems.ts`) matches a job to the clip it produced by
    `clipId` **and** by `sourceUrl`, because the display and the config window
    mint different job ids for the same link, and sorts a job on `startedAt`
    against a clip's `createdAt` so the position does not move. A copy that
    could not be kept is a tile too, in `homeState.failureLine`'s existing
    honest words — never `Failed to fetch`, and never a claim that the video
    did not play — with **Retry** and **Dismiss**.
  - **The two "add" sections became one `+`** in the corner, opening a single
    surface: one input reading _Paste a link or drop a file_, a **Browse…**
    button, and the whole panel is the drop target. The link path now goes
    through `submitVideoLink` (`src/app/config/pasteLink.ts`) — the same
    function the home screen's paste row calls. That is a real fix, not a
    refactor: the Library page used to call `downloadToClip()` directly, which
    skipped the `config` validation context (so an `http://` link was never
    upgraded) and skipped `downloadMode` entirely, so **"Never store anything"
    was honoured on one surface and ignored on the other**.
  - **The empty state says so**, in a card that points at the `+`, instead of
    telling you to use two sections that no longer exist.
  - Re-reading IndexedDB is now driven by a signature of what the jobs _are_
    rather than by the 1 Hz progress tick: `listClips()` hands back freshly
    structured-cloned `Blob`s, so polling it would mint and revoke an object URL
    per thumbnail per second and the whole shelf would flicker while one video
    downloaded.
- **Every sub-page has a way home.** `#/library`, `#/diag`, `#/about` and — on a
  desktop-sized window — `#/remote` now carry a compact sub-header: a back
  chevron reading **‹ Your Kraken**, then the page's name. It is an ordinary
  `<a href="#/">`, so it is focusable, keyboard-operable and correct before any
  JavaScript runs, and the hash router stays the only thing that decides what is
  on screen (invariants I1/I2 — no navigation API is involved). This was a real
  dead end rather than a polish item: CAM's Configuration Browser has no browser
  chrome at all — no back button, no address bar, no shortcut — so those four
  screens could be reached and then only left by editing the URL. The remote's
  header is hidden below 700 px because there the page _is_ the app and there is
  nothing to go back to.
- **`src/ui` is now the Halo design system.** Every component in the config UI
  kit (Panel, Field, TextInput, Select, Button, Chip, Notice, Meter, Code, the
  clip list, the drop zone…) is restyled onto one set of custom properties —
  ground `#0C1017`, panel `#0F1620`, line `#232E3E`, ink `#E9EEF5`, accent
  `#4FD8D2` on `#062A28`, an amber warn family, 11 px inputs / 13–14 px cards /
  99 px chips, and a single motion curve `cubic-bezier(.32,.72,0,1)` at
  200–450 ms with `prefers-reduced-motion` honoured. Type is the **platform's
  own** face (`-apple-system` / Segoe inside CAM) with a `ui-monospace` stack
  for code-ish accents; the app loads no webfont, so the page still works
  offline and inside a strict CSP. Views not yet rebuilt (the remote,
  diagnostics — stage 2) inherit the new skin unchanged. The scroll-unlock
  rules and invariant I8 are untouched: no `src/ui` module is reachable from a
  display root, and the display critical path stays 78.0 kB gzip.
- **The walkthroughs were re-walked against the shipped app.** Every
  step-by-step in `README.md`, [`getting-started.md`](docs/getting-started.md),
  [`remote-control.md`](docs/remote-control.md),
  [`local-clips.md`](docs/local-clips.md) and
  [`troubleshooting.md`](docs/troubleshooting.md) named a surface that no longer
  exists — _Setup → Step 3 → Active module_, the _Preview_ tab, the
  _Diagnostics_ tab, "type the code into Room code → Join", "Generating a code
  on Setup", the _Resolver detected_ card. They now describe what is actually
  there: the module chips and the inline-ops line, the halo as the preview, the
  QR that connects a phone with nothing typed, **Forget this Kraken**, **More
  controls**, **Library**, the first-run **Add kraken-hub to CAM** card, and the
  video panel's **Local downloader**. Every screenshot was regenerated by
  `npm run capture` from the final build.
- **The first hardware report is in, and the docs say what was measured rather
  than what was assumed.** A maintainer's Kraken Elite on CAM 4.76.5
  (2026-08-31, app 0.1.0 `2f556b4`) closes seven automatic rows, written up in
  a new **Known results** section in
  [`docs/hardware-checklist.md`](docs/hardware-checklist.md):
  - **H01** `nzxtRaw` = `{ width: 640, height: 640, shape: "circle", targetFps: 40 }`.
  - **H02** `devicePixelRatio` = 1 — the crop math's assumption holds. The
    hidden Kraken Browser reports `screen` as 0×0 with a 640×640 viewport, so
    screen dimensions are useless there.
  - **H03** `window.nzxt` injected at 34 ms, attempt 1, zero re-injections.
  - **H12** in-page rAF locked at 40 fps (p50 = p95 = 40, `achievedFps` 39.9999,
    zero long frames) — the page is not the bottleneck.
  - **H14** `viaEvent: 3`, `viaPoll: 0` — the `storage` event is reliable across
    CAM's two browsers. The unconditional 1 s poll **stays**: one CAM build is
    not every CAM build.
  - **H17** full codec matrix including HEVC and AV1, element _and_ MSE. Both
    are GPU-dependent, so this is not a platform guarantee.
  - **H18** Electron 32.1.0 / Chromium 128, WebGPU and WebCodecs present,
    `storage.persisted` true with a ~1.49 TB quota.
  - Markers tied to those H-ids now read "confirmed on CAM 4.76.5" and keep the
    caveat, in `src/platform/geometry.ts`, `src/modules/video/youtube/geometry.ts`,
    `src/platform/capabilities.ts`, `src/state/storage.ts`,
    `tests/e2e/storage-sync.spec.ts`, `vite.config.ts`,
    `docs/remote-control.md`, `docs/troubleshooting.md` and
    `docs/design/design-ossDx.md`. **`build.target` stays `chrome108`** —
    Chromium 128 makes it conservative, not wrong, and an older CAM on an older
    PC is what the margin is for.
  - **H05 and H13 are only partially closed** and stay open: the iframe
    constructs and the API script loads, but nobody has photographed the panel
    to prove the crop hides every piece of chrome; `storage.persisted` is true,
    but no clip has been proven to survive a CAM restart. **H22 is untouched** —
    the reporter's device is an Elite, and H22 is a claim about a Kraken Plus.
    H04, H06–H11, H15, H16, H19–H21 and H23 remain open.
  - The README's frame-rate callout now cites the measured 40 fps in-page render
    and says plainly that CAM's _capture_ rate (H09–H11) is still unmeasured.

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
- **Every documented way to install the companion, swept for a promise that
  does not resolve.** `npx kraken-hub-resolver` appeared in `README.md`,
  `docs/getting-started.md`, `docs/resolver-protocol.md`,
  `docs/troubleshooting.md` and `companion/resolver/README.md`, and none of it
  worked: the package is not on npm. The primary instruction is now the exe
  download, with the SmartScreen "More info → Run anyway" step stated up front
  rather than left as a surprise, and the autostart tip next to it. The
  developer path — `npm install && npm run build:companion && node
companion/resolver/dist/cli.js` — is the documented fallback for macOS, Linux
  and anyone building from source. Publishing to npm may still happen; until it
  does, nothing promises it.
- **`release.yml` now builds and attaches the companion exe to every app
  release.** Not a nicety: GitHub resolves `/releases/latest/` to the newest
  non-prerelease release for the _whole repository_, so the first `vX.Y.Z`
  release shipped without the exe would silently break the download URL printed
  in the README and in the app itself. The job header says so, and the release
  step verifies it.

### Fixed

- **The module switch still reverted to Video, the quality picker blinked, and
  the whole remote repainted — every two seconds.** Reported live, a second
  time, after the `local` precedence layer below had shipped without a
  reproduction and had not fixed it. This time the reproduction came first:
  `src/sync/roomConvergence.dom.test.ts` fails on the previous build, on all
  four of its scenarios, before a line of source was changed.

  **Why the first fix missed.** It was verified against `FakeTransport`, which
  delivers its retained snapshot in the same microtask as `connect()` — so in
  every test the bootstrap landed _before_ the user could act. A real broker
  finishes the subscribe handshake a few hundred milliseconds later, and a
  finger is faster than that. The new harness models what the fake lacked: a
  retained snapshot from an earlier session arriving after the page is usable,
  full fan-out with no coalescing, and continuous telemetry from a display.

  Four defects, one user-visible fault:

  - **`persistRemote` wrote the raw remote body over the resolved state.** Every
    inbound frame ran `resolveState`, correctly answered "clock" — and then, two
    lines later, `store.commit(s => ({ ...s, ...syncBodyToPatch(body) }))` put
    the peer's `video` straight back, because a `commit()` replaces the snapshot
    outright. The `local` layer, the `url` layer and the retained/live
    distinction were all defeated by the write that was supposed to merely save
    the answer. It now persists **the resolved state**, which is the identical
    write on a cold display and the correct one everywhere else.
  - **That write then poisoned the layer meant to prevent it.** The commit fired
    `Store.onCommit`, which folds a _deliberate local edit_ into the `local`
    layer — so the value that had just overwritten the user's click became the
    thing defending it, and the revert went from momentary to permanent.
    `Store.commit` now carries a `CommitOrigin`, and a `'sync'` commit is not a
    decision this page took.
  - **A document arriving from storage discarded every precedence layer.** The
    other CAM browser writes to the shared document, and the display writes to
    it about twice a second; the store simply adopted whatever it read, and the
    config page's `store.subscribe` then republished that raw document as its
    own desire — laundering a stale value back onto the wire and repainting the
    entire screen on the packet rate. `Store.setResolve` lets the sync layer
    re-resolve those documents through the layers. It is deliberately not
    applied to `commit()`, where `local` still holds the previous value of the
    very key being changed.
  - **The persist throttle dropped the last write of a burst.** Leading-edge
    only, so two frames a fifth of a second apart left the stored document
    holding the _first_ one for the next two seconds. It has a trailing edge
    now, like every other throttled writer in the app.

  Two smaller repairs came out of the same trace. `noteSeenRev` had shipped
  exported and **never called**, so the Lamport counter was not a Lamport
  counter; it is now fed on every inbound frame. And a **retained** replay whose
  `rev` is not strictly newer than what this page has decided or saved is
  discarded rather than merely out-ranked — a live frame is deliberately exempt,
  which the e2e proved the hard way: guarding live frames too made a display
  that had committed anything of its own deaf to the remote's next seek.

- **The quality picker appeared and disappeared about once a second, and the
  whole remote screen flashed with it.** Same report, and it turned out to be
  one cause with three faces. The `tele` channel is **shared**: the video module
  publishes `videoStats` every 2 s, the replica feed publishes `monitor` every
  2.5 s, and the clip index, thumbnails and chunked diagnostics ride it too.
  `useSync` exposed `lastTele` — "the most recent packet of any kind" — and the
  remote read `provider`, `quality` and `levels` off it. A `monitor` packet
  therefore answered "nothing known", `qualityControlFor(null)` answered `none`,
  and `RemoteQuality` renders a paragraph rather than a `<Select>` for that — so
  the control was **torn out of the DOM** and rebuilt on the telemetry cadence,
  in lockstep with `seen Xs ago` resetting to zero.

  `SyncHandle` now carries `lastVideo`, latched by `carriesVideoTelemetry` and
  sticky across the other packet kinds; `lastTele` is liveness only. The hook's
  return is memoised, because a fresh object literal per render made
  `React.memo` on every child silently useless — that is the "everything
  repaints" half. `RemoteQuality` moved to its own file so the regression test
  can mount it and assert on **DOM node identity**, which is the only assertion
  that can tell a remount from a re-render.

  Regression cover: `src/app/config/views/RemoteQuality.test.tsx` (the control
  survives a real interleaved packet stream as the same node),
  `src/app/config/teleKinds.test.ts` (the classifier), and
  `tests/e2e/telemetry-glitch.spec.ts` (two real pages in one room, sampling
  across seven seconds).

- **A DEV-only state-layer trace.** `which layer won each contested key`, logged
  only when the answer changes. Two reports of this bug were diagnosed by
  reading four files and guessing, and the first fix was wrong because the guess
  was wrong. Every call site is inside `import.meta.env.DEV`, so it is constant
  folded and tree shaken out of a production build; `npm run size` keeps that
  honest, and the display critical path is unchanged.

- **A module switched in CAM reverted to Video a second later.** Reported live.
  The cause was precedence, not the module picker: inbound state is applied as
  the `remote` layer, which outranks anything this page saves — and that layer is
  **sticky**. Once any peer had said `activeModuleId: 'video'`, every later
  re-resolve put it back, and a retained snapshot redelivered on a reconnect is
  enough to cause a re-resolve. Which is why it looked intermittent: it needed a
  reconnect, not a user action.

  Two things were wrong and both are fixed at the layer, not at the symptom, so
  **any** setting changed locally survives a stale echo — not just the active
  module:

  - **The persisted layer was frozen at start-up.** `resolveState` ran again on
    every inbound frame against the document as it looked when the page booted,
    so every local change made since then was invisible to it. This is the bug
    class that was fixed once for `sync.*` (the phone unpaired itself a second
    after connecting) by re-reading at that one call site, which left the same
    trap armed for every other key. `AppSyncOptions.persisted` is now a
    **getter**, re-read on each re-resolve, which disarms it for all of them.
  - **A new `local` precedence layer**, between `remote` and `url`:
    `defaults < persisted < remote < local < url`. A deliberate local commit goes
    into it (via the new `Store.onCommit`, which fires for `commit()` and never
    for a `replace()` or a document arriving from storage).

  The clearing rule is the part worth reading, because it is what keeps the
  remote working: a **live** frame clears the layer wholesale — a phone changing
  the module while you watch is genuinely newer than your last click, and
  last-writer-wins is right there — while a **retained** frame does not. A
  retained frame is a _replay_ of something a peer said once, sent to bootstrap
  a peer that has just arrived; it has no business correcting a page that has
  been running and has just been told by a human to do something else.

  Deliberately _not_ done with the Lamport `rev`: it only orders writers that
  observe each other's counters, and the display and the phone keep separate
  storage, so their revs can diverge arbitrarily. Comparing them would have
  traded an intermittent revert for a silently dead remote.

  Regression cover: `src/state/localLayer.test.ts` for the ordering and
  `tests/e2e/state-precedence.spec.ts`, which asserts a module switch and a
  module-config field both _hold_ for four seconds (a single assertion right
  after the click passed on the broken build — the revert took about one) and
  that the choice converges on the display.

- **The remote's scrubber could receive no `videoStats` packets at all.**
  `SyncService.publishTele` throttles to 200 ms and **drops** what lands inside
  the window. Two publishers on the same period have a constant phase
  difference, so when the new replica feed was added at the video module's own
  2 s cadence and happened to start within 200 ms of it, one of them was
  silently dropped for the entire life of the page — the scrubber sat at
  0:00 / 60:00 forever. The replica feed now runs at 2.5 s so the phase drifts
  and a collision costs one packet instead of all of them.

- **YouTube failed outright on every machine without ffmpeg:
  `Requested format is not available`.** Reported from a Windows PC running the
  real companion exe, on ordinary YouTube links. The cause was one letter of
  yt-dlp's selector language. `b` (`best`) does not mean "the best format"; it
  means "the best format that _already_ carries video and audio in one file".
  Every rung of the shipped ladder was a `best` —
  `best[height<=?H][vcodec!=none]/best[height<=?H]/best` — and a present-day
  YouTube watch page publishes no such format at all, not even the 360p `itag 18`
  everything used to fall back to. So all three rungs matched nothing and yt-dlp
  exited non-zero. The height filter was fine and the fallback chain was fine;
  the chain simply had no rung that could ever match an adaptive-only source,
  which is what
  [`docs/design/research/research-youtubePlayback.md`](docs/design/research/research-youtubePlayback.md)
  had already documented YouTube as being. CI never caught it because the whole
  suite injects a stub downloader and the one live test required ffmpeg to be
  installed before it would run — so the branch that broke was the branch no test
  could reach.
  - **The ladder now ends in a video-only rung on every branch**
    (`companion/resolver/src/ytdlp.ts`). With ffmpeg and audio requested:
    `bv*[height<=?H]+ba/b[height<=?H]/bv*[height<=?H]/bv*+ba/b/bv*`. Without
    ffmpeg: `b[height<=?H]/bv*[height<=?H]/b/bv*` — no `+`, because nothing would
    be there to join the two streams. When the caller did not ask for audio at
    all (the Kraken panel has no speaker, so this is the common case):
    `bv*[height<=?H]/b[height<=?H]/bv*`, which needs no merge and therefore no
    ffmpeg. The invariant is a unit test in its own right: **no branch may
    terminate in a rung that requires a muxed format.**
  - **`upstream-failed` now says something a person can act on.** yt-dlp's text
    sends the reader to `--list-formats`, a flag this program does not have.
    `explainStderr` replaces the format failures — and only those — with a
    message naming ffmpeg as the likely cause; anything unrecognised is still
    passed through verbatim.

- **The companion installs ffmpeg for itself on Windows.** The ladder above stops
  the hard failure, but without ffmpeg the best YouTube can offer is one file —
  usually a silent video-only stream. A user who double-clicked an exe has no
  ffmpeg and no reason to want one, so the companion now finds it the way it
  already found yt-dlp: `--ffmpeg <path>`, then `PATH` (verified by running
  `ffmpeg -version`, not by checking for a file), then a cached copy, then a
  checksum-verified download of the static `win64-gpl` build from the yt-dlp
  FFmpeg-Builds release, extracted into `<cache-dir>/bin`
  (`companion/resolver/src/ffmpeg.ts`). Refused under `CI` and
  `KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1` like every other download, and **a failed
  install is a warning, not a failed resolve** — it degrades to the no-ffmpeg
  branch. macOS and Linux resolve from `--ffmpeg`/`PATH` only, deliberately: a
  package manager keeps ffmpeg patched and a blob in a cache directory does not.
  - Those builds ship as `.zip`, and `node:zlib` decompresses streams but knows
    nothing about ZIP's container, so `companion/resolver/src/unzip.ts` reads the
    central directory and inflates one entry — rather than take a runtime
    dependency on a package whose whole job is to unpack the file this program is
    about to execute. It refuses ZIP64, encryption, unknown compression methods
    and truncated archives, streams the 145 MB executable to disk instead of
    buffering it, and verifies each entry's CRC and declared length on the way
    out. Entry names are never turned into paths: the destination is named by the
    caller and entries are matched by exact suffix, so a crafted archive cannot
    write outside the cache directory.

- **The companion reported the page's resolution, not the one it downloaded.**
  `fetch` re-probed the URL after the download and returned _that_ metadata, so a
  resolve that had quietly fallen back to a lower rendition still answered
  `height: 1080`. It now asks yt-dlp to print the selected format's real
  dimensions once the file is in place (`--print after_move:…`, parsed by
  `parseDownloadMeta`), which also removes a second network round trip per
  resolve. `filepath` comes back the same way, so a merge that landed under a
  different extension is found instead of being reported as "yt-dlp produced no
  file".

- **The companion promised `video/mp4` for files that were not mp4.**
  `mime` was hard-coded on every fetch. `--merge-output-format mp4` governs
  _merges_ — a source whose only rendition is a WebM is written through
  untouched, under the `.mp4` name the cache minted. It is now read from the
  file's own magic bytes (`sniffContainerMime`), so the envelope, the cache
  record and `/stream`'s `Content-Type` cannot disagree with the bytes. Found by
  the live test the moment it was made to assert this rather than assume it: the
  Wikimedia fixture it has always used is one of these files.

- **The one live test that could have caught any of this never passed.** It was
  gated on ffmpeg being installed — which meant the no-ffmpeg branch, the one
  that broke, was unreachable by construction — and its opaque-id assertion
  checked `<id>.mp4` against a regex for `<id>`, so it could not have gone green
  even when run. Both fixed, and it gained a case that resolves all four rungs of
  the ladder against a real adaptive-only YouTube URL under `--simulate`, plus
  one that asserts **the selector that shipped still fails**, so the regression
  suite goes red if it ever stops proving anything.

- **The companion's cache-directory test only passed on the machine that wrote
  it.** `defaultCacheDir` assembles its answer with `node:path`'s `join`, which
  emits the **host's** separator no matter which platform it is asked about, so
  `companion/resolver/test/cli.test.ts`'s forward-slash literals and regexes
  failed the moment `companion-release.yml` first ran its checks on
  `windows-latest`. Every expectation in that block is now built with the same
  `join` (and the same `homedir`) the implementation uses, which asserts the
  whole path rather than a suffix and passes on macOS, Linux, and Windows alike.

- **Every pasted link looked like an error, and none of them were.** Reported
  verbatim as _“Any youtube or direct link I put in there just gives me an error
  saying it can't do it. Saying it can't do a cross origin read.”_ The display
  was playing all of them; what had broken was the story the home screen told
  about them. Three faults, all in the Halo redesign's step cards:
  - **The mirror was read as a queue.** `DownloadFlow` picked
    `entries.find(e => e.state !== 'done' && e.state !== 'aborted')` — which
    matches a **failed** entry — from a `kraken-hub:v1:video:downloads` ring that
    nothing prunes, and the entry was never checked against the URL that is
    actually configured. One CORS-less MP4 therefore poisoned every later paste
    for good: reproduced with three pastes in a row, where a YouTube link and a
    download that genuinely **succeeded** both rendered the first link's failure.
    `describeFlow()` in `src/app/config/homeState.ts` now keys the story on the
    configured URL (matching `sourceUrl` as well as `url`, so the resolver's
    loopback fetch is still filed under the link the user pasted), and is a pure
    function with its own tests.
  - **A browser `TypeError` was user-facing copy.** The failed step rendered
    `entry.error` — literally `Failed to fetch` — under “Saving to your Kraken”.
    A CORS refusal is a fact about the _server_, not a failure of playback: a
    plain `<video src>` needs no CORS at all, which is why `downloadManager`
    classifies it as `'cors'`, records `download-cors-blocked` at **warn**, and
    the display streams on. `DownloadEntry` now carries that `reason` (and its
    `sourceUrl`) across the mirror, so the config windows can tell an expected
    downgrade from a real fault. The terminal states are honest and never red:
    _“Streaming from the link — this server does not allow saving a copy”_, and
    the third step still lights, because the video **is** on screen.
  - **A YouTube link with no companion told no story at all.** It now gets an
    accent-toned card — _“Playing through YouTube”_ — that says a local copy is
    one program away, instead of leaving the best thing the app does undiscovered.
  - `src/app/config/views/LibraryView.tsx` spoke the same browser-error dialect
    in its “Downloading now” list; it now says _“streaming — this server does not
    allow saving a copy”_ for `reason === 'cors'`.
  - Pinned by `tests/e2e/paste-flow.spec.ts`: a YouTube link, a CORS-less MP4 and
    a CORS-clean MP4 (the last two served by real Node servers on real ports,
    because CORS is the whole subject), each asserting that the display reaches
    playback, that **no error card** appears, and that the step cards say the
    right terminal thing — plus the reported sequence, where a failure from an
    earlier link must not become the story of the next one.
  - `tests/e2e/companion.spec.ts` now types the URL into the home screen's paste
    box instead of seeding it into `localStorage`. Seeding it is how that suite
    stayed green through this regression.

- **MQTT never connected on real hardware: an ESM/CJS interop break the test
  suite structurally could not see.** The first hardware report from a Kraken
  Elite (CAM 4.76.5) logged, on every boot,
  `mqtt connect failed — trying the next transport` /
  `TypeError: (intermediate value).connect is not a function`. Sync silently
  demoted to ntfy and had presumably been doing so since MQTT shipped.
  - Cause: mqtt's `exports` map is condition-dependent. Node — and therefore
    vitest — takes `"default": "./build/index.js"`, real ESM with a **named**
    `connect`. A browser takes `"browser" → "import": "./dist/mqtt.esm.js"`,
    an esbuild bundle whose only export is `default`. Rolldown emits a chunk
    whose namespace is `{ default }` and nothing else, so
    `(await import('mqtt')).connect` is `undefined` in the one environment that
    ships. Verified by loading the built `assets/sync-mqtt-*.js` in Chromium:
    `Object.keys(ns)` is `['default']`, `ns.connect` is `undefined`,
    `ns.default.connect` is the function.
  - `src/sync/transports/MqttTransport.ts` now resolves through
    `resolveMqttConnect()` — `m.connect`, then `m.default?.connect`, then a
    callable `m.default` — and when nothing is callable throws an error that
    **names every shape it found** (`describeMqttModule()`), so the next
    bundler change produces a report instead of another bare `TypeError`.
  - `src/sync/transports/mqttInterop.test.ts` pins it two ways: against the
    **real** `mqtt` package imported exactly as the transport imports it, and
    against each synthetic namespace shape including the browser one node
    resolution can never produce. No broker is contacted.

- **YouTube was broken on the only device it exists for: player methods were
  called before `onReady`.** The same hardware report carried
  `source-unplayable: r?.mute is not a function` and
  `video/display mount failed`. `new YT.Player()` returns immediately, but the
  IFrame API only grafts `mute`, `playVideo`, `seekTo`, `getCurrentTime` … onto
  that object once the postMessage handshake completes — and `display.ts` calls
  `adapter.setMuted(true)` and `adapter.play()` the instant `mount()` resolves.
  Optional chaining did not help: `?.` guards a null receiver, not a missing
  method.
  - `src/modules/video/adapters/youtubeEmbed.adapter.ts` now has one gate. A
    `ready` flag flips only inside `onReady`; `live()` returns the player only
    past that point, and every externally-triggered call (`setMuted`, `play`,
    `hold`, `seek`, `setRate`) goes through `whenReady()`, which runs the call
    now or **queues it in order** and replays it from `onReady`. The rAF tick,
    the quality watchdog's signal read, `getBufferedEnd()` and the ladder
    remount all read through `live()`. `destroyPlayer()` clears the gate and
    the queue, so a queued seek is never replayed against the next player.
  - The embed URL already carries `mute=1`; the belt-and-braces `mute()` call
    now happens at the only moment it is callable.
  - **`tests/support/fakeYouTube.ts` was the reason this shipped**: it handed
    out working methods the moment the constructor ran, which no real player
    ever does. Every method now sits behind a getter that, before the fake fires
    ready, records `preready:<name>` and returns `undefined` — the real API's
    behaviour, TypeError and all. `readPrereadyCalls()` makes that assertable,
    and `tests/e2e/youtube.spec.ts` gains two regressions that assert **zero**
    player-method calls pre-ready and that the deferred calls still land. Both
    fail against the old adapter.

- **The configuration page could not scroll, so everything below the fold was
  unreachable.** `index.html`'s inline critical CSS pins `html`, `body` and
  `#root` to the viewport with `overflow: hidden` — mandatory for the display
  page, where a stray scroll on a 640×640 panel with no scrollbar and no input
  device is permanent and invisible. The lock leaked into config mode, and CAM's
  Configuration Browser is a small Electron window (866×537 measured), so the
  `#/diag` tab's display-report panel, its **Copy JSON** button and the version
  footer simply could not be reached. Every desktop viewport in the suite
  happened to fit the content, which is why nothing caught it.
  - `src/app/config/mount.tsx` now adds a `kh-config-mode` marker class to
    `<html>`, and `src/ui/ui.css` keys the unlock off it: `height: auto` and
    `overflow: visible` on the root chain, `min-height: 100dvh` on `#root` and
    `.kh-app`. `.kh-app`'s own `overflow-y: auto` goes back to `visible` in this
    mode — an inner scroll container with `height: auto` never scrolls, it only
    gives the page a second scroll root to fight with.
  - **The display path is byte-for-byte unchanged.** The class is added by the
    config mount and the rules ship in the config-ui chunk's stylesheet; the
    display page loads neither. `displayCriticalPath` and `displayGraph` (I8)
    are unaffected.
  - `.kh-shell`'s `min-height` moves from `100vh` to `100dvh`, so a phone on
    `#/remote` does not scroll by a URL-bar's worth when the content fits.
  - Regression cover in `tests/e2e/boot-config.spec.ts`: the config page at
    866×537 and the remote at 390×844 must scroll and must reach the footer,
    and the display page at 390×400 must stay pinned — `scrollHeight <=
clientHeight`, no `kh-config-mode` class, and a programmatic
    `window.scrollTo(0, 5000)` that leaves `scrollY` at 0.

- **A timed-out diagnostics re-request rendered a stale report as the answer.**
  The remote's Diagnostics card gated the report on `diag !== null`, so after a
  second pull timed out the error Notice and the _first_ pull's report sat on
  screen together under an unqualified "captured 14:02" chip — a dead display
  reading as a healthy one, which is the exact failure `diagPhase()` was
  extracted to prevent. The report deliberately stays on screen (dropping it
  would take the Copy JSON button with it), but the new
  `diagReportFreshness()` in `src/diag/wire.ts` marks it: the chip turns
  `warn` and reads "stale — from an earlier request", and the timeout Notice
  says so in words. Unit cover in `src/diag/wire.test.ts`.

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
- **The six curated text faces are real fonts now.** `fonts.ts` has always
  injected `fonts/<id>.css` on first use, but nothing was ever there to fetch, so
  every curated face silently resolved to its fallback stack — a feature that
  looked shipped and was not. The latin `woff2` subsets are vendored into
  `public/fonts/`: Anton (`display`, 18.6 kB), Playfair Display (`serif`,
  38.4 kB), JetBrains Mono (`mono`, 31.4 kB), Quicksand (`rounded`, 28.2 kB),
  Oswald (`condensed`, 21.5 kB) and Pacifico (`script`, 32.3 kB), each with one
  `@font-face` — `font-display: swap`, latin `unicode-range`, a sibling
  `url('./…')`. Four ship as a single variable file spanning the weights the
  panel offers, which beats two statics; the two single-weight families ship one
  static. The display still fetches nothing until a text layer is actually set to
  a face, so invariants 4 and 8 hold with no new host: the files were taken from
  the Google Fonts API once and committed, and `base: './'` plus Vite's verbatim
  `public/` copy makes the document-relative href resolve at a project page, a
  user page, a custom domain and `127.0.0.1` alike. All six are SIL OFL 1.1;
  each family's upstream `OFL.txt` sits beside its font and the new
  `THIRD-PARTY-NOTICES.md` carries the copyright lines. `fontAssets.test.ts`
  holds the contract: a stylesheet per curated id, `wOF2` magic bytes on every
  referenced file, ≤ 40 kB per face, latin only, and a licence entry per family;
  and the 198 kB the six faces and their licences add to `dist`, together with
  the 16 kB of gallery looks, is why `budgets.json`'s `totalDistMb` moved from
  10.0 to 10.6 — both are lazily fetched and neither is on any critical path.

- **The display composites a look, not a module.** `ModuleHost` — one renderer,
  mounted into one div, torn down and rebuilt every time you switched what the
  panel showed — is replaced by `src/render/LayerHost.ts`: a framework-free
  compositor that puts one absolutely-positioned host per ON layer under
  `.kh-stage`, in array order, and lets Chromium do the stacking. DOM order **is**
  z-order; there is no `z-index` and the invariant script fails the build on one.
  It reconciles by layer id rather than by position, so the cost of a change is
  the change: a transform is one style write and zero renderer calls, a frame
  change is one `geometry()`, a config change is `update()` and not a remount,
  and only a _kind_ change on the same id remounts. The base host is created once
  and never detached — re-inserting an `<iframe>` re-navigates it, so a YouTube
  embed would reload and lose its position, which is the same fact that makes
  video base-only. Every layer's box, and its own `--kh-w/--kh-h/--kh-r/
--kh-safe/--kh-inscribed`, come from `src/render/layerBox.ts`, shared verbatim
  with the editor and the phone so the halo and the LCD cannot disagree. One
  frame-clock subscription feeds the whole stack in array order with per-layer
  p95 kept in closure state (invariant I4), and `src/render/layerGovernor.ts`
  moves it between `full → reduced → hz1` on ten-second/thirty-second hysteresis,
  calling each renderer's `budget()` and **never hiding, removing or unmounting a
  layer** — a panel that silently drops the overlay you added is a panel you
  cannot trust. `src/render/lookOf.ts` is the seam to the document and it is
  total: a state with no `look` field, or a corrupt one, still yields the
  base-only look the display has always drawn, so nothing here waits on the
  schema bump. Today's single-module display is byte-for-byte what it was — the
  same `.kh-stage__module[data-module]` div, the same `ctx.geometry()` object by
  identity — and `?diag=1&pattern=stack` now measures the shipping compositor
  rather than a throwaway spike, which is what keeps the H24–H28 numbers honest.
  One thing the old host answered by accident had to be said out loud: it
  registered `runtime.onCommand` only once its renderer had mounted, so "there
  is a handler" meant "there is something that can act", and the retained
  position waited on that. The compositor's handler is installed with the stage
  and outlives every renderer, so `command()` now RETURNS whether a live
  renderer took it and `display/sync.ts` waits on that answer — re-anchoring the
  position on each attempt rather than replaying the one the snapshot arrived
  with, which is what makes a cold display resume where it left off instead of
  starting from zero.

- **Stats grew five faces, and learned to move.** `single` leads with one hero
  number inside one thin arc; `dual` is two heroes on **one ring**, as mirrored
  half-arcs, because that is the shape a round panel actually has; `triple`
  nests three rings around a small centre reading; `grid` is unchanged and
  text-first; `strip` is the overlay band, restyled into the same language with
  its DOM contract intact. Arcs are 2–3 % of their own diameter with rounded
  ends and a recessive track, drawn against `pathLength="100"` so no frame
  computes a circumference. Three type sizes per face, tabular figures
  throughout, and every size a fraction of the frame the layer was given — one
  design at the full panel, at a 0.6 overlay and at the smallest device preset.
  Each meter can carry a **sparkline**: the last 60 s at the feed's own 1 Hz,
  one 2 px line with an emphasised endpoint and no axis, no gridlines, no
  labels.
- **Values glide; they never chunk.** Every reading now passes through one tween
  per metric (`src/modules/stats/tween.ts`) in the value's own scale, advanced by
  the shared frame clock — ~420 ms, monotone, incapable of overshooting, and
  frame-rate independent, so it takes the same wall-clock time at 1 fps and at 40. The digits are re-derived from the tweened number each frame, so an integer
  readout steps one at a time in a tabular face and never jitters its width, and
  the arc lengthens with it. This is CHEAPER than the step it replaced: a
  once-a-second jump moves every arc and every digit at once, which is the most
  expensive thing a static face can hand CAM's compressor, and `frame()` returns
  on a boolean once every tween has settled — which is most frames. The module
  honours the governor's `budget()` (`reduced` = 10 Hz, `hz1` = snap to the
  sample with no glide) and `prefers-reduced-motion`, and still declares
  `cadence: 'tick'`, because the change it can produce is still capped by a 1 Hz
  feed.
- **A colour never travels without its word.** Per-metric warm points (CPU and
  GPU 80/90 °C, liquid 40/45, all editable behind the panel's one Advanced door
  and all stored in Celsius so flipping °C/°F cannot move the alarm) shift the
  arc AND show `Warm` or `Hot` in a chip beside the number — never colour alone.
  Load, RAM and fan speed deliberately have no warm point: a CPU at 100 % is a
  CPU doing its job, and spending the one alarming colour there teaches the
  reader to ignore it on the meter that matters. The digits stay in ink at every
  state, because text wears text colours and never the series colour; one accent
  hue carries magnitude, and the semantic pair is the same in all five palettes.
  Nothing here invents a pump RPM — CAM has none — and a sensor that is not
  reporting still reads `--` with its unit dropped and its arc hidden, because an
  arc at zero is a measurement of zero.

### Changed

- **State schema 7: the arrangement is in the document.** The panel used to be
  described by a single field — `activeModuleId`, one module, whole screen — and
  every window in the app had to agree about it by agreeing about that one
  string. The document now carries a **`look`**: an ordered list of layers,
  bottom first, where `layers[0]` is the base (whole panel, identity transform,
  no config of its own — it wears `modules[kind].cfg`, so switching away and back
  never loses a setting) and everything above it is an overlay carrying its own.
  One arrangement, one home, shared by the display, the config page and the
  phone.

  The 6 → 7 migration is the boring kind on purpose: whatever module a v6
  document named becomes that document's base, and nothing else moves — the
  `modules` map is left exactly as it was, because it was always the per-kind
  bank rather than a description of the screen. It is **deterministic**, down to
  the layer id, because both CAM browsers migrate the same retained snapshot
  independently and a generated id would leave last-writer-wins picking one of
  them at random. It is total: an active module that is missing, misspelt or not
  a string at all still produces a base that renders.

  Reading a look is now a repair rather than a gamble. The document validator
  runs the look through the same total, idempotent `validateLook` the model
  ships, so a corrupt stack degrades to base-only instead of failing the load; a
  ninth layer is dropped from the tail with a note (eight is the cap, and the
  editor refuses the ninth long before it can be written); an oversized look is
  **noted and kept whole**, because silently deleting somebody's overlay for
  being verbose is data loss rather than recovery. No cap ever truncates a layer.

  `activeModuleId` is still there, and still what the home chips, the library
  tiles, the paste flow, the phone and `?module=` write. For this release it is
  the mirrored write path: the validator keeps it and the base kind in lockstep
  (a module switch moves the base and leaves the overlays standing, which is
  exactly what switching the base should do), while readers take the answer from
  the base through `selectBaseKind`. The release that moves those writers onto
  the editor's own operations is the release that deletes the field.

- **W7 integration — the three new kinds joined up to the machinery that was
  already there.** Text, Shape and Effects shipped as modules; this is the round
  that connected them to the chunker, the URL table, the diagnostics and the
  documents, and that removed the scaffolding they made redundant.

  **Chunking.** `module-text`, `module-shape` and `module-effect` are now three
  named vite groups at priority 92, mirroring `module-clock` and `module-stats`
  exactly. The tests match a module directory's DIRECT children only
  (`[^/\\]*\.ts$`), which is what keeps the twelve GLSL sources under
  `src/modules/effect/effects/` OUT of `module-effect` — each stays its own lazy
  chunk (0.5–1.1 kB gzip), so a panel downloads the ~1 kB for the effect it is
  showing rather than ~19 kB for twelve. Measured on the emitted bundle:
  `module-text` 0.98 kB, `module-shape` 1.10 kB, `module-effect` 4.26 kB gzip,
  against a 25 kB per-module budget. The eager manifests stay in `core` and every
  one of the three is reached only through `core`'s dynamic imports, exactly as
  the other four modules are.

  **`src/modules/effect/manifest.ts` → `index.ts`**, so all seven modules are
  imported by directory. No behaviour change.

  **`?effect=<id>`** joins `?face=` and `?layout=` as a module-scoped URL
  parameter: kept raw by the table, validated by the module. There is
  deliberately **no `?preset=`** — a preset is a palette, the palette table is
  lazy so that twelve materials sets stay off the LCD's critical path, and a
  parameter the eager manifest could record but never paint would be a lie. The
  table reports it as unknown instead. Switching effect from a URL also sets
  `preset` to `custom`, because the colours that come across are the user's, not
  the new effect's material, and the label should not claim otherwise.

  **The W0 stand-ins are gone.** `?pattern=stack`'s five diagnostic stacks were
  built on two throwaway kinds — a 2D-canvas gradient called `plasma` and a bare
  DOM node called `label` — because `effect` and `text` did not exist. They now
  run on the real modules through the real registry: `effect` in its Lava lamp /
  Classic preset for the frame-cadence GPU base, `text` on the `system` face for
  the free static overlay. Same stack ids, same layer ids, same boxes, same
  translucency, same surface counts, and the text is laid out at the font size
  the stand-in used, so a run against this build is comparable with the recorded
  W0 tables — which are marked as due a re-run, since the numbers in them were
  taken with the stand-ins in place. `stack.dom.test.ts` now asserts that every
  kind in every stack is a registered module and that the two stand-in ids
  resolve to nothing.

  **Documents.** `docs/README.md` and the README's document table index
  `docs/effects.md` and `docs/modules-text-shape.md`; `docs/modules.md` points at
  both; the README's module table is seven rows and says plainly that the three
  new ones are layer kinds and that the visual editor for arranging them is the
  next wave, not this one. `design-layers-architecture.md` §7.2 gains a
  correction: the spec's worked examples "≈ 1.01" and "≈ 0.61" compute to
  **1.0009** and **0.6009** under its own constants — a stats strip is
  `0.05 × (0.3 × 0.2) × 0.3 = 0.0009` — so the point they make is a stronger one
  than the rounded figures suggested, and nobody has to chase the difference.

  **Known, and not fixed here:** `displayCriticalPath` measures **93.8 kB gzip**
  against its 90 kB gate, breached when W3 added `render-shared` to the counted
  chunks. The budget was NOT loosened. `vendor-react` is 57.5 kB of it and `core`
  25.7 kB; `display-shell` is 5.8, `render-shared` 4.2 and `index` 0.6.

- **Looks became files, and the gallery became a folder.** A Look — one saved
  arrangement of layers — now has a written format, ten shipped Templates, and a
  curated gallery that is a directory in this repository rather than a service
  somebody has to run.

  **The file.** `src/state/look/file.ts` defines `.krakenlook`: `format`,
  `version`, `name`/`author`/`description`/`createdAt`, the `look` itself, the
  base layer's `configs` — the base wears the per-kind bank, so a file carrying
  only `look` would be a Look with its main setting missing — and `media`, which
  is a table of **references** and never bytes. Four functions: `exportLook`
  (document → file, lifting local `kraken-hub-clip:` / `kraken-hub-image:` refs
  out of the settings, because an id names a row in one machine's storage),
  `parseLookFile` (bytes → file, total), `resolveMedia` (file + this machine's
  library → what can be shown) and `applyLookFile` (→ the document patch, so an
  import is one commit and one undo step). `serializeLookFile` sorts keys at
  every depth and indents by two, and export → import → export is asserted
  byte-identical: the files are diffed in pull requests, and a re-serialisation
  that moved a key would bury a real edit.

  **Two caps, because they are two objects.** `MAX_LOOK_BYTES` (3072) is the
  cap on the look inside a _document_, and it is a wire budget — `look` rides
  every 8 kB sync envelope. A _file_ also carries the config bank, the media
  table and the metadata a gallery card needs, so it gets its own number:
  `MAX_LOOK_FILE_BYTES`, **64 kB**. One number could not have served both
  without either refusing legal files or admitting looks the wire cannot carry.

  **The importer never rejects on an optional field.** There are exactly five
  refusals — not JSON, not an object, not this format, over the cap, and written
  by a _newer_ build (guessing at a file from the future is how you lose
  somebody's work). Everything else is repaired and noted. An older file is
  stepped forward by the **document migration**, run on a minimal wrapper
  document, rather than by a second ladder maintained in the importer: a second
  ladder is how a v6 file ends up migrated one way by the importer and another
  way by the store, with only one of them fixture-tested.

  **Missing media is data, not an exception.** Each reference resolves three
  ways — already in the library (the local copy wins, so it plays with the
  network unplugged), a URL anybody can fetch (kept as the source), or neither,
  which empties the source and records a `LookPlaceholder` naming the layer and
  the file. The layer is kept and is not switched off: the Look somebody
  imported is the Look they get, with a visible hole and a sentence about it.

  **Layer ids are kept on import, not re-minted.** A Look replaces the whole
  stack, so there is nothing to collide with — and keeping them makes an import
  deterministic, which is the same argument the 6 → 7 migration makes about its
  own base id. Two CAM browsers importing the same file must not end up with
  stacks that differ by a generated id, because last-writer-wins would then pick
  one at random.

  **Ten Templates** (`src/state/look/templates.ts`), against the parity floor of
  eight: _Single_, _Dual_, _Triple_, _Overlay_, _Lava lamp + temps_, _Nebula
  clock_, _Minimal clock_, _Sunset loop + clock_, _Photo + date_, _Focus_. Their
  configs are deliberately **partial** — a template names the settings it is
  about and each module's `validate()` fills the rest, which is both how every
  stored config already works and what keeps an overlay's settings from spending
  a third of the wire budget restating `thresholds.cpu.warm = 80`. The drift
  guard asserts that every field a template _sets_ survives its module's
  validator **unchanged**, and that each effect palette IS the preset it names,
  via the catalogue's own `matchPreset`. A renamed layout or a repainted
  material fails with the template's name in the message.

  Not one template references a picture or a clip. The repository ships no video
  and no photograph, and a template pointing at somebody's server is a template
  that breaks when the link rots — so _Sunset loop + clock_ and _Photo + date_
  ship with an empty source and say so in their descriptions.

  **The gallery is a folder.** `looks/` holds the same ten Looks as
  `<id>.krakenlook` files plus an `index.json` catalogue, and a test asserts the
  files equal the in-code templates byte for byte and that the index lists
  exactly the files present — so a pull request that edits one and not the other
  fails rather than shipping a gallery that disagrees with the app. No backend,
  no accounts, no tracking: a submission is a pull request adding one file and
  one row, and `looks/README.md` has the steps and the review rules (MIT, no
  media nobody else can fetch, the product's vocabulary, the size cap). There is
  a **Share a Look** issue template for people who would rather not open one.

  **Documents.** `docs/looks.md` — what a Look is, what the file carries, what
  import does with a picture it cannot find, and an honest list of what is not
  built yet.

  **Deliberately absent:** `carousel?: { lookIds, intervalSec }`. It is on the
  parity checklist and it is a later wave; a field nothing writes and nothing
  reads is a field that will be wrong by the time something does.

  **Not wired yet:** the Looks menu, the template grid with live previews and
  the import/export buttons. This wave is the format, the templates and the
  gallery's data — all pure, all tested. The surface that puts them on screen
  binds to `exportLook` / `parseLookFile` / `resolveMedia` / `applyLookFile`.

- **The home screen is a layer editor** (W5, `docs/design/design-editor-ux.md`).

  **The canvas is the halo.** At CAM's window the home screen is two columns: a
  real `LayerHost` on the left, running the real display renderers at the
  biggest size the window allows, and the layer rail on the right. It is the
  same compositor, the same `render/layerBox.ts` maths and the same modules the
  LCD runs — which is what makes "what you drag is what the panel shows" a fact
  rather than a hope. One kind is swapped: `video` renders a poster and a live
  position arc (`editor/videoStandIn.ts`), because a second decoder on this
  origin is a second download on somebody's battery and a cross-origin YouTube
  `<iframe>` cannot be sampled at all. Stats layers read the display's telemetry
  when there is a display, and the simulator's own generator otherwise —
  labelled _sample data_, through the claims spine, because a temperature gauge
  showing made-up numbers without saying so is the one thing a cooler app must
  never do.

  **The strip is declared, not branched.** `KrakenModule.editor.strip` is a new
  contract: at most five controls, `More` always last, rendered generically from
  small typed descriptors. All seven modules declare one. The `OpsStrip` it
  replaces was a chain of `if (activeId === 'clock')` cases that knew four
  modules by name — so text, shape and effect, which shipped after it, had no
  strip at all. `registry.test.ts` now enumerates the rule over every registered
  kind, including that every declared path resolves against the module's own
  defaults, so a kind added next year arrives with its own strip or fails CI.

  **Direct manipulation.** Editing overlays are a separate SVG above the mirror
  (never inside the display bundle, I8): a selection box, four corner handles and
  a rotate lollipop at ≥ 24 px (44 on touch), guides only while dragging, a
  marquee, and a HUD that reads upright whatever the layer is doing. A drag is
  one `style.transform` write per pointer event and ONE history entry — React
  hears about it once, on release, when the layer springs to rest on the frame
  clock (I4). Rotation ticks moved to every 15°: the architecture spec said
  `0/±45/±90/180` and the UX spec said `0/15/45/90`, and the tie-break the two
  documents agree on is that the UX document wins on behaviour.

  **Smart placement, undo, the budget meter.** A new layer lands in the first
  free slot rather than in the middle of the pile (`editor/placement.ts`, and a
  property test that adds six and asserts none overlaps). Undo is fifty steps,
  from the buttons or the keyboard, anywhere on the page, and it survives a base
  switch — asserted by a property test over 120 random ten-op walks, run twice:
  once against the pure model and once through the real store, because the
  origin mapping in the binding is where "the caller's own edit is recorded
  twice" would live. The meter reads the display's achieved frame rate when
  there is one and `lookCost()` otherwise, and says which — three new claims in
  `panelClaims.ts`, so the estimate can never be printed in the present tense.

  **One write path for the base kind.** `activeModuleId` and
  `look.layers[0].kind` are two spellings of one fact and the validator mirrors
  the first onto the second for one release; a commit that wrote only one of
  them was either wrong now or wrong later, and there were twenty-one of them.
  They all go through `src/app/state/switchBase.ts` now, and a grep test in the
  shape of the vocabulary spine fails the build on a direct write anywhere in
  `src/app/**`.

  **Absorbed from the stats redesign:** the five faces are the strip's face
  picker, including `strip` — until now the overlay face was reachable only by
  adding a stats overlay and not touching the layout control. The missing-reading
  placeholder is an em dash rather than `--`, which read as a minus sign next to
  a temperature.

  **The canvas is sized by the layout engine, and it was 14 px.** The halo asked
  for `min(100%, calc(100dvh - --kh-ed-chrome))` in a start-aligned, auto-sized
  grid row inside a shrink-to-fit flex column: the percentages had nothing to
  resolve against and collapsed to the two 7 px bezel walls, and the constant
  they fell back on was 130 px against 199 px of real chrome. The editor is a
  definite-height screen now — the shell is `100dvh` for this view, the canvas is
  the grid's one `minmax(0, 1fr)` row, and the halo's side is literally
  `min(the column, the row)` (`cqw`/`cqh` off a size container), so no constant
  can go stale. The selection strip floats over the canvas and the status line
  takes the rail's slack, which is what makes a 400 px halo fit at all — and what
  keeps a 131 px Stats strip from resizing the canvas it is a strip for. Measured
  at 866×537: 415 px, round, handles at exactly 24, nothing clipped and nothing
  past the fold in any state (the add sheet is now the rail's own column and
  scrolls inside itself, rather than opening 7 px below the fold).

  **Not built, deliberately:** the editor on a phone (W6 — a phone gets the
  remote, and `data-editor="false"` is asserted at 390 px), look files and the
  designed-template grid (W8's data landed alongside this; the Looks menu shows
  base-only Looks derived from the registry until the two are wired), a per-layer
  lock (the model has no field for one, and inventing one is a schema decision),
  and align/distribute for multi-select.

  **Unverified:** `tests/e2e/editor.spec.ts` is written and was NOT run — the
  Playwright config pins its web server to port 4173 and a `dist/` build with no
  environment override, and another agent held both. Every measured assertion in
  this wave (the ≥ 400 px halo, the ≥ 24 px handles, page-fit across the editor
  states) lives in that file.

- **The Effects module says which GL it got, and its panel stopped wasting the
  panel.** Two findings that share a module and nothing else.

  **H29 had nothing to read.** `display.ts` picks WebGL2, falls back to WebGL1
  with a translated program, and falls back again to a CSS still frame — and
  until now nothing observable said which of the three a given panel had taken.
  The diagnostics report could say what the webview _offers_
  (`capabilities.features.webgl2`), never what this instance _got_, so the
  hardware row was written as "there is no data attribute on the effect host".
  Now there is: **`data-gl`** on the effect's root is `webgl2`, `webgl1` or
  `none`, and **`data-gl-lost="true"`** is present only while a context is lost
  and waiting to be rebuilt. It records the renderer that is RUNNING rather than
  the one that was asked for — a granted context whose program will not link
  reads `none`, because the still gradient is what a person is looking at — and
  it follows the context through hide/free, restore and reinit. `DisplayRenderer`
  has no status or telemetry hook to mirror it through, so the element is the
  whole surface; `src/diag` reads platform probes and the log ring and no module
  state at all, so nothing there changed. `display.dom.test.ts` covers all four
  rungs: jsdom (no GL) is `none`, a stubbed `getContext` that answers only
  `webgl2` is `webgl2`, only `webgl` is `webgl1`, and a dispatched
  `webglcontextlost` / `webglcontextrestored` pair walks the attribute down and
  back. H29's "how to measure" and its record row now name the attribute.

  **The settings panel gave the width away.** Audit 9's M6 photographed four
  colour wells stacked in a column against the right margin with ~590 px of dead
  space beside the word "Colours", and the twelve-card effect strip cut off
  mid-card at the panel's edge with nothing to say six more effects were behind
  it. One cause for both: `.kh-field` is a label on the left and a control on the
  right — correct for a switch, wrong for anything that wants the room — and both
  of these were sized as ordinary flex items in that row. Both take
  `flex: 1 0 100%` now and drop under their own label. The colours are a wrapping
  row of labelled wells with the slot name captioned _under_ each swatch (four
  across at 866, four at 560, wrapping below that), which took 168 px off the
  panel's height at CAM's window. The strip is a real horizontal scroller: the
  fade at its edge is a `mask-image` (background-agnostic, because this panel has
  two backgrounds) driven by a **measured** `data-more`, so it appears at
  whichever end genuinely has more behind it and at neither end when the row
  fits, and `scroll-padding-inline` keeps a focused card clear of it. The roving
  tabindex now actually roves — an arrow key moves the focus and the scroll with
  the selection, where before the selection walked off-screen and the focus ring
  stayed where it started. The panel's first row is still the editor's strip
  (effect · preset · colours · reacts-to-temp) with everything else behind the one
  Advanced door, the only native control is still the colour input, and a new
  `ConfigPanel.test.tsx` pins all of that plus the vocabulary spine — the word is
  **effect**, and the panel renders no technical synonym for one.

[unreleased]: https://github.com/ubberkid/kraken-hub/commits/main
