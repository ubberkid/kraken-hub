# Text and Shape — the two overlay-first layer kinds

Wave W7. Two kinds that exist to sit **on** something else: a line of words, and
a flat ground. Everything general about writing a module is in
[`docs/modules.md`](modules.md); this file is only what is particular to these
two, and it is here so the decisions that are easy to get wrong are written down
next to the reason they were made.

- [`src/modules/text/`](../src/modules/text/) — `text`, overlay only
- [`src/modules/shape/`](../src/modules/shape/) — `shape`, base or overlay

Both are `motionLevel: 'static'` and both declare `cost().cadence === 'static'`,
which the registry conformance suite checks agree. Neither implements `frame()`:
nothing in either kind changes over time, so a frame tick would be a call that
does nothing forty times a second.

---

## 1. Placement

The rows come straight from
[`design-layers-architecture.md`](design/design-layers-architecture.md) §1.4's
table, and the manifests are where they are now written down:

| kind    | roles         | max          | resize    | minFrame | overlayDefault                    | cost(defaults)   |
| ------- | ------------- | ------------ | --------- | -------- | --------------------------------- | ---------------- |
| `text`  | overlay       | `MAX_LAYERS` | `'frame'` | 0.2      | `{w:1.2,h:0.3,square}` @ (0,−0.6) | static · 1 · low |
| `shape` | base, overlay | `MAX_LAYERS` | `'scale'` | 0.1      | `{w:1.6,h:0.5,square}` @ (0, 0.6) | static · 1 · low |

**Text is overlay-only.** A full-panel base made of one line of text is a look
nobody composes, and a kind that can be the base has to answer "what does it do
with the whole panel" for the editor, the picker and the legacy single-module
path. Text is a thing you put on something.

**Shape can be the base**, because a full-panel rectangle is exactly the "solid
base" of [`design-editor-ux.md`](design/design-editor-ux.md) §10 — the flat
ground a clock and a caption sit on.

**The two `resize` values are not a style choice.** `'frame'` re-lays out at the
new size and `'scale'` is one style write (§3.2). Text re-lays out because glyphs
scaled by the compositor are soft and glyphs laid out at the new size are crisp.
A shape is vector all the way down, so scaling it is free and produces the same
pixels; there is nothing to buy by re-laying it out.

---

## 2. Text

### 2.1 The one rule: how `size` becomes a font size

```
fontPx = min(size × hostW, hostH × LINE_CAP)      LINE_CAP = 0.82
```

Read it as: **`size` is the share of its box's WIDTH that one em of type claims,
never taller than the box.** Width, because a line of text runs along the width
and a text layer's default frame is wide and short — a banner. The `LINE_CAP`
term stops a nearly square box from producing type taller than the box holding
it; the clock's digital face caps its digits the same way.

The rule is a function of the BOX and of nothing else, so it is identical on a
640 round Elite and a 240 square Kraken: the box is in unit-radius diameters and
the panel only ever enters through `radiusPx`. `size.test.ts` pins it at every
device preset, with the boxes DERIVED from the preset table and the module's own
`overlayDefault` — a device dimension typed into a test is invariant 5 wearing a
green tick.

The box itself comes from a `ResizeObserver` on the host (the compositor's own
div), with the geometry the shell reports as the fallback for the first paint
and for any environment without an observer. jsdom is one such environment,
which is why the renderer must never depend on a real layout to be correct.

### 2.2 Fonts: system plus six, fetched only on use

`design-editor-ux.md` §10 asks for "system + 6 curated faces loaded lazily only
when a layer uses them", and the word doing the work is **only**.
[`src/ui/ui.css`](../src/ui/ui.css)'s header states the app's position outright:
the shipped app loads no webfont, because a font request is a network dependency
on a page that must work offline. A text layer set to `system` — the default, and
what every existing look wears — therefore costs the display zero requests, and
the way that is guaranteed is that the request is made by a function
(`fonts.ts → ensureFontLoaded`) which takes the face id as an argument and is
never called with anything else. There is no `@font-face` in any stylesheet and
no `<link>` in `index.html`.

The seven ids are **roles, not family names** — `serif`, not `playfair`. A face
can be swapped for a better-licensed or better-hinted one without rewriting every
stored config and every synced look, which is exactly what carrying the family
name on the wire would have cost.

| id          | family           | fallback stack                            |
| ----------- | ---------------- | ----------------------------------------- |
| `system`    | —                | `system-ui, -apple-system, 'Segoe UI', …` |
| `display`   | Anton            | Impact, Arial Narrow Bold, system         |
| `serif`     | Playfair Display | Georgia, Times New Roman, serif           |
| `mono`      | JetBrains Mono   | ui-monospace, SFMono-Regular, Menlo       |
| `rounded`   | Quicksand        | Trebuchet MS, Verdana, system             |
| `condensed` | Oswald           | Arial Narrow, system                      |
| `script`    | Pacifico         | Segoe Script, Brush Script MT, cursive    |

**Where the stylesheet comes from.** The injected `<link>` points at a
DOCUMENT-RELATIVE `fonts/<id>.css` — never an absolute URL, never a CDN. Two
invariants require that and both are enforced by lint: invariant 4 (no
hardcoded origins; `src/config/knownHosts.ts` is the only file allowed to name an
external host) and invariant 8 (nothing from a CDN, because the strict CSP and
the offline demo depend on it). A `fonts.googleapis.com` link would breach both.

A stylesheet that does not arrive is not an error card: the face resolves to its
fallback stack, the panel still renders readable text of the right character, and
the layer never blanks. That is why every curated face names a real fallback and
why a test asserts it does.

**The vendored files.** All six faces now live in `public/fonts/`, taken once
from the Google Fonts CSS API and committed — the display contacts no font host,
ever. Vite copies `public/` verbatim into `dist/` and `base: './'` makes
`fonts/<id>.css` resolve at a project page, a user page, a custom domain and
`127.0.0.1` alike.

| id          | family           | file                       | bytes  | licence |
| ----------- | ---------------- | -------------------------- | ------ | ------- |
| `display`   | Anton            | `display-400.woff2`        | 18,612 | OFL 1.1 |
| `serif`     | Playfair Display | `serif-variable.woff2`     | 38,404 | OFL 1.1 |
| `mono`      | JetBrains Mono   | `mono-variable.woff2`      | 31,432 | OFL 1.1 |
| `rounded`   | Quicksand        | `rounded-variable.woff2`   | 28,244 | OFL 1.1 |
| `condensed` | Oswald           | `condensed-variable.woff2` | 21,472 | OFL 1.1 |
| `script`    | Pacifico         | `script-400.woff2`         | 32,280 | OFL 1.1 |

Latin subset only, `woff2` only, `font-display: swap`. Four faces ship as one
variable file covering the whole weight range the app offers (400/600/800, or
400/600/700 where the family stops at 700), which is smaller than two statics
would be; Anton and Pacifico have one weight and ship as one static. Each
family's `OFL.txt` sits beside its font in `public/fonts/<id>/`, and
[`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) carries the copyright
lines.

**Adding or swapping a face.** Add the id to `TEXT_FONTS`/`CURATED_FONTS` and a
`TEXT_FACES` entry whose stack leads with the family name; drop the latin `woff2`
into `public/fonts/` and write `public/fonts/<id>.css` with one `@font-face`
(swap, latin `unicode-range`, `url('./<file>')`); vendor the family's `OFL.txt`
under `public/fonts/<id>/`; add a row to `THIRD-PARTY-NOTICES.md`. The licence
must be OFL 1.1 or Apache 2.0 and the face must stay under 40 kB —
`fontAssets.test.ts` enforces all of that, including the `wOF2` magic bytes, so a
face that is really a 404 page fails the suite rather than the panel.

### 2.3 The panel

`design-editor-ux.md` §2.3 fixes the selection strip for a Text layer:
**text · size · colour · font · More**. The panel's first row is that row, in
that order, so the two surfaces are one set of options rather than two that can
drift. Weight, alignment, tracking, uppercase and shadow are behind the single
`Advanced` door `ModuleOptions` owns.

The colour well is a native `<input type="color">` and it is the only native
control on the surface. That is not a hole in the round-2 rule: what round 2
deleted was every native _picker of sentences_, and its replacement is
`Segmented`. A colour is not an enumeration and cannot be one.

---

## 3. Shape

### 3.1 Four primitives

`rect`, `circle`, `line`, `ring` — a scrim behind text, a badge behind a number,
a divider, and a bezel ring. Anything more elaborate is a picture, and there is
already a module that paints pictures.

`ring` and `line` **are** their stroke, so two rules keep them from vanishing:
with `stroke: 'none'` they draw with the fill colour instead, and a stroke width
of zero is floored. An invisible layer on a panel with no cursor is a layer
nobody can find again to fix.

### 3.2 The viewBox rule

`svg.ts` is pure — one config plus one box in, one `<svg>` string out — which is
what makes the whole geometry a table-driven node test rather than something you
have to boot a panel to check.

```
viewBox="0 0 W H"    W, H = the host's own measured pixels
<svg width="100%" height="100%">
```

One user unit is one CSS pixel. So nothing is ever distorted — a circle is a
circle in a wide box, not the ellipse a fixed square viewBox with
`preserveAspectRatio="none"` would have produced — a stroke is the width it says
it is on both axes, and the shape still scales crisply when the compositor scales
the host.

Every length in the config (`strokeWidth`, `radius`) is a fraction of the box's
**short edge**, so a shape keeps its proportions when its frame changes aspect.

`innerHTML` rather than `createElementNS`, exactly as the clock's dial does it:
the HTML parser puts `<svg>` in the SVG namespace by itself, so the renderer
never has to name the namespace URI — a string invariant 4's origin rule cannot
tell from a real origin. Everything interpolated into that markup has been
through `validateShape()` and is a hex colour, the literal `none`, or a number.

### 3.3 The panel

The strip is **shape · fill · stroke · More**. A paint is _one_ control, not two:
"no fill" is a value of the fill setting, so the `None` segment and the colour
well live in one field and the well simply is not there when there is nothing to
pick. Fill opacity, stroke width, corner radius and dash are behind the door; the
corner slider is disabled for a shape that has no corners rather than pretending.

---

## 4. Tests and budgets

Both kinds are covered by the registry conformance suite (id, metadata,
`validate()` totality and idempotence, placement validity, `motionLevel` ↔
`cadence` agreement) plus, per kind: a table-driven `validate()` suite, a pure
geometry suite (`size.test.ts` / `svg.test.ts`), a renderer suite in jsdom, a
panel suite that pins the strip order and the no-native-controls rule, and
`text/copy.test.ts`, which reads both modules' sources for retired phrasings,
machine nouns, hand-rolled native controls and device-size literals.

Both kinds are weighed by `npm run size`: `vite.config.ts` carries a
`module-text` and a `module-shape` chunk group beside the others, and
`budgets.json` needs no entry for either — `perModuleChunk` is matched by the
`^module-` pattern and its 25 kB cap already governs every module chunk.

The font assets are done too: §2.2 lists what shipped and `fontAssets.test.ts`
holds the budget.
