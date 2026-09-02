I drove the live app (v6.08.20 at `https://nzxt-esc.pages.dev/`) with Playwright/Chromium at 1512×945, 866×537 (CAM window), 390×844 and real iPhone-13 emulation, plus the `?kraken=1` display face at 640×640. I also pulled the GitHub tarball for cross-reference.

---

# NZXT-ESC teardown

## 0. Methodology + a headline finding about the repo

The GitHub repo is **not** the shipped product. `package.json` says `5.12.0-build08`; the live site says `v6.08.20`. Worse, the tarball **does not build**: `nzxt-esc-main/src/ui/Config.tsx` is a 56-line **CSS file mis-named `.tsx`** (line 18 is `.bounding-box {`), so `vite` dies immediately with `Unexpected "."`. The repo's `index.html` is also just a redirect stub to the Pages site. So the "open community project" is effectively a stale, non-compiling snapshot; everything below is from the hosted build.

Exported preset JSON self-identifies as `"app": {"name": "NZXT-ESC-DEV"}` — the production build ships a DEV app name.

---

## 1. First run (desktop 1512×945)

`01-firstrun-desktop-1512.png`, `02-firstrun-desktop-consented.png`

- CookieYes consent sheet bottom-left + a permanent orange floating cookie badge, plus a third-party **"Open chat"** widget that overlaps content at every breakpoint.
- Content is locked to a ~784 CSS px centre column. At 1512 wide that leaves **~365px of dead black on each side and ~700px of dead space below the panel**. The app was clearly designed for the CAM window and never adapted upward.
- **The preview canvas is 250×250 CSS px** (`.preview-viewport`) for a 640×640 display — a 0.39× design surface, while 60% of the screen is empty. You are laying out a 640px face inside a 250px circle.
- The "NZXT CAM API unavailable" toast opens **expanded, centred over the preview circle**, obscuring the one thing you came to look at, for ~8s before collapsing into a small badge. With a preset containing audio elements you get a **second** stacked badge (`50-CAM866x537-background-tab.png` shows two).
- A raw session UUID (`68714853-dba6-4c16-…`) is rendered in the page footer in production.
- No onboarding. The genuinely good "Getting Started" content is buried behind a header button (see §7).
- Background tab first-run controls: **3** (Show Overlays toggle, Color swatch, Media "Add") + one "Next Step" CTA. That is a very clean, low-intimidation entry point — a real strength.

## 2. Overlay tab / empty state

`03-overlay-tab-empty.png`, `04-add-element-picker.png`

- Nice empty state: a big dashed "Add your first element — start building your overlay with sensors, clocks, text, graphics and more."
- Canvas prefs: **Overlay Guides** toggle, **Alignment Grid** toggle, **Show Background** (opacity slider + on/off toggle). The alignment grid is a **static 6×6 square grid over a circular display** — no radial guides, no centre crosshair, no safe-zone ring for the bezel. `16-alignment-grid-on.png`.
- Add-element menu: **17 types in 4 groups** — CONTENT (Text, Shape, Icon, Sticker, Image), DATA (Sensor, Radial Graphic, Linear Graphic, Vertical Graphic, Circle Graphic, Sensor Chart), TIME (Clock, Analog Clock, Date), AUDIO (Album Cover, Now Playing Text, Audio Visualizer). Each row has a one-line description — well written, well grouped.
- **At 866×537 this menu is clipped**: only 5 of 17 types are reachable without scrolling inside the dropdown (`52-CAM866x537-add-menu.png`). This is the primary "add" affordance in the primary form factor.

## 3. The layout editor itself

`12-selected.png`, `13-dragging.png`, `18-rotating.png`, `20-resizing.png`, `21-snap-near-center.png`

What works:
- Click-to-select in the preview gives a cyan bounding box with a live drag HUD: `X: -90px | Y: 108px`, `71°`, `83px`. Direct-manipulation values match the numeric fields.
- Arrow keys nudge selected elements by 1 unit.
- Element card header is a solid 8-action row: **Move toward front, Move toward back, Rename, Visibility, Lock, Delete, Duplicate, Collapse** + a drag handle. Visibility is a 4-state menu — Always Show / Always Hide / **Show with Music / Show without Music** — which is a genuinely clever idea.
- Auto-save is instant to LocalStorage; state survives reload with no "Save" button.

What is broken or missing:
- **No undo. At all.** `Ctrl+Z` and `Cmd+Z` do nothing; there is no Undo/Redo button anywhere. Combined with an instant destructive "Add" from Explore (which overwrites the live layout without confirmation), this is the single biggest risk in the product.
- **Two handles total**: one rotate handle above, one resize handle at bottom-right. No corner/edge handles, no aspect lock, no shift-constrain.
- **Handles are 7–8 CSS px** (`rotate` 7.81px, `resize` 7.03px). Far below any comfortable hit target, and they get smaller relative to content in the CAM window.
- **No snapping.** Dragging back toward dead centre lands at `X=1, Y=1`, not 0,0. No centre snap, no edge snap, no alignment guides between elements, no rotation snap (I got 74°, then 71°).
- **The drag/rotate HUD rotates with the element** — at 71° the "71°" label renders sideways and unreadable (`18-rotating.png`).
- **Every new element spawns at the exact centre, stacked.** Adding a Clock next to a Sensor produces an unreadable "43:4°C" mash (`31-two-elements-editor.png`). No cascade offset, no collision avoidance, no auto-placement.
- **No multi-select.** Shift-click leaves a single bounding box; marquee-drag on empty canvas does nothing (`88-shift-multiselect.png`, `89-marquee-attempt.png`). So no group move/align/distribute — and there are no align/distribute controls anywhere.
- Keyboard coverage tested: `Ctrl/Cmd+D` (duplicate) ✗, `Delete`/`Backspace` ✗, `Escape` ✗, `Ctrl+C` ✗, `Shift+Arrow` = same 1px as plain Arrow ✗.
- Z-order is **±1 step only** (chevrons). No "bring to front/send to back".
- The element list header row (`Overlay Elements (N) / Collapse All / Add`) is **rendered twice**, above and below the list.
- **All element cards are expanded by default.** At 40 elements you get 40 open inspectors, ~200–650px each, in one scroll column (`87-element-limit.png`).

## 4. Element inspectors — control counts

Counted per element card at 1512px (buttons include the 5 sub-controls of every numeric stepper: `[icon][−][value][+][↺]`).

| Type | Labelled settings | selects | numeric | color pickers | buttons | card height |
|---|---|---|---|---|---|---|
| Text | 7 | 0 | 4 | 1 | 21 | 213px |
| Shape | 7 | 0 | 6 | 1 | 27 | 207px |
| Icon | 7 | 0 | 5 | 1 | 25 | 227px |
| Sensor | 9 | 3 | 4 | 1 | 21 | 252px |
| Radial Graphic | 17 | 3 | 8 | 3 | 35 | 417px |
| Linear Graphic | 10 | 1 | 6 | 2 | 28 | 275px |
| Vertical Graphic | 12 | 2 | 8 | 2 | 34 | 310px |
| Circle Graphic | 13 | 1 | 8 | 3 | 35 | 343px |
| Sensor Chart | 15 | 4 | 8 | 1 (+1 slider) | 33 | 395px |
| Analog Clock | **20** | 5 | 6 | 5 | **36** | **627px** |
| Album Cover | 9 | 0 | 7 | 2 | 33 | 349px |
| Now Playing Text | 11 | 2 | 5 | 1 | 25 | 333px |
| Audio Visualizer | 9 | 1 (10+ styles) | 7 | 1 (+8 sliders) | 31 | **654px** |

Other surface counts:
- Background tab, empty: **3** controls. With media: **9** (Show Overlays, Overlay Guides, Color, Update, Remove, Resize, Rotate, X, Y) = 26 buttons on screen.
- Overlay tab canvas prefs: **5**.
- Typical working screen (Overlay tab, one Sensor selected): **36 buttons, 6 inputs, 3 selects** visible simultaneously.
- Style drawer: ~30 controls (SV area, hue, alpha, HEX + R/G/B/A fields, 20 swatches, 3 mode icons, Outline Thickness).
- Fonts: **7 only** — Default, Digital Clock, Audiowide, Orbitron, Pixelify Sans, JetBrains Mono, Inter/Roboto.
- Sensors: **16** (CPU/GPU temp, load, clock, power, fan; Liquid Temp; Memory Usage/Total; CPU+GPU total power; CPU Name; GPU Name).
- Distinct UI surfaces in the app: **~22** (2 tabs, add menu, 17 inspector variants, style drawer, visibility menu, media modal ×3 tabs, KLIPY picker, Explore, Library drawer, preset "More" menu, export modal, import, create preset, Announcements, Getting Started, language menu, 2 toast types, supporter gate, screenshot action).

Visual problems in the inspectors:
- **Raw unstyled native `<select>`** elements with OS chrome, next to fully custom toggles and steppers. Jarring (`05-sensor-added.png`).
- The **Font** field renders the word "Default" at ~22px in a bold display face inside a 24px-tall control — looks like a rendering bug.
- The style swatch is a big plain white rectangle with no label.
- Steppers cram 5 targets into ~160px.
- The **Style drawer is light-themed** in an otherwise all-dark app (`81-text-style-panel.png`) — white background, black text, full-height right drawer. It also shows a **"Border Color" heading with no control under it**, and "Outline Thickness (px)" as a bare number input with none of the stepper affordances used everywhere else.

## 5. Media / backgrounds

`22-media-add-modal.png`, `23-media-url-panel.png`, `24-media-klipy-panel.png`

- Three sources: **Local Media** (JPG/PNG/APNG/GIF/WebP/AVIF/MP4, IndexedDB, never uploaded — with an explicit "Your files stay private" reassurance panel, which is excellent), **URL** (adds **YouTube** and **Pinterest Pin** support), and **GIF & Clips** powered by **KLIPY** (trending grid + search). The KLIPY picker is the best-feeling thing in the whole app — click a tile and it applies instantly.
- Bugs / gaps:
  - The CAM warning toast renders **on top of the modal**, un-blurred, covering the modal title and description (`22-media-add-modal.png`).
  - Copy leak: the URL examples read `https://****.com/medya.jpg` — "medya" is Turkish, left in the English locale.
  - **Silent failure**: I pasted an MP4 that Chrome blocked (ORB). The app accepted it, switched to "Update/Remove" state, and rendered pure black with **zero error, warning, or fallback** (`26-video-bg-applied.png`).
  - **No fit/fill/cover control.** A 16:9 clip lands "contained" inside the circle with a thick black donut (`30b-TASKSPEED-preview.png`). Fixing it means guessing numbers in a `Resize` stepper (1.00 → ?). There is no crop UI, no aspect preview in the picker.
  - KLIPY tiles are landscape thumbnails in a 3-column grid with no indication of how they'll be masked to a circle.

## 6. Presets — Explore and Library

`32-explore.png`, `35-library.png`, `36-library-more-menu.png`, `86-export-modal.png`, `90-CAM866-explore.png`

**Explore is the standout surface.** ~121 community presets, each rendered as a **live circular preview** (clocks actually tick, GIFs actually play), with author attribution and download counts, plus search / category / sort (Newest, Most Downloaded, Name A-Z). "Send your preset →" CTA at the bottom. This is the moat: nothing else in this niche has it.

Problems:
- The category filter literally reads **"Tags Pending"** — an unfinished placeholder shipped to production.
- Clicking "Add" **immediately overwrites the live editor** with no confirmation, no toast, no "added to Library" feedback, and **no undo**. Instead you get a NowPlaying warning toast covering two preset cards.
- Modals stack: opening Library over Explore leaves both up (`91-CAM866-library.png`).

**Library** is a right-side drawer: rows with drag-to-reorder, favourite star, "…" menu (Rename / Duplicate / Favorite / Export / Delete), and ▶ Apply. Header has Explore / New / Import / Close.
- Thumbnails are ~34px and mostly read **"No Img"** — you cannot tell your own presets apart, while Explore shows gorgeous live previews of *other people's*. Backwards.
- After adding one Explore preset I had **two rows both named "Default"** (system default + auto-created), which is ambiguous.
- Footer reads **"Total Preset: 3"** — grammatically wrong and gives no sense of the 20-preset ceiling.
- The drawer overlays and clips the editor panel it sits next to.
- A stray "More" tooltip pill renders on top of the row while its own menu is open.

**Export** is a clean name-then-download modal. But the file is **9.75 MB of JSON for one preset**: media inlined as base64 (a 5 MB GIF → 6.7 MB) plus a **3 MB base64 PNG preview**. Self-contained is right; a 10 MB JSON is not. Schema is versioned (`schemaVersion: 3`) with real migrations in the source — good engineering underneath.

**Limits**: adding elements stops dead at 40. The Add button just greys out — **no message, no "40/40", no warning as you approach**. Same for the 20-preset cap.

## 7. Onboarding, changelog, i18n, companion

- **Getting Started** (`73-how-to-install.png`) is genuinely excellent: "You're currently running it in your browser (preview mode)", an Automatic path with an `Open in NZXT CAM` deeplink, and a Manual path with 5 numbered steps, the URL in a code box, and a screenshot of CAM. The problem is it is **not shown on first run** — a first-time browser visitor sees an "API unavailable" error instead. (No Copy button on the URL either.)
- **Announcements** (`72-announcements.png`) is a well-written changelog modal with its own language selector and an inline screenshot — but the content is **cut off behind the Continue bar** with no scroll affordance.
- **i18n: 25 languages**, complete and high quality from what I could read. But **Arabic is not RTL**: `document.dir` is empty and computed direction is `ltr`, so labels land wrong (`X إزاحة` instead of `إزاحة X`), sentence-final punctuation appears at the start of lines, and the whole panel stays left-anchored (`71-arabic.png`). Translated, not localized.
- **NowPlaying companion**: the browser polls `ws://localhost:27871` **every ~2 seconds forever** (16 attempts in 30s), logging a console error each time, even with no audio elements in the preset and no companion installed. On the Kraken display view this runs 24/7. The "not detected" toast is well written (download link + restart hint + more info) but it re-renders as a floating panel over whatever modal is open.
- There is a **Supporter Access gate** in the shipped bundle. Dev flags describe it: *"Forces the Config supporter-access gate open regardless of the real usage threshold, so it can be previewed without crossing **20,000 minutes**"* and *"Forces the Kraken LCD **gif+text overlay** on, regardless of the real usage threshold. Re-checked every 60s."* So after ~333 hours of display time the free tool puts a nag overlay **on your physical Kraken screen** until you activate a supporter code. Worth knowing; it is the clearest opening for a competitor.

## 8. Display-side render (`?kraken=1`, 640×640)

`40-KRAKEN-display-640-car.png`

This is where the product delivers. The rendered face is **excellent**: crisp NZXT display typography, correct circular mask, GIF background playing, leader-line callouts to CPU/GPU/Power values. No jank; the RAF loop ran clean. `body.kraken-mode` is a separate lightweight root, and there is a "Take Screenshot" button in the editor that downloads a PNG of the face (`nzxt-esc-preset-screenshot-….png`) — a smart sharing affordance.

The gap is **editor-to-output fidelity**: you design this 640px face inside a 250px preview, so a 24px text element appears ~9px while editing. Everything is a guess until you look at the real screen.

## 9. Responsive behaviour

- **866×537 (CAM window)** — this is the design target and it's the best-fitting size (`50-CAM866x537-background-tab.png`). But: the header eats 150px of 537 (28%) with branding/byline/5 social icons/version; the add-element dropdown is clipped to 5 of 17 items; the element list shows ~1⅓ cards; two warning badges stack against the preview; the chat bubble sits over the canvas.
- **390px** — completely broken. Header clips horizontally, and the entire settings panel is **off-screen with no scroll** (`60-phone390-background.png`). You literally cannot edit.
- **Real phone** — a hard-coded `<meta name="viewport" content="width=1280">` is injected in config mode, so an iPhone 13 renders the desktop layout at **0.30× zoom** (`62-real-mobile-iphone13.png`). Nothing is broken; nothing is legible either. Mobile is simply not a target.

## 10. Task-speed test — video/animated background + CPU-temp overlay

Fastest path, cold browser, empty state:

| # | Click |
|---|---|
| 1 | Reject All (cookie consent) |
| 2 | **Add** (Background → Media) |
| 3 | **GIF & Clips** tab |
| 4 | a trending clip tile *(applies + closes modal instantly)* |
| 5 | **Next Step: Add/Edit Overlay Element(s)** |
| 6 | **Add your first element** |
| 7 | **Sensor** *(defaults to CPU Temp)* |

**7 clicks (6 excluding consent), no typing.** That is genuinely fast — CPU Temp being the default sensor is a smart choice.

Via a direct MP4/YouTube URL instead: **8 clicks + a paste** (Add → URL → focus field → paste → Apply → Next Step → Add first element → Sensor).

The caveat: at click 7 you have a *technically correct but ugly* result — the clip is letterboxed inside a black donut, and the temperature sits at dead centre at default size. Getting to *good* costs an unbounded number of extra interactions: a drag to reposition, a drag or stepper-mashing to resize, and manual `Resize` guessing on the background, with **no undo** if you overshoot.

---

## What's great

1. **Explore.** ~121 community presets with **live-rendered circular previews**, authors, download counts, search and sort. Best-in-class and the hardest thing to copy.
2. **The rendered Kraken face.** Sharp, correct, well-typeset, animated backgrounds work, ~zero jank.
3. **KLIPY GIF/clip picker** built into the background flow — one click from trending grid to applied background.
4. **7-click zero-to-result.** Sensible defaults (CPU Temp, sane sizes) and a "Next Step" wayfinding button that actually teaches the two-tab model.
5. **Element breadth.** 17 element types incl. Radial/Linear/Vertical/Circle graphics, Sensor Chart, Analog Clock, Audio Visualizer with ~10 styles.
6. **Element header actions** — visibility/lock/rename/duplicate/z-order/collapse on every card, with the clever **Show with Music / Show without Music** visibility states.
7. **Getting Started modal** — best copy in the product, and the CAM deeplink is a great touch.
8. **Local-first + honest privacy copy** ("Your files stay private… stored only in your browser"), IndexedDB media, versioned+migrating preset schema, self-contained exports.
9. **25 languages**, complete and idiomatic.
10. **Take Screenshot** of the rendered face — one click to a shareable PNG.
11. **Instant autosave**; no save button, no lost work from navigation.

## What's weak

1. **No undo/redo anywhere.** Paired with destructive one-click "Add" from Explore and no delete confirmation on the keyboard path, this is the defining flaw.
2. **250px preview for a 640px display**, with ~1100px of screen going unused at 1512 wide. You design blind.
3. **No snapping, no alignment guides, no align/distribute, no multi-select, no marquee.** A "free-form layout editor" with none of the layout tools.
4. **7px transform handles**, one resize handle only, no shift-constrain, no rotation snap, and a drag HUD that rotates itself into illegibility.
5. **New elements always spawn at dead centre, stacked.**
6. **The add-element menu is clipped at CAM window size** — 5 of 17 types visible.
7. **Toasts render above modals and over the preview.** Two warning badges permanently squat next to the canvas.
8. **Silent media failures.** Bad video URL → black screen, no error.
9. **No fit/fill/cover for background media.** Landscape clips letterbox into a black donut by default.
10. **Style drawer is light-themed** in a dark app, with a dead "Border Color" heading and an inconsistent bare number input.
11. **Native unstyled `<select>`s** and a broken-looking Font field inside otherwise custom-styled panels.
12. **Library thumbnails are 34px "No Img" placeholders** while Explore shows live previews — your own work is the least visible.
13. **Limits are invisible until you hit them** — Add just greys out at 40 elements; "Total Preset: 3" never mentions 20.
14. **Copy defects**: "Tags Pending" filter, "Total Preset: 3", Turkish "medya.jpg" in English copy, `NZXT-ESC-DEV` in production exports, raw session UUID in the footer, duplicate "Default" presets.
15. **Arabic ships without RTL.**
16. **10 MB single-preset exports** (base64 media + a 3 MB base64 preview).
17. **WebSocket to localhost:27871 retried every 2s forever**, with console errors, regardless of whether any audio element exists.
18. **Third-party chrome on the canvas** — CookieYes sheet + persistent cookie badge + a chat widget bubble, at every breakpoint.
19. **No responsive layout below ~800px**; hard-coded `viewport width=1280` makes real phones a 0.3× zoom.
20. **Supporter gate that watermarks the physical Kraken display** after a usage threshold.
21. **The public repo doesn't build** and is 4 minor versions stale.

---

## Screenshot index
All under `/private/tmp/claude-501/-Users-ubberkid/4b208bca-b1f6-45b8-a3bf-cf7fe3048061/scratchpad/shots/`

**First run / desktop**: `01-firstrun-desktop-1512`, `02-firstrun-desktop-consented`, `03-overlay-tab-empty`, `03b-after-9s-does-warning-persist`, `04-add-element-picker`, `05-sensor-added`
**Editor interaction**: `11-fresh-unselected`, `12-selected`, `12b-selected-full`, `13-dragging` (live X/Y HUD), `14-after-drag`, `16-alignment-grid-on`, `17-guides-off`, `18-rotating` (rotated HUD bug), `19-after-rotate`, `20-resizing`, `21-snap-near-center` (no snap), `88-shift-multiselect`, `89-marquee-attempt`, `89b-after-marquee`, `31-two-elements-editor` (centre-stacking), `87-element-limit` (40-element wall)
**Inspectors / style**: `80-text-inspector`, `81-text-style-panel` (light-theme drawer), `82-visibility-menu`, `83-font-picker`
**Media**: `22-media-add-modal` (toast over modal), `23-media-url-panel` ("medya"), `24-media-klipy-panel`, `25-url-filled`, `26-video-bg-applied` + `26b-video-bg-preview` (silent failure), `28-klipy-selected`, `29-gif-bg-applied`, `29b-gif-bg-preview`
**Task-speed**: `30-TASKSPEED-gif-bg-plus-cputemp`, `30b-TASKSPEED-preview`
**Presets**: `32-explore`, `33-explore-after-add`, `34-editor-with-car-preset`, `34b-car-preview`, `35-library`, `36-library-more-menu`, `37-create-preset`, `86-export-modal`
**Display face**: `40-KRAKEN-display-640-car`, `41-KRAKEN-display-640-car-t2`
**CAM window 866×537**: `50-CAM866x537-background-tab`, `51-CAM866x537-overlay-tab`, `52-CAM866x537-add-menu` (clipped), `90-CAM866-explore`, `91-CAM866-library`, `92-CAM866-media-modal`
**Small screens**: `60-phone390-background`, `61-phone390-overlay`, `62-real-mobile-iphone13`
**i18n / info**: `70-language-menu`, `71-arabic` (LTR bug), `72-announcements`, `73-how-to-install`, `84-nowplaying-info`, `85-take-screenshot-result`

Exported preset for reference: `…/scratchpad/exports/Car.nzxt-esc-preset.json` (9.75 MB). Source tarball: `…/scratchpad/esc/nzxt-esc-main/`.

---

## The five things kraken-hub must beat

1. **Ship undo/redo + a history panel.** They have none. This alone changes how safe the editor feels.
2. **Give the canvas the screen.** A 1:1 (or larger) preview with zoom, plus snapping, smart alignment guides, multi-select, marquee, align/distribute, and 24px handles. Their editor is a positioning form, not a design tool.
3. **Design for 866×537 first and make it complete there** — no clipped menus, no toasts over modals, no stacked warning badges, a header under 80px.
4. **Match Explore, then beat it with your own Library**: live previews for *your* presets, visible quotas, non-destructive apply with a confirm + undo, and a compressed/zipped share format instead of 10 MB JSON.
5. **Never fail silently.** Validate media on paste, show fit/fill/cover with a live circular crop preview, and surface real errors — that black-screen MP4 is a support ticket they'll never see.