Findings below.

## Which project

- **`/Users/ubberkid/giddy-bingo` does not exist.** The Unity project is **`/Users/ubberkid/bingo`** (Unity, `Assets/`, `bingo.sln`, TextMesh Pro, Odin).
- The PixiJS project is **`/Users/ubberkid/giddy-games`** (npm workspaces: `games/bingo`, `games/bingo-blackout`, `games/plinko-sands`, `games/bonus-scratcher`, `packages/core`, `packages/bingo-core`). Its shaders are all **Pixi v8 sprite filters** (every one requires `uTexture`), not procedural backgrounds — useful only as a GLSL-ES-300 syntax reference and a noise library.
- **kraken-hub has no shader module yet.** Scaffold is `/Users/ubberkid/kraken-hub/src/modules/_template/` (`display.ts` / `schema.ts` / `index.ts` / `TemplateConfig.tsx`); WebGL2 is already probed in `/Users/ubberkid/kraken-hub/src/platform/capabilities.ts:102`.
- **"lavalamp" = the `plasma` banner.** `/Users/ubberkid/bingo/Assets/Scripts/Bot/banners.json` describes plasma as *"A mesmerizing swirl of molten colors, as if a cosmic lava lamp had come to life."* There is no shader literally named lavalamp.
- No custom `.compute` and no custom `.shadergraph` exist — the only `.shadergraph`/`.hlsl`/`.cginc` files are vendored TextMesh Pro. **All the value is in `/Users/ubberkid/bingo/Assets/Banners/`** (33 shaders across 90 banner dirs).

## The one structural insight that makes this cheap

Every Banners shader is a **Shadertoy port mechanically wrapped in Unity UI boilerplate**. They share an identical preamble:

- `_MainTex`/`_SecondTex`/`_ThirdTex`/`_FourthTex` are declared as `iChannel0-3` but **never sampled** in any banner shader — vestigial scaffolding. Zero texture dependencies.
- `#define iResolution float3(_Resolution, _Resolution, _Resolution)` — resolution is a **scalar, i.e. square**. All `RESOLUTION.x/RESOLUTION.y` aspect terms cancel to 1.
- Each frag then squeezes a square effect into a 4:1 banner strip via `fragCoord = uv * _Resolution * fixed2(1,.25)` plus framing offsets like `fixed2(-.2, 1.5)`.

**On a 640×640 round LCD you delete the `fixed2(1,.25)` squeeze and the framing offsets entirely** and set `iResolution = vec3(640.)`. That is not a compromise — it restores the effect's native square composition, which is what these were authored as. This is the single most important instruction for the implementer.

Mechanical HLSL→GLSL ES 3.00 swaps (same for all): `float2/3/4`→`vec*`, `float2x2`→`mat2`, `lerp`→`mix`, `frac`→`fract`, `saturate(x)`→`clamp(x,0.,1.)`, `atan2(y,x)`→`atan(y,x)`, `glsl_mod`→`mod`, `fixed`→`float`, `static const`→`const`, `((float3)0.)`→`vec3(0.)`, `mul(v,M)`→`v*M`. Note the shaders wrap every rotation matrix in `transpose(float2x2(c,s,-s,c))` purely to undo HLSL's column-major convention — in GLSL write `mat2(c,s,-s,c)` and drop the transpose. `_Time.y` → `uTime` seconds; `_Time.x` → `uTime/20.0`. Delete `UnityObjectToClipPos`, `UnityGet2DClipping`, `_ClipRect`, `UNITY_UI_ALPHACLIP`, and both `#include`s.

## Inventory

All paths are under `/Users/ubberkid/bingo/Assets/Banners/`. "Cost" = GPU per-pixel work at 640². "Entropy" = motion character for the compressed-frame pipeline.

| # | Shader (path) | Renders | Inputs | Self-contained? | Cost | Entropy | Port |
|---|---|---|---|---|---|---|---|
| 1 | `plasma/Plasma.shader` **(lavalamp)** | 11-step volumetric raymarch through a rotating log-warped sin field — molten blobs drifting | time, 2 colors, 2 bg colors | Yes, fully | 22 `map()` evals | **LOW** — slow, smooth, no fine detail | trivial |
| 2 | `twisted_nebula/twisted_nebula_shader.shader` | polar twist `θ += 2/(r+0.1)` then sin×cos interference; 3 additive colors | time, 3 colors, freq, speed, scale/offset | Yes | ~20 ALU, **no loops** | **LOW** | trivial |
| 3 | `colorful_interference/ColorfulInterference.shader` | two drifting repeated-ring SDFs combined with polynomial smooth-min, plus `1/(8·dot(p,p))` radial bloom | time, bg color | Yes | no loops, moderate ALU | **LOW** | trivial |
| 4 | `satin_swirl/satin_swirl_shader.shader` | polar-twisted sin/cos grid → aurora stripes over a vertical gradient, radial edge fade | time, 4 colors, wave freq/speed, stripe width, noise amp | Yes (own `noise2D`) | 1 value-noise + ALU | **LOW** (noise amp 0.15) | trivial |
| 5 | `color_spiral/ColorSpiral.shader` | one-line golfed log-spiral rainbow: `9./max(I*mat2(cos(t-log(len(I))+vec4(0,11,33,0)))+9., 0.1)` | time only | Yes | ~free | LOW | trivial |
| 6 | `wave_ripple/wave_ripple_shader.shader` | star-shaped radial distance field with outward concentric triangular-wave ripples | time, 2 colors, star points/amp, ring scale/thickness/sharpness/speed | Yes | ~free | **LOW** | trivial |
| 7 | `wavy_gradient/WavyGradient.shader` | 10 stacked sine-warped horizontal bars → grayscale → posterized to 0.05 steps → 2-color gradient map | time, 2 colors | Yes | 10 cheap iters | **LOW** (deliberate banding) | trivial |
| 8 | `swirl_bloom/swirl_bloom_shader.shader` | polar twist + rose-curve petal mask + outward pulsing ring | time, 3 colors, petal count/sharpness, pulse rate/width | Yes | no loops | LOW | trivial (clamp the `petalMask/petalMask2` divide) |
| 9 | `wavy_flower/WavyFlower.shader` | radial petal wave (`radial()` on atan) with a breathing offset | time, 2 colors | Yes | ~free | LOW | trivial |
| 10 | `squares/SquarePattern.shader` | 45°-rotated grid, expanding checkerboard ripple from center | time, 2 colors | Yes | ~free | LOW | trivial |
| 11 | `classic/ClassicBanner.shader` | linear gradient + 4 hard-stepped diagonal gloss stripes | 2 colors, positions, angle | Yes | ~free | **LOWEST** | trivial |
| 12 | `rainbow_rays/rainbow_rays_shader.shader` | iq cosine palette over a rotating radial `cos(√dot(p,p)/0.1 - t)` field, `tanh` tone-mapped | time, hue speed, scale/offset, bg | Yes | **no loops, no tex** | MED (sharp bright rings; needs AA) | trivial |
| 13 | `triad_nexus/triad_nexus_shader.shader` | 10 nested counter-rotating triangle SDFs, size-ramped | time, 3 colors, scale/offset | Yes (`tri()` = iq triangle SDF) | 10 iters | **LOW** (big smooth shapes) | trivial |
| 14 | `dot_dot_dot/dot_dot_dot_shader.shader` | exponentially zooming dot lattice, optional hue-cycling dots | time, 2 colors, scale/expF/radius | Yes | ~free | LOW | trivial |
| 15 | `voronoi/Voronoi_Circle.shader` | 50 hash-jittered drifting points → nearest-distance → banded contour rings | time, 2 colors | Yes | **50-iter loop** | LOW (slow drift) | trivial |
| 16 | `voronoi_square/Voronoi_Square.shader` | same but `sdBox` metric → rectilinear cells | time, 2 colors | Yes | 50-iter loop | LOW | trivial |
| 17 | `infinite_rings/infinite_rings_shader.shader` | exponential-cell (`exp2`/`log2`) infinite-zoom concentric arcs, hash-driven per-ring hue and spin | time, 2 colors, scale/offset, gradient-map toggle | Yes (`arc`, `hash`, `hsv2rgb`) | no big loop | LOW-MED | moderate |
| 18 | `neural/Neural.shader` | 20-iter domain-warp turbulence (`n += sin(q); N += cos(q)/S`) → glowing filament web | time, bg color | Yes | 20 iters × 2 trig `vec2` | **HIGH** (fine filaments) | trivial |
| 19 | `radiant_harmony/radiant_harmony_shader.shader` | 4-iter `fract(uv*c)-0.5` kaleidoscope + iq palette + `pow(0.01/d,1.2)` glow; `complexity` itself animates | time, scale/offset | Yes | 4 iters | **HIGH** (thin filaments + scale strobing) | trivial |
| 20 | `gridzone/HalftoneZoom.shader` | 16-layer infinite-zoom halftone dot tunnel with per-layer rotation, `fwidth()` AA | time, 4 colors | Yes | **16 layers** + `fwidth` | MED | moderate |
| 21 | `triangle_warp/TriColor.shader` | 6 layers of log-polar spiral with stepped-fade rotation, hue from `atan2` of accumulated vector | time, 3 colors | Yes | 6 layers | MED | moderate |
| 22 | `rainbow_rain/RainbowRain.shader` | 20-iter rotating-lattice point-glow accumulation, rainbow via `cos(p.y/0.1+vec4(0,1,2,3))` | time | Yes | 20 iters | MED-HIGH (many bright points) | trivial (golfed comma-operator loop needs unrolling) |
| 23 | `virtual/Virtual.shader` | retro synthwave perspective floor grid (`uv.y = 3/(abs(uv.y+0.3)+0.05)`) | time, bg color | Yes | ~free | MED (grid aliases at horizon) | trivial |
| 24 | `peaceful_pathways/peaceful_pathways_shader.shader` | smooth kaleidoscope (6-fold) + hex-tiling + polar `mod1` line field with per-line hash hue and sweep cut | time, 2 colors, scale/offset, multicolor toggle | Yes (`smoothKaleidoscope`, `hextile`, `mod1`, `hash`) | moderate | MED | moderate |
| 25 | `chromatic_vortex/chromatic_vortex_shader.shader` + `chromatic_lines_shader.shader` | mrange-style 8-plane layered tunnel: per-plane SDF, alpha-blended front-to-back, BPM-driven camera on a Lissajous path, ACES tonemap | time, 2 colors, `_UseColors` | Yes | **8 planes × full plane()** | MED-HIGH | moderate |
| 26 | `serenity_waves/serenity_waves_shader.shader` (356 L, largest) | 8-plane layered fbm mountain/wave silhouettes, hi/lo height fields, hsv sky | time, 2 colors, scale/offset, gradient map | Yes | **8 planes × 2 fbm × 2 octaves = 32+ value-noise** | **HIGH** (fine noise) | moderate |
| 27 | `fire/Fire.shader` | 3D simplex-noise fire column with flow-field displacement and fuel falloff | time, mouse (dead) | Yes (own `snoise`) | 3D simplex × ~3/px | **HIGHEST** (flicker) | moderate |
| 28 | `prism/Prism.shader` | **8 refraction/reflection bounces × 128-step raymarch** through a 3-iteration folded box/sphere SDF, with `glw` glow accumulator | time, 2 colors, 2 bg colors, `_UseColor` | Yes | **~1000–4000 SDF evals/px** | LOW visually, but GPU-bound | **rewrite** |
| 29 | `classic/GlossLinesShader.shader`, `classic/MaskableGlossLinesShader.shader`, `champions_wish/…`, `tv_party/…` | texture distortion / UI stencil masking | require `_MainTex` + `_DistortTex` PNGs | **No** | — | — | skip |
| 30 | `/Users/ubberkid/bingo/Assets/Avatars/*/*.shader` (7 files) | avatar glow/tail/cloud — all `tex2D(_MainTex, …)` with noise-texture UV distortion | require avatar PNGs | **No** | — | — | skip |
| 31 | `/Users/ubberkid/bingo/Assets/Shaders/*.shader` (~95 files) | SDF UI, gradient maps, masks, progress bars, stencils | nearly all require `_MainTex`/`_NoiseTex`/`_DistortTex` | **No** (only `RadialGradient.shader` is procedural, and it's a 2-color radial) | — | — | skip |
| 32 | `/Users/ubberkid/giddy-games/**/src/shaders/*.glsl` (17 files) | Pixi v8 filters: scratch reveal, gradient map, UV scroll, cloud distortion, progress bars, transition overlay | all require `uTexture` | **No** | — | — | mine for noise only |

### Prism caveat worth flagging

In `prism/Prism.shader:146-155`, `px()` has its `if (h.x>64)` guard commented out, so it **unconditionally returns the background gradient** — the `fc` refraction chain contributes nothing visible. The entire visible image is the accumulated `glw` glow (line 120: `glw += 0.02/(0.01*s*s)*normalize(p*p)`) added to a background lerp. That means ~95% of the 128-step × 8-bounce cost produces no output. A faithful-looking WebGL port can drop the refraction loop to 2-3 bounces and 48 steps, or reconstruct the look from the glow accumulator alone, at a fraction of the cost. Verify against a Unity screenshot before committing.

### Lines worth preserving verbatim

- **Plasma's `map()`** — `Plasma.shader:97-103`. Three lines; the entire lava-lamp look lives here. `length(p+sin(t*0.7))*log(length(p)+1.)+sin(q.x+sin(q.z+sin(q.y)))*0.5-1.`
- **iq cosine palette** — `rainbow_rays_shader.shader:73-80` (a/b/c/d = `.6,.5,.5` / `.5` / `1` / `0,.33,.67`) and a second tuned variant in `radiant_harmony_shader.shader:112-119`.
- **`hash` + `vnoise` value-noise pair** — `serenity_waves_shader.shader:149-168`.
- **`tanh_approx`** — `serenity_waves_shader.shader:143-147`, `clamp(x*(27.+x2)/(27.+9.*x2),-1.,1.)`. Cheaper than GLSL's `tanh()`.
- **`aces_approx` tonemap** — `serenity_waves_shader.shader:131-141`. Use for any preset with bloom-ish HDR output.
- **`pmin`/`pmax` polynomial smooth min/max** — `ColorfulInterference.shader:95-104`.
- **`hsv2rgb` K-vector form** — `serenity_waves_shader.shader:101-108`.
- **2-D hash** — `Voronoi_Circle.shader:83-88`: `frac(P.xyx*vec3(123.45,345.678,567.89)); a += dot(a,a+518.); return frac(a.y*a.xz)`.
- **iq SDF primitives** — `tri()` in `triad_nexus_shader.shader:103-112`, `arc()` in `infinite_rings_shader.shader:120-124`, `sdTunnel()` in `radiant_harmony_shader.shader:95-105`, `sdBox()` in `Voronoi_Square.shader:90-94`.
- **A complete, already-WebGL2 noise library** — `/Users/ubberkid/giddy-games/games/plinko-sands/src/shaders/ElectricShader.glsl:83-195`: `hash`, `hash2`, `valueNoise`, `gradientNoise`, `simplexApprox`, `worleyF1`, `worleyEdge`, ridged, billow, `fbm` with lacunarity/gain, and domain warping — all behind a `sampleNoise(p, type)` dispatcher. Written in GLSL ES 3.00 (`in`/`out`, no `varying`), so it lifts into a WebGL2 fullscreen quad verbatim.

### Per-preset palettes are already authored

Each banner ships 8 color variants as Unity `.mat` files (`plasma_banner_{,black,blue,green,pink,purple,red,white,yellow}_material.mat`). E.g. `plasma_banner_material.mat` = `_Background (0, 1, 0.428)`, `_Background2 (0.396, 0, 1)`, `_Color1 (0.671, 0.471, 0)`, `_Color2 (0.873, 1, 0)`. Grepping `_Color1:`/`_Color2:`/`_Background:` out of `Assets/Banners/*/*.mat` gives you ready-made palette presets for free — no color design work needed. Note Unity stores these **linear**; convert to sRGB for CSS/WebGL default framebuffer, or render into a linear FBO.

## Port plan — ranked by wow-per-effort

**Tier 1 — ship these five first.** All are single-file, zero-texture, low-entropy, and cost under an hour each after the shared harness exists.

1. **`plasma` / "lavalamp"** — `/Users/ubberkid/bingo/Assets/Banners/plasma/Plasma.shader`. The one the user named, and it earns it: slow molten blobs, smooth gradients, 22 SDF evals, exactly the low-entropy profile the compressed-frame pipeline wants. Drop the `fixed2(1.5,.5)*2` framing on line 109 and re-center `p1` for square.
2. **`colorful_interference`** — `/Users/ubberkid/bingo/Assets/Banners/colorful_interference/ColorfulInterference.shader`. No loops at all, two drifting glowing ring-fields with smooth-min blending, and it already has a `smoothstep(1.5, 0.5, length(pp))` radial vignette that reads as designed-for-a-circle.
3. **`twisted_nebula`** — `/Users/ubberkid/bingo/Assets/Banners/twisted_nebula/twisted_nebula_shader.shader`. The cheapest real wow in the set: ~20 ALU, no loops, 3 tunable colors, pure smooth gradient motion. Use it as the reference port to validate the harness.
4. **`satin_swirl`** — `/Users/ubberkid/bingo/Assets/Banners/satin_swirl/satin_swirl_shader.shader`. Aurora ribbons; the most "premium" look per line of code, and its radial `fade` term already suits a round display. Fully parameterized (freq/speed/stripe width/noise amp) so it doubles as your knob-testing preset.
5. **`triad_nexus`** — `/Users/ubberkid/bingo/Assets/Banners/triad_nexus/triad_nexus_shader.shader`. Big, bold, geometric, 10 cheap iterations, very low entropy. Visually the strongest contrast to the four organic ones above, so the preset list feels varied immediately.

**Tier 2 — add once the harness is proven:** `color_spiral` (near-free, one line), `wave_ripple`, `voronoi` + `voronoi_square` (great look, but profile the 50-iteration loop at 640²), `wavy_gradient` (its deliberate 0.05 posterization suits an LCD), `infinite_rings`, `gridzone/HalftoneZoom`, `classic/ClassicBanner` (a genuinely free "calm" option).

**Tier 3 — only if you want a heavy showpiece:** `chromatic_vortex`, `peaceful_pathways`, `triangle_warp`.

**Avoid or defer:** `prism` (rewrite-tier cost for output that's mostly a glow accumulator — see caveat above; if the user insists on prism, budget it as its own task), `fire` and `serenity_waves` (high-entropy fine noise, worst case for a compressed-frame pipeline), `neural` and `radiant_harmony` (beautiful but high-entropy filaments — add a `uDetail` uniform to soften them if you do port them), everything under `Assets/Shaders/`, `Assets/Avatars/`, and the four texture-dependent banners.

**Suggested harness shape:** one WebGL2 fullscreen-quad renderer in a new `src/modules/shader/` (mirroring `/Users/ubberkid/kraken-hub/src/modules/_template/`), with a fixed uniform contract — `uTime` (seconds), `uResolution` (`vec2`, from `ctx.geometry()`, never a literal — invariant noted in the template header), and `uColor0..uColor3` — plus a per-preset fragment string. Every Tier-1 and Tier-2 shader above fits that contract without extension, which is why the porting cost collapses after the first one.