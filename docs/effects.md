# Effects

An **effect** is a moving background drawn by the graphics card: a lava lamp
folding over itself, ribbons of aurora, cells that drift and reshape. There are
twelve, they take your own colours, and one of them can warm up as your machine
does.

They are a **layer kind** like any other, so an effect can be the whole panel or
a disc floating under a clock, and a look may hold up to two of them.

Which of those two you get depends on where you put it. As the **base** it wears
the whole panel, edge to edge, and that is the picture most looks are built on.
Added **on top** of something else it arrives as a small translucent badge in the
top-right corner — a little over a quarter of the panel across, at 85 % opacity —
because an effect fills every pixel of its box, and a fresh overlay the size of
the disc would simply be a lid over the look you already had. Drag it, resize it
and take the opacity back to 100 % whenever a lid is what you wanted.

**Where the settings are.** An effect layer's strip carries exactly one button —
**Effect…** — and it opens the effect panel with the picker, the preset chips,
the four colour wells, the temperature switch and Advanced all in one place,
scrolled to the picker. It used to be five buttons (Effect, Preset, Colours,
Warmth, More) and four of them opened that same panel, which is four labels for
one door.

**Contents**

1. [The twelve](#the-twelve)
2. [Presets](#presets)
3. [Your own colours](#your-own-colours)
4. [Speed, scale and brightness](#speed-scale-and-brightness)
5. [Reacting to temperature](#reacting-to-temperature)
6. [What it costs, and what happens when the panel is busy](#what-it-costs-and-what-happens-when-the-panel-is-busy)
7. [At 1 frame per second](#at-1-frame-per-second)
8. [If your machine has no 3D](#if-your-machine-has-no-3d)
9. [Adding one](#adding-one)

---

## The twelve

Every one of them is a port of a banner from the author's own project, kept as
close to the original as a round 640-pixel panel allows. The picker shows them
in this order, calm ones first:

| Effect             | What you see                                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| **Lava lamp**      | One molten blob drifting and folding, blown-out core, coloured rim glow      |
| **Twisted nebula** | A wide two-arm spiral turning slowly, no fine detail at all                  |
| **Satin swirl**    | Aurora ribbons twisted into a rosette, broken up, fading at the edge         |
| **Triad nexus**    | Ten nested counter-rotating triangles over a bold gradient                   |
| **Voronoi cells**  | Fifty drifting points read as contour rings — an organic maze, very slow     |
| **Interference**   | Two ring fields overlapping, bright where they meet, banded where they don't |
| **Wave ripple**    | Concentric ripples pushed out through a three-point star                     |
| **Wavy gradient**  | A vertical gradient posterized into steps, warped by slow horizontal bands   |
| **Classic**        | A still gradient with four hard diagonal gloss stripes                       |
| **Colour spiral**  | One huge spiral arm sweeping the whole disc, hard bright/dark edge           |
| **Infinite rings** | Concentric arcs zooming forever, each ring spinning at its own rate          |
| **Prism**          | Glassy folded boxes tumbling behind a soft glow                              |

The picker is a **two-column grid of picture cards**, so all twelve are on the
screen and you scroll the settings sheet past them the way you scroll everything
else in it. Where the panel is genuinely wide — 560 px or more of room for the
control itself, which the inspector rail is not — it becomes the horizontal
scroller it used to be everywhere, with a fade at whichever end has more behind
it. Arrow keys move the selection either way, and the focus follows it.

**Classic** does not move at all — it is a still picture, and it is the one to
pick if you want something on the panel that costs almost nothing.

**Prism** is marked as still being tuned. It works; it is the one port that was
never compared against the original side by side.

---

## Presets

A **preset** is a colour set, and every preset in the app is one of the author's
own materials — Classic, Graphite, Ice, Lime, Bubblegum, Amethyst, Ember, Snow,
Sunburst — with the exact colours those materials were authored with, converted
once from the way the original tool stored them.

Not every effect has all nine. Lava lamp, Voronoi cells and Prism have all of
them; Interference and Colour spiral have one, because only one material was
ever made. The chips show what exists for the effect you are on.

Pressing a preset **writes its colours into your effect**. It is a starting
point, not a mode you are in.

---

## Your own colours

Every effect takes four colours, and each well is labelled with what it actually
does — Lava, Glow, Background, Background 2 on the lava lamp; Rings, Ring
highlight, Edges, Edges 2 on the ripple. They are not four arbitrary slots.

Change one and the preset row says **Custom**. Change it back and the preset it
matches lights up again — the row reads your colours rather than remembering
what you last pressed, so there is no state to get stuck in.

---

## Speed, scale and brightness

Behind **Advanced**:

- **Speed** — a quarter to double. Moving this slider _bends_ the motion; it
  never jumps, because the effect's clock is integrated rather than read.
- **Scale** — half to double, zooming about the centre of the panel. Below 1 you
  see more of the composition; above 1 you see less of it, larger.
- **Brightness** — half to one-and-a-half. Useful for an effect sitting under a
  clock, where the point is for the words to win.

---

## Reacting to temperature

Turn **Reacts to temperature** on and the picture warms toward ember as the
chosen reading climbs, and cools back down as it falls. Pick which sensor drives
it — **CPU**, **GPU** or **Liquid** — under Advanced.

Two things worth knowing:

- **It glides.** The reading arrives once a second; the picture takes a couple of
  seconds to answer it. That is deliberate — a temperature written straight onto
  the panel would step every pixel once a second, which looks like a pulse and
  costs frame rate.
- **The tint keeps the palette.** It is not a warm filter over the top; the frame
  is pushed toward ember in proportion to each pixel's own brightness, so a green
  or teal palette goes hot rather than merely yellow. At rest the picture is
  exactly the untinted effect.

If CAM stops reporting the sensor you chose, the warmth **holds where it is**
rather than gliding to cold. An absent reading is not a cold one.

---

## What it costs, and what happens when the panel is busy

An effect repaints its whole box on every frame and holds one graphics context,
which makes it the second most expensive thing this app can put on a panel
(after video). The look editor's budget bar counts that, and the count is an
_estimate_: nothing in the page can see how hard CAM is working to compress what
it captures.

Two of the twelve — **Colour spiral** and **Infinite rings** — are charged more,
not because they are harder to draw but because _every pixel changes every
frame_, which is what the capture pipeline actually pays for. Voronoi cells is
the most expensive of the twelve to render and among the cheapest to capture.

When the panel falls behind, the governor asks layers to get cheaper rather than
turning any of them off. An effect answers by painting **every other frame**, and
if that is not enough, **once a second** — and in both cases its own clock keeps
running, so the picture is never in the wrong place when it does paint. It never
disappears.

---

## At 1 frame per second

CAM's frame-rate slider defaults to 1, and the Kraken Z is capped there. Twelve
moving pictures at 1 FPS are twelve slideshows, so this module says so — the
display shows the "raise your frame rate" advisory, honestly, because raising it
is a real improvement here rather than a shrug.

Everything still works at 1 FPS: the effect advances by a whole second between
paints, the warmth glides between them, and **Classic** — which does not move —
looks exactly the same as it does at 40.

---

## If your machine has no 3D

The panel shows a **still gradient of your own first and last colours** — the
same picture, stopped, rather than a black screen or an error. That is also what
is on screen for the fraction of a second before the effect has finished
loading, and what you get if the graphics context is lost and cannot be rebuilt.

Effects run on WebGL2 where it exists and on WebGL1 where it does not; all
twelve are verified to compile, link and produce the same pixels on both.

### How to tell which renderer you got

The effect's own element on the panel says so, in one word. Open the display
page's inspector (or the diagnostics view at `?kraken=1&diag=1` on the machine
you can inspect), find the `div.kh-effect` an effect layer owns, and read
**`data-gl`**:

| `data-gl` | What is on the panel                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `webgl2`  | The modern context. The ES 3.00 source, drawn from `gl_VertexID`                                                                  |
| `webgl1`  | The fallback context, running the same effect translated to ES 1.00                                                               |
| `none`    | The still gradient — no context was granted, the program would not compile, or the display is hidden and has released the context |

**Switching effects keeps the same WebGL context.** Choosing a second effect
deletes the old shader program and compiles the new one onto the context that is
already running — it does not take the context down and ask for another. It
cannot: a canvas whose context has been released through `WEBGL_lose_context`
hands the same, still-dead context back to every later request, so a rebuild on
that canvas would link against nothing and the panel would present its lost
drawing buffer — **white**, on the Direct3D backend a Kraken's webview uses. The
context is released only when the display is hidden, when the layer goes away, or
when the driver takes it, and coming back from any of those builds on a **fresh
canvas element** rather than on the one that carries the loss. The element also
says which effect is drawing, as `data-effect`.

`data-gl` therefore stays `webgl2` (or `webgl1`) straight through a switch —
seeing it flip to `none` when somebody picks an effect is the signature of the
old bug.

It records the renderer that is **running**, not the one that was asked for: a
context that is granted but whose program will not link reads `none`, because a
still gradient is what a person is actually looking at. While a context is lost
and waiting to be rebuilt the element also carries **`data-gl-lost="true"`**,
which is the difference between "this machine has no 3D" and "the driver just
took the context away".

---

## Adding one

Two lines and one file. The module is built so that adding a thirteenth effect
touches nothing else:

1. **The source** — `src/modules/effect/effects/<yourEffect>.ts`, exporting one
   `FRAG` string. It is GLSL ES 3.00 and may use exactly these uniforms, all of
   which the runner sets for you:

   ```glsl
   uniform float uTime;        // seconds, already scaled by the speed control
   uniform vec2  uResolution;  // the box in pixels — never a literal
   uniform vec3  uColor0..3;   // the user's colours, in slot order
   uniform float uTemp;        // 0..1 warmth, already eased
   uniform float uScale;       // read it through khCoord(), see below
   uniform float uBright;      // multiply your finished frame by it
   ```

   Read coordinates through the helper the other twelve use, so the scale
   control works and zooms about the centre:

   ```glsl
   vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution) / uScale + 0.5 * uResolution; }
   ```

   Declaring a uniform the runner does not set — or forgetting one it does — is
   a test failure, not a black panel: `glsl.test.ts` compares both directions.

2. **The loader** — one line in `src/modules/effect/effects.ts`, a dynamic
   `import()`. This is what gives your effect its own chunk, so nobody downloads
   it unless they choose it.

3. **The descriptor** — one entry in `src/modules/effect/catalog.ts`: the name a
   person reads, one label per colour well, and at least one preset. Add its id
   to `EFFECT_IDS`, `EFFECT_COLOUR_SLOTS` and `EFFECT_PRESET_IDS` in
   `schema.ts` — the eager tables `validate()` reads — and the panel, the picker
   and the tests pick it up on their own.

The general module contract is in [`docs/modules.md`](modules.md); the twelve
ports, their originals and every deviation are recorded in
[`docs/design/effects-ports/PORTS.md`](design/effects-ports/PORTS.md).
