# Effects ports — Unity Banners → WebGL2 (640×640 round LCD)

12 effects ported from `/Users/ubberkid/bingo/Assets/Banners/` (user-authored, read-only).
Each ships `<name>.frag` (GLSL ES 3.00) + `<name>.json` (metadata + presets).

## The uniform contract

Every `.frag` uses **only** these, and nothing else:

```glsl
uniform float uTime;        // seconds
uniform vec2  uResolution;  // never a literal
uniform vec3  uColor0, uColor1, uColor2, uColor3;
uniform float uTemp;        // 0..1 CPU warmth, 0 = untouched
out vec4 o;
```

Vertex shader is a 3-vertex fullscreen triangle driven by `gl_VertexID` (no attributes,
no VBO) — see `tools/verify.mjs`.

### `uTemp`

Identical `applyTemp()` in all 12 files. It is a **luminance-preserving ember bias**, not a
plain channel gain: a plain warm gain leaves a green or teal palette green, so instead the
frame is blended 55 % toward `vec3(1.0, 0.42, 0.12)` scaled by the pixel's own luminance,
then that result is mixed in by `t`. At `uTemp = 0` the output is bit-identical to the
untinted effect. Verified across all 12 at `uTemp = 0.85` — see `shots-temp/_contact-sheet.png`.

### The square-composition change

Every Banners shader is a Shadertoy port squeezed into a 4:1 strip via
`fragCoord = uv * _Resolution * fixed2(1,.25)` plus framing offsets like `fixed2(-.2, 1.5)`.
`iResolution` is a scalar (square), so **deleting the squeeze and the offsets restores the
effect's native square composition** rather than compromising it. Done for all 12; the
per-effect notes record the exact source expression that was dropped.

Two shaders needed judgement rather than a straight deletion — `plasma` and `wavy_gradient`.
Both are documented below.

### Colour → sRGB

Unity stores material colours **linear**. Confirmed: `plasma_banner_material._Background.b =
0.4275105` → sRGB `0xAE` (`#00FFAF`), `_Color1 = 0.5283019` → `0xC0` (`#C0C0C0`) — clean
authored values on both. `tools/extract-mats.mjs` applies the standard sRGB EOTF inverse to
every `*_material.mat` variant. The `_GammaCorrect` `pow(rgb, 2.2)` in the sources is a
Unity linear-pipeline artefact and is **not** carried over — these render to an sRGB
default framebuffer.

## Results

Compiled and rendered in headless Chromium WebGL2, 640×640,
`ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)`. **12/12 compile and link with zero
errors.** ms/frame is the mean of 60 draws drained with a 1-px `readPixels`; the harness
floor (draw-call + sync overhead) is ~0.01 ms, so treat sub-0.02 numbers as "free".
**Nothing is anywhere near the 8 ms budget** — no cost reduction was needed for any effect
except the deliberate `prism` rewrite.

| Effect | Display name | Presets | ms/frame | Cost class | Looks like |
|---|---|---|---|---|---|
| `plasma` | Lava lamp | 9 | 0.03 | low-motion | A single molten blob drifting and folding, blown-out hot core with a coloured rim glow, over a two-colour gradient |
| `colorful_interference` | Interference | 1 | 0.01 | low-motion | Two drifting concentric ring fields smooth-min'd together, bright bloom where they overlap, banded shadow elsewhere |
| `twisted_nebula` | Twisted nebula | 3 | 0.01 | low-motion | A wide smooth two-arm spiral, slow continuous rotation, no fine detail at all |
| `satin_swirl` | Satin swirl | 3 | 0.02 | low-motion | Aurora ribbons twisted into a rosette, noise-broken, radial fade to the background gradient |
| `triad_nexus` | Triad nexus | 3 | 0.02 | low-motion | Ten nested counter-rotating triangles fanned across a bold two-colour gradient |
| `color_spiral` | Colour spiral | 1 | 0.01 | high-motion | One huge log-spiral arm sweeping the whole disc, hard bright/dark edge |
| `wave_ripple` | Wave ripple | 3 | 0.01 | low-motion | Concentric ripples pushed out through a 3-point star field |
| `wavy_gradient` | Wavy gradient | 8 | 0.01 | low-motion | A vertical gradient posterized into 0.05 steps with slow sine-warped horizontal bands |
| `voronoi` | Voronoi cells | 9 | 0.03 | low-motion | 50 drifting points → banded contour rings, an organic maze that reshapes very slowly |
| `infinite_rings` | Infinite rings | 3 | 0.01 | high-motion | Infinite-zoom concentric arcs, each ring spinning at its own hashed rate |
| `classic` | Classic | 8 | 0.01 | low-motion | Static vertical gradient with four hard diagonal gloss stripes |
| `prism` | Prism *(experimental)* | 9 | 0.03 | low-motion | Glassy folded boxes tumbling behind a soft glow, over a gradient |

Renders: `shots/<name>.png` (preset 0, `uTemp = 0`), `shots/_contact-sheet.png`,
`shots-temp/` (preset index 2, `uTemp = 0.85`).

## Per-effect notes

### `plasma` → "Lava lamp"  *(Tier 1)*

`map()` preserved **verbatim** (`Plasma.shader:97-103`), as is the 11-step raymarch, the
`f` derivative probe, the `cl = cl*l + smoothstep(...)*0.7*l` accumulation, and the
`fragCoord.x * f` colour split (its 0..3 span is preserved so `mix()` extrapolates by
exactly the amount it did in Unity — that extrapolation is what makes the hot core blow to
white, and it is authentic). No step-count reduction: at 0.03 ms there was nothing to buy.

**Deviation — framing.** The source's visible window was half-extent **1.5 in x, 0.5 in y**.
Neither is right for a square: at 0.5 the blob fills the whole disc and reads as a flat
saturated wash; at 1.5 it is a small dot. Swept 0.5 / 0.75 / 1.0 / 1.5 (and centre offsets
0 and −0.5) and picked **half-extent 1.0, centred**, which is the framing in the contact
sheet. This is the one place where "delete the squeeze" wasn't sufficient on its own.

Slots: Lava / Glow / Background / Background 2 → `_Color1` / `_Color2` / `_Background` /
`_Background2`. All 9 variants map 1:1, no invented colours.

### `colorful_interference` → "Interference"  *(Tier 1)*

`df`, `pmin`, `pmax` and the whole smooth-min ring construction verbatim.

**Deviation — colour.** The source has exactly one colour property (`_BackgroundColor`) and
never reads it; the palette is a hard-coded `sin(vec3(0,1,2) + ...)` rainbow. The structure
is kept (a colour that cycles with radius and time over a `1/(8·dot(p,p))` bloom) but driven
by `uColor0`/`uColor1`. The Classic preset's two glow colours are the source rainbow's own
endpoints (`#85F5FF` cyan phase, `#FF4126` red phase) and the edge tint is its `vec3(2,1,0)`
subtractive term.

**Deviation — rim.** The source's `smoothstep(1.5, 0.5, length(pp))` vignette is kept
verbatim, but past the disc edge the frame now settles onto `uColor2` over
`smoothstep(0.85, 1.20, l)` instead of running to black. A first pass blended background
across the whole vignette and washed the interior purple; this version leaves the interior
untouched.

Only 1 `.mat` exists for this banner, hence 1 preset.

### `twisted_nebula` → "Twisted nebula"  *(Tier 1)*

The polar twist and interference term are verbatim. `_Freq = 20`, `_Speed = 1` taken from
the material (the shader's own default was `_Speed = 2`).

**Deviation.** The source added a flat `_ColorC`; here it is `mix(uColor2, uColor3, r*2)`.
Presets set `uColor3` to `_ColorC` darkened 45 % for a rim falloff — set both slots equal
for the exact Unity result. 3 variants.

### `satin_swirl` → "Satin swirl"  *(Tier 1)*

`hash21` / `noise2D` verbatim. `_WaveFreq = 27.97`, `_StripeWidth = 0.5`, `_NoiseAmp = 0.756`
from the material (note the material's noise amp is 0.756, **not** the shader's 0.15
default — the higher value is what shipped and it is what makes the ribbons break up).
Its own `1 - smoothstep(0.4, 0.8, r)` radial fade already suits a round display.

Perfect 4-slot fit: `_AuroraColA` / `_AuroraColB` / `_BGTop` / `_BGBottom`. No invented
colours. 3 variants.

Note: these four `.mat` values are the shader's authored defaults untouched by any artist,
so they were probably written in sRGB by hand; they still go through the same linear→sRGB
conversion as everything else for consistency, giving a navy pair (`#505989` / `#273050`).

### `triad_nexus` → "Triad nexus"  *(Tier 1)*

iq `tri()` SDF verbatim. The source's `hsv2rgb()` is **stubbed to return `vec3(c.z)`** — the
triangle stack is greyscale by design, a depth ramp the colour map reads. Loop rewritten
from `for (float i = 1.; i > 0.; i -= 0.1)` to an int loop over the same 10 values.

**Deviation.** The source had one shape colour (`lerp(bg, _Color1, bw)`); the port fades
shapes from `uColor1` to `uColor0` with depth. Presets set `uColor1` to `_Color1` × 0.45.
Set `uColor1 == uColor0` for the exact Unity result. 3 variants.

### `color_spiral` → "Colour spiral"  *(Tier 2)*

The golfed one-liner is reproduced exactly, including the HLSL `float4 → float2x2` row-major
cast (`rows [c4.x c4.y; c4.z c4.w]`) and the `mul(I, M)` row-vector product, written out
explicitly since GLSL's `mat2` is column-major. `I` is scaled to the source's numeric range
(±143) because `log(length(I))` is scale-sensitive.

**Deviation.** The source has **no colour properties at all**. Its displayed luminance is
preserved and mapped through a 4-stop gradient over `uColor0..3`. The single Classic preset
reproduces its own dark → red → cyan → white channel character.

`high-motion`: one hard bright/dark edge sweeping the full disc every few seconds.

### `wave_ripple` → "Wave ripple"  *(Tier 2)*

Already square-native — the source used `p = (uv-0.5)*2` at unit scale with no squeeze, so
nothing was dropped. `starDistance` verbatim; ring params from the material
(`_RingScale = 8.87`, `_StarPoints = 3`).

Note the naming in the source is inverted from what it looks like: `smoothstep(0.5, 0.45, …)`
makes `_RingColor` the wide fill and `_BGColor` the thin bands. Slots are named for what you
actually see: Rings / Ring highlight / Edges / Edges 2.

**Deviation.** Two extra slots: a phase highlight across the wide band and a radial shade on
the thin one. Presets derive them (ring lifted 25 % toward white, edge scaled to 55 %).
3 variants.

### `wavy_gradient` → "Wavy gradient"  *(Tier 2)*

10-bar stack and the deliberate 0.05 posterization verbatim.

**Deviation — framing, deliberate exception to the square rule.** The source's `fixed2(1,.5)`
is *not* a banner squeeze here: `uv.y` is the **gradient axis** (it selects which slice of
the 10-bar ramp is visible), so expanding y to a full square blows the top half out to the
end colour and kills most of the banding. The x span (which sets the wave frequency via
`uv.x*5`) carries over to square; y keeps its authored 0..0.55 range. Verified both ways —
the expanded version renders as a near-flat wash.

**Deviation — colour.** The source's `lerp(_Color1, _Color2, bw - .1)` becomes a 4-stop
gradient. Presets set the two mids to the ⅓ and ⅔ blend of start/end, so every preset renders
identically to Unity while giving four knobs. `grad4()` clamps where the source's `lerp`
extrapolated — the only behavioural difference, and it is a strict improvement. 8 variants.

### `voronoi` → "Voronoi cells"  *(Tier 2)*

The 50-iteration loop was profiled as instructed: **0.03 ms/frame** at 640², the joint most
expensive effect in the set and still ~250× under budget. No reduction made. The 2-D hash is
verbatim.

**Deviation — framing.** The source sampled a 1.0 × 0.25 window at the origin while its
5 × 10 point lattice sat around (0.45, 0.20) — it was looking at the edge of its own point
cloud. The port uses a 1.0 × 1.0 window **centred on the lattice**, which is the composition
the point layout implies.

**Deviation.** Two extra slots fade the rim (`smoothstep(0.55, 1.05, |p|)`) instead of
hard-cutting at the bezel. Presets derive them from `_Color1`. 9 variants.

### `infinite_rings` → "Infinite rings"  *(Tier 2)*

`arc`, `hash`, `forward`/`reverse`/`cell` exponential-zoom machinery verbatim.
`log2(1.2)` inlined as a literal (GLSL ES has no constant-expression `log2`).

**Deviation — colour.** The source picked a random **hue** per ring
(`hsv2rgb(vec3(h0, 1, v))`); the contract has no hue slot, so each ring now lands somewhere
between `uColor1` and `uColor2` by the same hash. The source's `_UseGradientMap` toggle is
also unrepresentable, so the gradient-map path's meaning is folded into the slots
(background = `_Color1`, rings = `_Color2`). The default material had the toggle **off** with
`_Color1 = _Color2 = white`, i.e. a rainbow on white — its Classic preset picks two vivid
ring colours instead.

The source's final `sqrt(col)` is kept, with user colours pre-squared so they come back out
exactly as authored. 3 variants.

`high-motion`: continuous exponential zoom plus per-ring spin.

### `classic` → "Classic"  *(Tier 2)*

Verbatim, and already square-native. Static — reads `uTime` not at all (the uniform is
declared to satisfy the contract). `_TopColorPosition = 1` / `_BottomColorPosition = 0` in
every material, so the gradient is `smoothstep(1, 0, uv.y)`.

**Deviation.** The gloss stripes added flat white; they now add `uColor2` (main stripe) and
`uColor3` (the three thin ones). Presets set both to `#FFFFFF`, i.e. **identical to Unity**,
while leaving the slots useful. 8 variants.

### `prism` → "Prism"  ⚠ EXPERIMENTAL  *(bonus)*

Confirms the inventory's caveat: `px()` has its `if (h.x > 64)` guard commented out
(`Prism.shader:149`), so it unconditionally returns the background gradient and the entire
8-bounce refraction chain contributes **nothing visible**. The whole image is the `glw` glow
accumulator (`Prism.shader:120`) added to a background lerp.

The glow-accumulator reconstruction the inventory describes, at reduced steps: `bx`, `mp`
and the folded box/sphere SDF verbatim, **3 bounces × 36 steps** instead of 8 × 128 —
~324 SDF evals/px against the source's ~1024–4096. Measured 0.03 ms/frame. The bounces are
kept (rather than a single march) because each one re-enters `mp()` from a new position and
that is where the multi-lobe structure in the glow comes from.

**Deviation.** `_UseColor` is unrepresentable in the contract, so the glow is always mapped
through `uColor0 → uColor1` and **multiplied by its own intensity**, which the source did not
do — without that a preset's glow colour covers the entire frame at full strength. The
default material has `_UseColor = 0` with `_Color1 = _Color2 = #BCBCBC`, so its Classic
preset is a grey glow; the chroma the source got from `normalize(p*p)` in that mode is not
recoverable through a two-colour map.

**Not diffed against a Unity screenshot.** Marked `"experimental": true` in the JSON. Verify
before shipping it as a default.

## Files

```
plasma.frag / .json          colorful_interference.frag / .json
twisted_nebula.frag / .json  satin_swirl.frag / .json
triad_nexus.frag / .json     color_spiral.frag / .json
wave_ripple.frag / .json     wavy_gradient.frag / .json
voronoi.frag / .json         infinite_rings.frag / .json
classic.frag / .json         prism.frag / .json

tools/extract-mats.mjs   parses *_material.mat, linear -> sRGB hex
tools/generate-meta.mjs  writes every <name>.json from those + slot mappings
tools/verify.mjs         headless Chromium WebGL2 compile + render + timing + contact sheet

```

### The renders are not in the repository

`shots/` and `shots-temp/` (the per-effect PNGs and the two contact sheets, 3.6 MB)
were **deleted when W7a shipped the module**. They were evidence for a review that has
happened; carrying them forever would have made this directory thirty times the size of
the sources it exists to hold, in a repo whose whole-`dist` budget is 10.6 MiB (of which
~7.5 MiB is sourcemaps). Everything they
showed is now a thing you can look at directly — pick the effect in the settings panel —
and `node tools/verify.mjs` regenerates them from the `.frag` files at any time.

What is kept is what cannot be regenerated: the twelve sources, their metadata, and the
deviation notes above.

The shipped module (`src/modules/effect/`) carries its own copies of these twelve
fragments, minified and with three mechanical edits applied — `khCoord()` for centred
zoom, `uScale`, `uBright` — recorded in each `src/modules/effect/effects/*.ts` header.
Edit a port here and the change reaches the app only by re-running that transform.

Re-run verification:

```
node tools/verify.mjs                                   # preset 0, uTemp 0
PRESET=2 TEMP=0.85 SHOTS_DIR=shots-temp node tools/verify.mjs
```

Exits non-zero on any compile or link failure. It resolves `playwright` out of
`/Users/ubberkid/kraken-hub/node_modules` via `createRequire` (read-only; nothing is written
into that repo).

## `costClass` reasoning

`high-motion` was assigned on **frame-to-frame entropy**, not GPU cost, since the compressed-
frame pipeline cares about how much of the image changes per frame:

- `color_spiral` — a hard-edged spiral arm sweeping the entire disc.
- `infinite_rings` — continuous exponential zoom, so every pixel moves every frame, plus
  independent per-ring rotation.

Everything else is broad smooth gradients or slow drift. `voronoi`'s 50-point loop is the
most expensive to *render* but among the calmest to *encode* — the points drift on
`sin(hash·t)·0.4`, which is very slow. `prism` is likewise low-entropy despite being the
heaviest shader.
