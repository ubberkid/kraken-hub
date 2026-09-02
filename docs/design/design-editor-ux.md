# kraken-hub — Looks & the Editor: UX specification

**Status 2026-09-02:** waves W5, W6, W7 and W8 shipped, and the editor-fix round after them — which built the per-layer lock of §2.2 (`Layer.locked`, an optional field on the layer model), multi-select with align and distribute (§2.1), and the inspector of §2.4. The measured deviations still standing are recorded in [`docs/editor.md`](../editor.md) and in the CHANGELOG's `[Unreleased]` section: rotation ticks are every 15° rather than the 0/15/45/90 ladder of §2.1 and §11, the add, Looks and inspector sheets stand over the rail in its own column rather than as a row under the halo (§2.4), and undo is fifty steps rather than a hundred (§1.4). Still unbuilt from §10's parity list: the three audio kinds (they need a companion that does not ship, and are shown greyed with the reason), the `.krakenlook.zip` bundle of §4, and the screenshot-of-the-face PNG.

Companion to the layer architecture spec (judge-panel synthesis). This document owns the *experience*; the architecture spec owns the model. Where they disagree, the model wins on data, this document wins on behaviour.

## 0. Vocabulary (user-facing, single-sourced in vocabulary.ts)
- **Look** — a saved arrangement of layers on the Kraken (ESC: "preset"; CAM: "display mode"). *The Kraken shows one Look at a time.*
- **Layer** — one thing in a Look: a video, an effect, a picture, a sensor, a clock, text, a shape… (ESC: "element"). Base layers fill the panel; overlay layers sit on top. "Add a layer" is the one creation gesture.
- **Effect** — a generated background (never "shader"). **Preset** — an effect's colour set (from the user's materials) or a Look template.
- **Templates** — designed Looks that ship with the app. **Your Looks** — the user's saved Looks. **Gallery** — community Looks (see §9).
- Never shown: element, compositor, z-index, uniform, layer kind ids.

## 1. Principles (each is a tested invariant where marked ✓)
1. **The canvas is the halo.** You design ON the live mirror, at the largest size the window allows — never a thumbnail beside a form. At 866×537 the halo is ≥ 400px; 1:1 (640) and 2× available by wheel/pinch. ✓ (halo px ≥ 400 at CAM size)
2. **Direct manipulation first, numbers second.** Move by dragging, scale by handles, rotate by the lollipop; numeric fields live one level down. ✓ (no numeric x/y/rotation on the primary surface)
3. **One selection, a few controls.** Selecting a layer shows a floating strip with that layer's 3–5 essential controls; everything else is behind "More". Nothing else on the screen changes. ✓ (primary strip ≤ 5 controls per layer kind — enumeration test over all kinds)
4. **Undo is everywhere and cheap.** Cmd/Ctrl-Z / Shift-Z, visible buttons, 100 steps (shipped: 50 — see status), survives look switches, includes drag/scale/rotate as single steps. ✓
5. **Smart placement, never a pile.** New layers spawn in the first free slot (auto-placement avoiding overlaps within the safe area) and ease in. ✓
6. **Snap to the circle.** Guides appear only while dragging: centre crosshair, safe ring, edge/centre alignment with other layers, 0/15/45/90° rotation ticks. Smooth, springy settle on release. ✓ (drag near centre lands exactly at 0,0)
7. **Never silent, never a lie.** Media is validated on add with fit/fill/cover shown on a live circular crop preview; every failure is an honest card; every panel-state claim goes through the presence spine (already law).
8. **The frame budget is the limit.** No arbitrary "40 elements": each layer carries a cost; the budget meter reads the governor; the app names the layer that costs most when a stack exceeds budget. ✓
9. **Design for 866×537 first.** Header ≤ 56px; no clipped sheets (sheets scroll inside themselves); no toasts over sheets; the add sheet shows every kind at CAM size. ✓ (page-fit × states, as before)
10. **Phone edits the same Look.** The remote's replica ring is the canvas on a phone: same gestures, sent as transform commands; optimistic, causally reconciled.
11. **Buttery.** Transforms spring to rest; look switches cross-fade; values glide (FrameClock-driven, never React-per-frame). ✓ (I4)
12. **Never watermark, never gate, never nag.** MIT. (Contrast: ESC's supporter overlay on the physical panel.)

## 2. The editor surface (CAM window / desktop)
Layout at 866×537 (also scales up; never below): **halo left** (≈ 420px canvas incl. bezel), **layer rail right** (≈ 300px), **selection strip** under the halo, nothing else. Header: wordmark, Looks menu (current Look name ▾), undo/redo, budget meter. No tabs.

### 2.1 Canvas
- Bezel-framed live mirror (the existing halo/replica), rendering the actual Look with real telemetry; editing overlays (bounding box, guides, handles) are drawn in a separate SVG layer above the mirror — never inside the display bundle (I8).
- Zoom: 0.5×…2×, wheel/pinch, double-tap to fit. Pan when zoomed.
- Hit-testing on layers' transformed bounds; tap selects; tap empty deselects; drag empty = marquee multi-select; Shift-tap adds.
- Handles: 4 corner scale (uniform; Alt = from centre; Shift = free aspect where meaningful), 1 rotate lollipop above; all hit targets ≥ 24px (44 on touch). HUD shows the *readable* value (x, y, °, size) upright regardless of rotation.
- Keyboard: arrows nudge 1 (Shift 10), Delete/Backspace, Cmd/Ctrl-D duplicate, Cmd/Ctrl-Z / Shift-Z, Esc deselect, [ ] z-order, Cmd/Ctrl-A select all.
- Multi-select: group move/scale/rotate; align (left/centre/right/top/middle/bottom, to canvas or selection), distribute; these appear in the strip only when ≥ 2 selected.

### 2.2 Layer rail
- Ordered top→bottom = front→back. Each row: kind glyph/mini-preview, name (rename inline), eye (visibility: Always · Never · When music plays · When idle — the last two arrive with the audio layer), lock, drag handle (reorder = z-order). Row height 40; base layer pinned at the bottom with a "Base" label.
- "+ Add a layer" at the top opens the **add sheet** (§3). Layer count is not shown; the **budget meter** is (§6).
- Context menu / long-press: duplicate, bring to front/send to back, delete (confirm only when the layer has custom settings).

### 2.3 Selection strip (contextual controls)
Appears under the halo for the selected layer; ≤ 5 controls; the last is always **More** (opens the inspector sheet, which is the only place numeric fields, fonts, advanced options live). Per kind:
- Sensor: metric · style (Number / Ring / Bar / Chart) · size · colour · More
- Text: text field · size · colour · font · More
- Clock: face (Digital/Analog) · 12/24 · seconds · colour · More
- Date: format preset · size · colour · More
- Shape: shape (Rect/Circle/Line) · fill · stroke · More
- Image/Sticker: source · fit · opacity · More
- Video (base): source · fit · loop · quality · More
- Effect (base): effect · preset · custom colours · reacts-to-temp · More
- Picture (base): source · fit · slideshow · More
- Audio visualizer: style · bands · colour · More; Now playing: fields · size · More; Album cover: size · corner · More
✓ enumeration test: every registered kind declares its strip; count ≤ 5.

### 2.4 Inspector sheet ("More")
Right-side sheet over the rail (never over the halo), scrolls internally, house Segmented/Switch/Slider only (no native selects), sections: Layout (x, y, size, rotation, opacity — numeric, tabular), the kind's full settings, Visibility, Advanced. Escape closes.

## 3. Add sheet
Four groups, same as ESC's taxonomy because it is right, but with previews: **Content** (Text, Shape, Icon, Sticker, Picture), **Data** (Sensor number, Ring, Bar, Chart, Group tile), **Time** (Clock, Analog clock, Date), **Audio** (Now playing, Album art, Visualizer — greyed with "needs the audio companion" until detected). Each tile is a live-ish mini render with a one-line description. At 866×537 all tiles are reachable (sheet scrolls; header stays). Choosing one adds it with smart placement, selects it, shows its strip. Base layers are picked from the base row (Video / Effect / Picture / Clock face / Solid colour) — one base at a time; picking a new base cross-fades.

## 4. Looks
- **Templates** on first run and in the Looks menu: the designed stats faces (Single, Dual, Triple, Overlay), "Lava lamp + temps", "Sunset loop + clock", "Minimal clock", "Photo + date", etc. — each a real Look file rendered live.
- **Your Looks**: live-rendered previews (the replica renders any Look file at thumbnail size), rename/duplicate/favourite/delete, drag to reorder. Applying is non-destructive: the current Look autosaves; switching cross-fades; undo crosses the switch.
- **Files**: `.krakenlook` = layout + per-layer configs + media by reference (source URL or content hash); tiny (KB). Optional **bundle** (`.krakenlook.zip`) embeds referenced media from the library for sharing — chosen explicitly, never a 10 MB JSON by surprise. Import validates, migrates (schema history map), resolves media (present in library / fetchable URL / missing → placeholder layer with a clear card), never rejects on optional fields.
- **Carousel** (CAM parity): a Look can rotate among a chosen set on an interval, with cross-fade.

## 5. Media in the editor
- Adding a picture/video/sticker opens the existing library (+ paste/drop/send-from-phone), with a **circular crop preview** showing fit/fill/cover live before confirming; landscape clips never land as a letterboxed donut by default (cover).
- Validation and honest failures as already shipped (paste spine, error cards); GIF search via a "paste a GIPHY/Tenor link" affordance (no API keys shipped).

## 6. Frame budget
- Each layer kind declares a cost class (static / low-motion / high-motion / video / effect). The meter = governor's achieved fps vs target, with an inline attribution ("Nebula is the heaviest layer") when over budget. Suggestions, not blocks. At targetFps ≤ 5 the strip shows the FPS advisory (existing).

## 7. Motion
- One spring curve for UI; transforms settle with a short spring on release; look switches cross-fade 350ms; layer add/remove fade+scale; values glide in the renderer (see quality bar). Reduced-motion honoured.

## 8. Phone
- The remote's ring is the canvas: tap to select, drag/pinch/rotate (touch handles 44px), strip below, undo, layer rail as a sheet. Ops are commands; optimistic with causal reconcile. The Looks menu works from the phone. Add-a-layer works from the phone (adds default at a free slot).

## 9. Gallery (beating Explore, honestly)
- v1: a **curated gallery** in-repo (`looks/*.krakenlook` + author + description) rendered as a live-preview grid in the app (the replica renders each), applied non-destructively. Submissions = a GitHub PR with a `.krakenlook` (docs describe it; issue template). No backend, no accounts, no tracking. "Send yours" links to the PR guide.

## 10. Parity checklist (must all exist; measured by an enumeration test over registered kinds)
Text · Shape · Icon · Sticker · Picture · Sensor number · Ring gauge · Bar gauge · Chart (sparkline history) · Clock · Analog clock · Date · Video base · Effect base · Picture base · Solid base · Now playing · Album art · Audio visualizer (the last three consume the NowPlaying.WebSocket protocol on localhost:27871 when present — probe on demand, no polling storm, backoff; setup card names the companion honestly) · Look templates ≥ 8 · Look import/export · Carousel · Screenshot of the face (PNG download from the mirror) · Fonts: system + 6 curated faces loaded lazily only when a layer uses them.

## 11. Fidelity tests the auditors will run
Halo ≥ 400px at 866×537 · every kind's strip ≤ 5 · undo across 10 random ops restores exactly · new layers never overlap existing ones · drag to centre snaps 0,0 · rotation snaps at 0/15/45/90 within 3° · all handles ≥ 24 (44 touch) · add sheet fully reachable at CAM size · page-fit × all editor states · no native controls · vocabulary/claims spines · look file round-trip (export→import identical) · import with missing media yields a placeholder with an honest card · budget attribution names the heaviest layer.
