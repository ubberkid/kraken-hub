# Icon and Date — the two parity overlays

The `design-editor-ux.md` §10 checklist names **Icon**, **Date** and **Solid
base** among the kinds that must exist. Two of those are modules and one is a
config; this file is what is particular to all three. Everything general about
writing a module is in [`docs/modules.md`](modules.md).

- [`src/modules/icon/`](../src/modules/icon/) — `icon`, overlay only
- [`src/modules/date/`](../src/modules/date/) — `date`, overlay only
- [`src/modules/shape/schema.ts`](../src/modules/shape/schema.ts) —
  `SOLID_BASE_CFG`, the solid base

---

## 1. Placement

The rows are the same table
[`design-layers-architecture.md`](design/design-layers-architecture.md) §1.4
holds for the shipped kinds, and the manifests are where they are now written
down:

| kind   | roles   | max          | resize    | minFrame | overlayDefault                         | cost(defaults)   |
| ------ | ------- | ------------ | --------- | -------- | -------------------------------------- | ---------------- |
| `icon` | overlay | `MAX_LAYERS` | `'frame'` | 0.1      | `{w:0.5,h:0.5,square}` @ (−0.45,−0.45) | static · 1 · low |
| `date` | overlay | `MAX_LAYERS` | `'frame'` | 0.2      | `{w:1.1,h:0.28,square}` @ (0, 0.66)    | tick · 1 · low   |

`date` shipped at `{w:1.2,h:0.28}` @ `(0, 0.78)` until audit 11 measured it: the
band's bottom edge sits at `0.78 + 0.14 = 0.92`, outside the 0.88 safe ring, and
the chord a round panel offers at that height is about `2·√(1 − 0.78²) ≈ 1.25`
before any margin at all — so a 1.2-wide band there was a line the bezel clipped
at both ends. The value was chosen to clear a clock's default box, which is the
placer's job (`placeNewLayer` walks a new layer outward until it finds a free
slot) and never was this table's. `registry.test.ts` now checks every registered
kind's `overlayDefault` against both the chord and the safe ring.

**Both are overlay-only**, for the reason `text` is: a full-panel base made of
one glyph, or of one date, is a look nobody composes, and a kind that can be the
base has to answer "what does it do with the whole panel" for the editor, the
picker and the legacy single-module path.

Date has a second reason. The clock already offers a **date line** on a base
that also tells the time, so a date BASE would be a worse clock with a setting
missing. A date is a thing you put on something.

**`resize: 'frame'` for both**, and it means two slightly different things.
For `date` it is §3.2's crispness rule exactly — type re-laid out at the new
size is crisp, type scaled by the compositor is the artefact CAM's compressor is
worst at. For `icon` the markup is vector either way, so the argument is the
ANCHOR: `'frame'` re-fits the glyph inside the new box with
`preserveAspectRatio`, which keeps its visual centre on the layer's anchor at
every size, and it stops the strip's size control and the resize gesture from
being two different sizes of one thing.

---

## 2. Icon: forty-eight glyphs, drawn here

[`glyphs.ts`](../src/modules/icon/glyphs.ts) is the whole set: forty-eight
glyphs on one 24×24 grid, in five drawers — hardware, ambient, symbols, arrows,
shapes.

**There is no icon font and no third-party set.** A font is a network request on
the display path, and there is no network in CAM; a third-party set is a licence
file somebody has to keep true. These are simple geometry and they are MIT with
the rest of the repository.

**A glyph is either drawn or solid.** `paint: 'stroke'` means `fill="none"` and
one stroke whose width is the config's `weight`; `paint: 'fill'` means filled,
no stroke, and `weight` does nothing. That is per glyph rather than per config
because a heart with a hole in it is not a lighter heart — it is a different
symbol — and the panel's weight control says so in its description.

**One `<svg>`, one `<path>`, `viewBox="0 0 24 24"`, always.** `svg.test.ts`
asserts it for every glyph in the table, which is what makes the set safe to add
to: a `d` typed on somebody else's grid fails in CI rather than on a panel.

The size rule is in [`svg.ts`](../src/modules/icon/svg.ts):

```
sidePx = min(size × boxW, size × boxH, min(boxW, boxH))
```

A glyph is square, so `size` claims a share of BOTH edges and the smaller one
decides — text's rule is the share of the WIDTH, because a line of type runs
along the width. The third term is a guard, not a feature: `SIZE_MAX` is 0.6, so
nothing a valid config can ask for reaches it.

**The strip's first control is an `action`, not a `segmented`.** Forty-eight
options is not a strip control at any width, and the picker needs a search field
and five category drawers — data a manifest may not carry. The module declares
that it wants the affordance (`action: 'preset'`) and the editor opens the
module's own panel, which is where the grid lives. Exactly the arrangement the
effect palettes use.

---

## 3. Date: one `Intl` call a minute

Five of the six presets are the browser's own idea of how the reader's locale
writes a date. The sixth, `iso`, is `YYYY-MM-DD` by definition — the one format
whose point is that it does NOT vary — so it is assembled from the date's own
LOCAL fields and never goes near `Intl`. Local rather than `toISOString()`,
which is UTC and would print yesterday all evening west of Greenwich.

**An unknown locale is tolerated, not rejected.** `new
Intl.DateTimeFormat('zz-quux')` throws a `RangeError`; a tag that arrived in a
look composed on another machine is not a reason for a layer to go blank, so a
formatter that cannot be built falls back to the browser's own locale — the same
answer `'auto'` gives.

**The tick budget is the interesting part.** `frame()` fires up to forty times a
second and `cost().cadence` is `'tick'` — at most once a second — so the tick
may not do per-frame work:

- every frame: one integer compare (`minuteOf(Date.now())`);
- every minute: one `Intl` format, against a cached formatter;
- every day: one DOM write.

`motionLevel` is `'static'` and `cadence` is `'tick'`, which the registry
conformance suite allows and which are both true statements: at CAM's 1 FPS
default a date is not a degraded date, it is the same date.

**The line is fitted inside the layer's safe inset, not inside its box.** A date
does not wrap — a date broken across two lines is not a date — so when the
formatted string is wider than the room it has, the type shrinks. Both halves of
that comparison are taken INSIDE the line's horizontal padding, and the padding
is the layer's own `--kh-safe`:

```
fontPx = min(size × hostW, hostH × 0.82)
room   = hostW − 2 × safeInset          // never the border box
ink    = line.scrollWidth − 2 × safeInset
fontPx = floor(fontPx × room / ink)     // when ink > room
```

Comparing the SCROLL width — glyphs plus padding — against the host's width, as
this pass did until audit 10's F7, cannot converge: the padding does not shrink
when the type does, so scaling by `room / total` always overshoots. Measured on
a 640 round Elite it took `Wed, Sep 2` from 102 px of type to 87 px and left the
line 673.9 px wide inside a 640 px panel, with the same failure at 320 px. Only
the 240 square passed, because its inset is small enough for the error to
vanish.

Measuring inside the inset is also the whole of the round-panel fix, and not by
coincidence: on a circle `--kh-safe` IS the inset to the inscribed safe square
(`platform/geometry.ts`, `circleSafeInsetPx`), so fitting the glyphs inside it
fits them inside the chord rather than inside the corners of a bounding box the
panel does not have.

**Deterministic tests, without pinning the browser.** `format.test.ts` builds
its instant from local fields (Wednesday 2 September 2026, midday) so no
assertion depends on the runner's time zone, and it asserts which FIELDS a
preset shows rather than the exact spelling — the comma, the order and whether
the month is `Sep` or `Sept` are ICU data, and pinning them would make the suite
an assertion about the runner rather than about this module. `iso` is the one
preset asserted whole, because it is the one that cannot vary.

---

## 4. Solid base: a config, not a kind

§10 lists "Solid base" and the shape module already IS it — `roles` names
`'base'`, and a `rect` at `frame: 'panel'` is a full-panel fill. What was
missing was the CONFIG that makes it one: the module's own defaults are a
translucent scrim with rounded corners (0.2 opacity, 0.08 radius), which is the
right default for an overlay band under a caption and emphatically not a flat
ground.

So `SOLID_BASE_CFG` lives in `shape/schema.ts`, next to the defaults it differs
from — opaque, square-cornered, unstroked, edge to edge — and the add sheet and
the look templates use it rather than each writing down their own idea of
"solid". No new field, no new kind, no branch in the renderer.

---

## 5. What the add sheet does with them

[`AddSheet.tsx`](../src/app/config/views/editor/AddSheet.tsx) groups tiles with
a small table, `GROUP_OF`, and a kind it has never heard of lands in **Content**
— the honest default for "a thing you put on the panel". `icon` is a Content
tile with no edit at all. `date` belongs in **Time**, which is one row in that
table:

```ts
const GROUP_OF: Readonly<Record<string, AddGroup>> = {
  …
  clock: 'time',
  date: 'time',   // ← this line
};
```

Until it is there, the Date tile appears under Content: present and addable, in
the wrong drawer.

---

## 6. Budgets

Both kinds are DOM and both are tiny — no canvas, no GL, no decoder, no media,
no network. Each has its own chunk group in `vite.config.ts` (`module-icon`,
`module-date`), so the LCD downloads the one it is showing:

| chunk         |    raw |   gzip | budget |
| ------------- | -----: | -----: | -----: |
| `module-icon` | 7.6 kB | 2.8 kB |  25 kB |
| `module-date` | 1.5 kB | 0.9 kB |  25 kB |

**The number that actually constrained the design is the other one.** Every
manifest is EAGER — the registry imports it so both pages can validate stored
config before anything renders — so a manifest and everything it imports lands
in `core`, which is one of the five chunks `budgets.json` caps for the whole
display critical path — **35 kB gzip** since W9 took the UI framework off that
path; it was 90 kB when these two kinds landed. Adding them moved that number
from 88.74 kB to **89.99 kB**, and it only stayed under because the glyph table
is not reachable from the eager side: `schema.ts` validates an id by shape and
`svg.ts` — lazy, in `module-icon` — settles its meaning. Importing the table
from the schema, which is the obvious way to write it, put the critical path at
91.9 kB and over budget.

Ten bytes of headroom is not headroom. The next kind added this way needs a
cheaper eager surface, or the five-colour swatch row that `text`, `clock`,
`icon` and `date` each write out needs to become one shared table.
