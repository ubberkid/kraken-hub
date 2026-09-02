# W0 — layer-stack measurements (simulator)

What the W0 spike was for: measure the cost of DOM-stacked layers **before**
`design-layers-architecture.md` §2 becomes real code, and settle the one DOM
question the reorder path depends on. Everything here is the **page side** on a
developer machine. The capture side — what the LCD actually shows once CAM has
compressed it — cannot be measured from inside the page and is still open as
H24–H28 in `docs/hardware-checklist.md`.

The throwaway half is gone. `src/render/compositor.spike.ts` was deleted with W3
and `?pattern=stack` now composites through the real `src/render/LayerHost.ts`,
so the five stacks can be re-measured against the shipping compositor rather
than a stand-in. What remains from the spike is the measurement surface itself:
`src/diag/patterns/stack.ts` (the five looks), the `?pattern=stack` branch in
`DiagOverlay.tsx`, the `&stack=` flag, and the per-layer lines in
`DebugOverlay.tsx`, which now read `LayerHost.stats()`.

The **stand-in kinds are gone too**, as of W7's close-out. The two throwaway
kinds this file's tables were recorded against — a canvas gradient called
`plasma` and a bare DOM node called `label` — have been replaced by the real
`effect` and `text` modules, through the real registry. Nothing else about the
stacks changed: same ids, same layer ids, same boxes, same translucency, same
surface counts, and the two real kinds occupy the same cost slots the stand-ins
were chosen to imitate (`effect`: `cadence:'frame'`, `coverage:1`, one GL
context; `text`: `cadence:'static'`, no `frame()`). Everything below is
therefore still the shape of the answer — but the numbers were taken with the
stand-ins in place and are **due a re-run**, because the effect module's base is
a real WebGL fragment program rather than two radial gradients on a 2D canvas.
Rows naming `plasma` below are naming the stand-in, as recorded.

## How it was run

- Build: `vite build` to a scratch `outDir`, served by `vite preview` on a
  custom port (nothing wrote `dist/`, no default port was bound).
- Driver: a throwaway Playwright script, headless Chromium, one page per stack,
  viewport 700×700, `--autoplay-policy=no-user-gesture-required`.
- URL per stack: `?kraken=1&diag=1&pattern=stack&stack=<id>&sim=elite&fps=40`
  → the Elite preset, `targetFps` 40, i.e. a 25 ms frame budget.
- 4 s warm-up, then a 12 s measurement window (~480 delivered frames).
- Per-layer timing is the spike's own: `performance.now()` around each
  `renderer.frame()`, EMA(α = 0.1) plus a 64-entry ring for p95, all in closure
  state — no React touched per frame (invariant I4).
- Machine: Apple Silicon macOS, Chromium 1.62 bundled with Playwright.

**Read the per-layer numbers with one caveat:** Chromium coarsens
`performance.now()` to 100 µs, so every per-call figure below is quantised to
0.1 ms. That is not precision loss that matters here — it means every layer's
`frame()` is at or under the smallest interval the clock can express, against a
25 ms budget.

## The five stacks

| id  | layers                                                          | translucent surfaces |
| --- | --------------------------------------------------------------- | -------------------- |
| a   | video base + stats strip                                        | 0                    |
| b   | video base + stats + clock + text                               | 0                    |
| c   | effect base + stats                                             | 0                    |
| d   | effect base + effect overlay + stats + clock + text, `a:0.8`    | 4                    |
| e   | eight layers (effect base, effect overlay, 2× stats, 2× clock, 2× text) | 1              |

The `effect` base and overlay are the real module in its Lava lamp / Classic
preset — the defaults a fresh install shows — and `text` is the real module on
the `system` face, so neither fetches a font stylesheet or a palette table
during a run. When these tables were recorded, both were stand-ins: `plasma`, a
2D-canvas double radial gradient redrawn every tick, and `label`, one DOM node
with no `frame()`. That is why the per-layer rows below still say `plasma`.

## Page-side results (12 s window, targetFps 40)

| stack | achievedFps | longFrames | frames delivered | Σ EMA per tick | worst layer p95 |
| ----- | ----------- | ---------- | ---------------- | -------------- | --------------- |
| a     | 40.03       | 0          | 481              | 0.005 ms       | video 0.0 ms    |
| b     | 40.08       | 0          | 480              | 0.024 ms       | clock 0.1 ms    |
| c     | 40.00       | 0          | 480              | 0.002 ms       | plasma 0.1 ms   |
| d     | 39.98       | 0          | 480              | 0.006 ms       | plasma 0.1 ms   |
| e     | 39.97       | 0          | 480              | 0.022 ms       | plasma 0.1 ms   |

Per layer (EMA / p95 / max, ms), same window:

| stack | layer                | EMA   | p95 | max |
| ----- | -------------------- | ----- | --- | --- |
| a     | base video           | 0.005 | 0.0 | 0.2 |
| a     | ov1 stats            | — no `frame()` |  |  |
| b     | base video           | 0.013 | 0.1 | 0.1 |
| b     | ov2 clock            | 0.010 | 0.1 | 0.2 |
| b     | ov1 stats, ov3 text  | — no `frame()` |  |  |
| c     | base plasma          | 0.002 | 0.1 | 0.3 |
| d     | base plasma          | 0.005 | 0.1 | 0.4 |
| d     | ov1 plasma (circle)  | 0.000 | 0.0 | 0.1 |
| d     | ov3 clock            | 0.001 | 0.0 | 0.1 |
| e     | base plasma          | 0.010 | 0.1 | 0.4 |
| e     | ov1 plasma (circle)  | 0.005 | 0.0 | 0.1 |
| e     | ov3 clock            | 0.006 | 0.0 | 0.1 |
| e     | ov6 clock (analog)   | 0.001 | 0.0 | 0.1 |
| e     | stats ×2, text ×3    | — no `frame()` |  |  |

### What that says

1. **The fan-out is free at this scale.** Eight layers cost 0.022 ms of JS per
   tick in total — under 0.1 % of the 25 ms budget, and inside the clock's own
   resolution. §7.3's "≈ 0.01 ms × N" estimate holds.
2. **`achievedFps` does not move from a→e** (40.03 → 39.97, i.e. noise) and
   `longFrames` is **0 in every stack**. Depth of stack, on the page side, is not
   what costs frames.
3. **Layers that do not animate cost literally nothing.** `stats` and `text`
   implement no `frame()` and are never called; the compositor skips them in the
   fan-out loop. That is the design's central claim about layout overlays, and
   it is true by construction rather than by measurement.
4. **Four translucent overlays (stack d, 4 extra compositor surfaces) cost no
   measurable page-side FPS.** That is a GPU-compositing cost, not a JS cost, so
   this is the expected result and NOT evidence about the capture side — a
   translucent overlay changes many more pixels per frame, which is exactly what
   the compressor charges for. The `+0.1` opacity charge in the cost model
   (§7.2) stays justified on entropy grounds, not on this number.
5. **These numbers do not transfer to CAM hardware.** A developer laptop's
   Chromium is not an Electron 32 webview on a mini-ITX box, and none of this
   sees the compressor at all. H24–H27 are the same measurements on real
   hardware; H28 is the question that decides the governor's design.

## The DOM-move question (Chromium, verified)

§2.6 promises "order changed → `root.insertBefore`, 0 raster". Measured in the
same Chromium, moving a live element between two parents:

| element                     | survives `insertBefore`?                                                          |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `<canvas>` with a WebGL2 context | **Yes.** `getContext('webgl2')` returns the same object, `isContextLost()` is false, and `readPixels` still returns the pixel drawn before the move (`0,255,0,255`). |
| `<iframe>`                  | **No.** `contentWindow` and `contentDocument` are both replaced — the frame re-navigates. |

That asymmetry is the whole reason **the base layer never moves in the DOM**.
The base is the only layer that can be a `video` (`roles:['base']`,
`maxInstances:1`), a YouTube base is a cross-origin `<iframe>`, and reordering
it would reload the embed, lose the playback position and buy a network round
trip. Overlays are canvases, `<img>`s and DOM — free to reorder. Both halves are
carried as a unit test in `src/render/layerReorder.dom.test.ts` (jsdom
models the iframe half faithfully; the WebGL half is skipped there for want of a
canvas implementation, and is the Chromium measurement above).

## Bundle note

While the spike existed it lived in `src/render/`, so it was bundled into the
`render-shared` chunk, which grew from ~1.1 kB to ~4.7 kB raw (2.25 kB gzip),
and `display-shell` did **not** statically import it — it appeared only as a
dynamic import from `DebugOverlay`'s gated `import()`.

That changed in W3, and deliberately. `display-shell` now imports
`src/render/LayerHost.ts` statically, because the compositor IS the display, so
`render-shared` is on the critical path and is counted there: it was added to
`displayCriticalPath.chunks` in `budgets.json` rather than left outside the gate.
Hiding real bytes behind a dynamic import that the display always takes would
pass the gate while shipping the same page. `src/diag/patterns/stack.ts` remains
its own chunk, reached only from the lazily-loaded `DiagOverlay`.

## Still open after W0

- **H24–H27** — the same five stacks on real CAM hardware, page side and filmed
  counter side.
- **H28** — does compressor load reduce page `achievedFps`? Unanswered, and
  unanswerable from a simulator. Until it is answered, every declared layer cost
  in the UI is labelled an **estimate**.
