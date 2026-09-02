Teardown complete. Source at `/private/tmp/claude-501/-Users-ubberkid/4b208bca-b1f6-45b8-a3bf-cf7fe3048061/scratchpad/esc-src/nzxt-esc-main/`.

---

# NZXT-ESC — code-level teardown for kraken-hub

## 0. The single most important finding: the repo is not the product

`package.json` says `5.12.0-build08`, but **the published source is a gutted snapshot of roughly v2–v3 and does not compile.**

- `index.html` is no longer an app entry — the real one is commented out and replaced by a meta-refresh + `location.replace()` to `https://nzxt-esc.pages.dev/` (`index.html:1-30` is the commented original; lines 33+ are the redirect stub). `dist/` contains exactly one file: the same redirect.
- Two whole directories referenced everywhere were **deleted before publishing**: `src/hooks/` and `src/utils/`. I resolved every relative import in the tree; 47 are dangling. Missing modules include `hooks/useMonitoring`, `hooks/useLocalMedia` (the entire IndexedDB pipeline), `hooks/useConfig`, `hooks/useMediaUrl`, `hooks/useSettingsSync`, `hooks/usePreviewScaling`, `utils/media`, `utils/youtube`, `utils/positioning`, `utils/snapping`, `utils/resize`, `utils/env`, `utils/featureFlags`, `utils/overlaySettingsHelpers` (which holds `MAX_OVERLAY_ELEMENTS`), `utils/overlayMigration`, `utils/useAntiCache`.
- Consequently: **the media/IndexedDB layer, the monitoring subscription, snapping, and YouTube URL parsing are not in the public source at all.** I reconstructed their contracts from call sites.
- README advertises element types that do not exist anywhere in `src/`: Icon, Sticker, Image element, Radial/Linear/Circle Graphic, Sensor Chart, Analog Clock, Album Cover, Now Playing Text, Audio Visualizer, Explore, Supporter Access. `src/types/overlay.ts:122` is the ground truth: `"metric" | "text" | "divider" | "clock" | "date"`.

**Treat the README as a competitive-intel document about the live Cloudflare app, and `src/` as an archaeological record of how they build.** I flag which is which throughout.

---

## 1. FEATURES (line-level, from source)

### 1.1 Element types — the real data model

`src/types/overlay.ts` (393 lines) is the whole model. Paste-worthy:

```ts
export type OverlayElementType = "metric" | "text" | "divider" | "clock" | "date";

export interface OverlayElement {
  id: string;
  type: OverlayElementType;
  x: number;        // LCD coordinates, centre-origin
  y: number;
  zIndex?: number;  // default: array index
  angle?: number;   // degrees 0-360
  data: MetricElementData | TextElementData | DividerElementData | ClockElementData | DateElementData;
}

export interface Overlay { mode: "none" | "custom"; elements: OverlayElement[]; }
```

Per-type payloads (`src/types/overlay.ts:127-187`):

| Type | Fields |
|---|---|
| `metric` | `metric`, `numberColor`, `numberSize`, `textColor`, `textSize`, `showLabel?`, `outlineColor?`, `outlineThickness?` |
| `text` | `text` (≤120 chars), `textColor`, `textSize` (≥6), `outlineColor?`, `outlineThickness?` |
| `divider` | `width`, `height`, `color`, `outline*` — a **rectangle**, i.e. this is their "shape" primitive |
| `clock` | `format: "HH:mm"\|"HH:mm:ss"`, `mode: "24h"\|"12h"`, `fontSize`, `color`, `font?: "default"\|"digital"`, `outline*` |
| `date` | `format: string` (free-text token string), `fontSize`, `color`, `outline*` |

**Per-element properties are strikingly thin.** There is **no** per-element opacity, no blend mode, no scale (font size is the only scale), no per-element animation, no font family choice except the clock's one alternate, no width/height for text, no anchor/alignment. Position is `x,y` + `angle` only. `src/ui/components/ConfigPreview/ElementCards/MetricElementInspector.tsx:160-292` is the complete inspector: Sensor select · colour+outline picker · Size · Angle · X · Y. That is it.

Discrimination is done with **structural type guards, not a discriminant field** (`isMetricElementData` … `isDateElementData`, lines 316-394) — checking `'width' in data && !('metric' in data) && !('thickness' in data)`. Brittle; a genuine anti-pattern.

### 1.2 Sensor tiles — metrics, formats, units

`src/domain/metrics.ts` — one registry, 7 metrics only:

`cpuTemp` · `cpuLoad` · `cpuClock` · `liquidTemp` · `gpuTemp` · `gpuLoad` · `gpuClock`

```ts
export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  cpuTemp: { label: "CPU", unit: "°", unitType: "temp", format: v => `${Math.round(v)}` }, …
}
```

- Unit types: `"temp" | "percent" | "clock" | "none"`. Unit glyph size is derived from number size: `temp → ×0.49`, `percent → ×0.35`, else `×0.2` (`OverlayElementRenderer.tsx:38-42`).
- All values `Math.round()` — **no decimals anywhere, no user-selectable precision, no °F, no thresholds, no colour-by-value, no min/max/avg, no history/graph.**
- `MHz` is hard-coded as a literal `<div>MHz</div>` (`OverlayElementRenderer.tsx:142`) rather than coming from the definition — the registry's own `unit` field is ignored on that path.
- README's RAM / CPU power / GPU power / fan speeds / multi-GPU selection exist only in the live app.

### 1.3 Clocks & dates

- `ClockElementRenderer.tsx`: `setInterval(…, 1000)`. Computes a **fixed container width** `max(fontSize * clockLength * 0.6, fontSize * 2)` to stop width flicker as digits change — a real, nice detail (line 79), and the comment says the same formula is duplicated in `BoundingBox.ts` (duplication they acknowledge).
- `DateElementRenderer.tsx`: hand-rolled token formatter — `YYYY YY MMMM MMM MM M DD D dddd ddd dd d`, longest-token-first scan, everything else literal. Month/weekday names via `Intl.DateTimeFormat` with an app-lang→BCP47 map (8 entries). Re-renders **once at midnight** via a `setTimeout(msUntilMidnight)` then a 24 h interval — thoughtful. Bug: the `storage` listener added at line 126 is added with an inline lambda and never removed in the cleanup (line 132-135) — leaks a listener per remount.

### 1.4 Backgrounds & media pipeline

`AppSettings` (`src/constants/defaults.ts:7-49`) is the background model: `scale`, `x`, `y`, `fit: cover|contain|fill`, `align: center|top|bottom|left|right`, `loop`, `autoplay`, `mute`, `resolution`, `backgroundColor`, `sourceType: 'remote'|'local'`, `localFileName`, `localMediaId`.

- **One background per preset.** No layering of media, no per-media opacity/blend.
- `MediaRenderer.tsx` dispatches on `getMediaType(url)` → `youtube` | video | image. Video = plain `<video>` with `objectFit`/`objectPosition`/`transform: scale()`.
- **Playback watchdog** (`MediaRenderer.tsx:60-140`): listens `ended`/`pause`/`loadeddata` + `document.visibilitychange`, plus a blanket `setInterval(ensurePlaying, 2000)`. Crude but this is exactly the sleep/wake robustness story — that 2 s poll is their whole answer to CAM suspending the page.
- **YouTube** (`src/ui/components/BackgroundMedia/YouTubeRenderer.tsx`): a wrapper `<div>` sized by a hand-written cover/contain/fill solve against a hard-coded 16:9, `transform: translate(...) scale(...)`, `overflow:hidden`, `iframe` centred inside with `pointerEvents:none`. **No geometry-based quality trick** — the iframe is sized to the LCD (640-ish), which is precisely why their YouTube looks soft. No player API, no ad handling, no aspect override.
- **Pinterest** is only a *classification*, not an extractor: `deriveBackgroundSourceFromUrl` (`src/preset/utils/mediaSource.ts:45-80`) tags `pinimg.com`/`pinterest.com` URLs as `type:'pinterest'`. The default background shipped in `DEFAULT_MEDIA_URL` is a hot-linked `v1.pinimg.com` mp4. Actual pin→media resolution lives in the deleted `utils/`.
- **Local media**: `LocalMediaModal.tsx` — `MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024` (150 MB), accepts `.jpg/.jpeg/.png/.gif/.mp4` by extension *or* any `image/*`/`video/*` MIME. Stored in IndexedDB keyed by `localMediaId` (== presetId, so **one local file per preset**). Blob never exported. **No thumbnails, no library, no dedup, no GC, no quota/persist call anywhere in the tree.**
- WebM: not in the accept list, not in `getMediaType` (deleted), README says PNG/JPG/GIF/WebP/MP4.

### 1.5 Preset system

Two independent file formats — a smart split worth noting:

1. **`PresetFile`** (`src/preset/schema.ts`) — full preset: background + settings + overlay + misc. Extension `.nzxt-esc-preset`.
2. **`OverlayPresetFile`** (`src/overlayPreset/schema.ts`) — *elements only*, `format: 'overlay-preset'`, extension `.nzxt-esc-overlay-preset`. Lets you move a layout between backgrounds.

```ts
export interface PresetFile {
  schemaVersion: number; exportedAt: string; appVersion: string; presetName: string;
  background: { url: string;
    settings: Pick<AppSettings,'scale'|'x'|'y'|'fit'|'align'|'loop'|'autoplay'|'mute'|'resolution'|'backgroundColor'>;
    source?: BackgroundSource };            // {type:'remote'|'youtube'|'pinterest'|'local', url?, localFileName?}
  overlay: Overlay;
  misc?: { showGuide?: boolean; localMediaWarning?: string; language?: string; [k:string]: unknown };
}
```

- **Storage**: `localStorage['nzxtPresets']` = `StoredPreset[]` (`{id,name,preset,isDefault,isFavorite?,createdAt,updatedAt}`), active id in `localStorage['nzxtActivePresetId']` (`src/preset/storage.ts:25-26`). Everything JSON in one key — no per-preset key, so the whole array is rewritten on every save.
- **Limits found in code**: `FAVORITE_LIMIT = 10` (storage.ts:393). `MAX_OVERLAY_ELEMENTS` lives in the deleted helper; comments at `OverlaySettings.tsx:490` say `<= 20` at this snapshot, README claims 40 now and 20 presets. **No preset-count cap exists in the published code.**
- **Migrations**: `CURRENT_SCHEMA_VERSION = 2`, `NEXT_SCHEMA_VERSION = 3`, `MIN_SUPPORTED_VERSION = 0`, with a documented `SCHEMA_VERSION_HISTORY` map (`src/preset/constants.ts`) and per-hop migrators `vNext/migration_v0_to_v3.ts`, `v1_to_v3`, `v2_to_v3`, chained by `migrationIndex.ts`. v3's only addition is `overlay.zOrder?: string[]` as the canonical layer stack, with a validator that rejects duplicates, orphans and missing ids (`vNext/schema_v3.ts:65-100`). **Migration on read is lazy and gated behind a feature flag** (`shouldUseFaz3BRuntime()`), and re-saves the whole array if any preset changed (`storage.ts:111-139`).
- **Import** is a pipeline (`src/preset/importPipeline.ts` → `validation.ts` → `normalization.ts` → `migration.ts`) with typed errors (`src/preset/errors.ts`), conflict resolution UI (`PresetManager/ImportConflictModal.tsx`), name deduping (`generateUniquePresetName` → `"Name (2)"`), and element-id conflict resolution on overlay import (`resolveElementIdConflict`).
- **Never rejects on a bad `background.source`** — sanitises and drops it instead (`schema.ts:94-106`). Good forgiving-parser instinct.
- **Built-in templates**: 4 layouts in `src/overlayPreset/templates.ts` — `single-`, `dual-`, `triple-`, `quadruple-infographic`, expressed as `Omit<OverlayElement,'id'>[]` with ids assigned at apply time. Truncated to the element cap on apply.
- Per-preset sensors: no such concept. Sensors are per-element; the preset just carries the elements.

### 1.6 Display-side rendering (`?kraken=1`)

`src/main.tsx` — one entry, branch on environment:

```ts
const isKraken = isNZXTCAM();   // = new URLSearchParams(location.search).get('kraken') === '1'
ReactDOM.createRoot(root).render(<I18nProvider>{isKraken ? <KrakenOverlay/> : <Config/>}</I18nProvider>)
```

Note `<React.StrictMode>` is left on **in production** — double-invoked effects on the LCD.

- **It is plain React DOM. No canvas, no WebGL, no offscreen anything.** `UnifiedOverlayRenderer.tsx` maps elements to absolutely-positioned `<div>`s at `left:50%; top:50%` with `transform: translate(calc(-50% + Xpx), calc(-50% + Ypx)) rotate(Ndeg)` and `zIndex`.
- **There is no frame loop.** `src/overlay/helpers/renderLoop.ts` implements a 60 Hz accumulator `startRenderLoop()` — and I verified **it is imported nowhere**. Dead code. Likewise `targetFps` appears once, in the type declaration at `src/nzxt/safeNZXT.ts:37`, and is **never read**. ESC does not know what frame rate CAM is asking for and does not govern anything.
- **1 Hz feed → tweening**: `src/ui/components/AnimateNumber.tsx` wraps every metric value in a framer-motion `useSpring({stiffness:300, damping:30, mass:0.5})` and re-`setState`s the rounded display string on every spring tick. So a 1 Hz integer feed becomes a ~60 Hz React state storm per metric element. On a 1 FPS panel this is pure waste; on a 40 FPS Elite it is the dominant cost. **This is their headline visual polish and their worst performance decision, in the same 78-line file.**
- Memoisation is confused: `UnifiedOverlayRenderer`'s custom `memo` comparator builds a JSON cache key of every element, sorts it, compares it — and then **`return false` unconditionally at line 196**, so the whole comparator is wasted work on every render.
- **Safe area / circle**: one CSS rule. `src/ui/styles/KrakenOverlay.module.css` = `position:relative; overflow:hidden; border-radius:50%`. There is **no safe-area inset, no inscribed-square calculation, no shape branch** — `NZXT_DEFAULTS.LCD_SHAPE` is `'circle'` and `shape` is read in `safeNZXT.getLCDDimensions()` but the value never changes any layout. Square 240 px Kraken 2023 panels get a circular mask.
- **Geometry**: `getLCDDimensions()` reads `window.nzxt.v1.width/height` with a `640` fallback, but `KrakenOverlay` uses `width` for **both** dimensions (`lcdSize = lcdResolution`, lines 241-260) — non-square panels are broken.
- **Sleep/wake**: nothing beyond the video `visibilitychange` handler and the 2 s play poll. No watchdog, no reload, no heartbeat, no reconnect.

### 1.7 Monitoring subscription

`src/nzxt/safeNZXT.ts` is the one genuinely well-built platform file:

- `subscribeMonitoring(cb)` assigns `window.nzxt.v1.onMonitoringDataUpdate = cb` with **retry for late API injection: 10 attempts × 200 ms = 2 s cap**, returns a cleanup that nulls the property only if it is still ours (identity check, line 162). Idempotent `init()`. Never assigns `window.nzxt` wholesale.
- Weakness: it is a **module-level singleton with one handler slot** (`currentMonitoringCleanup`), so a second subscriber silently evicts the first. No fan-out, no normalisation, no staleness detection.

### 1.8 Companion (NowPlaying.WebSocket)

**Zero companion code in this repo** — it is a separate closed-source repo shipping a compiled `.exe` only ("This repository contains compiled application only. Source code is not included"). Protocol from its README:

- Endpoint `ws://localhost:27871`, plain JSON, push-only, no auth, no handshake, no versioning.
- `{"Type":"audioVisualizer","Volume":35,"Bass":59,"Mid":43,"Treble":40,"Spectrum":[…10 ints…],"UpdatedAt":"21:18:20"}` — 10-band spectrum, configurable interval.
- `{"Type":"nowPlaying","Title","Artist","Album","Playback","IsPlaying","PositionSec","DurationSec","PositionText","DurationText","AlbumArtUrl":"http://localhost:27871/album-art"}` — Windows SMTC sessions (any app, not Spotify-specific), plus a **local HTTP endpoint serving album art** so `<img src>` just works.
- Install: manual download of `NowPlaying.WebSocket_v6.4.30.0.exe` from a GitHub release URL. No installer protocol, no version negotiation, no auto-update handshake with the web app. It is also a full tray app (media controls, volume, loopback/WASAPI device picker, always-on-top, run-at-startup) — the media-controller product came first, the LCD integration second.

### 1.9 i18n

- **8 runtime locales**: `en tr de es fr it pt jp` (`src/i18n/index.ts:22`, `I18nProvider.tsx:12-21`). The "25 languages" badge counts **25 translated README files in `docs/README.*.md`**, not UI locales. Live app may now have more; this source does not.
- Implementation: all 8 JSON dictionaries **statically imported and bundled eagerly** into both entries, `t(key) => dict[key] ?? key` (no interpolation — callers do `.replace('{max}', …)` by hand), key stored at `localStorage['nzxtLang']`, cross-tab via `storage` event + same-tab via a custom `languagechange` event. 266 keys in `en.json`. The supported-lang array is **duplicated four times** inside `I18nProvider.tsx` alone.
- `src/config.tsx` (the `config.html` entry) renders `<Config/>` **without** `<I18nProvider>` — the context-based `useI18n` has no provider on that entry.

### 1.10 Install flow

No code. README uses `https://cam-redirect.nzxt.com/action/load-web-integration?url=…` (NZXT's own HTTPS redirector that hands off to the `nzxt-cam://` handler) plus manual "paste this URL into Custom Web Integration" instructions.

### 1.11 Hidden / flagged features

- `src/debug/devToggle.ts` — a `DevModeStore` singleton with hotkey toggle, **hard no-op in production** (`if (!IS_DEV) return`). Nothing user-facing is gated behind it.
- `window.__NZXT_ESC_DEBUG_RUNTIME === true` unlocks verbose preset-storage logging (`storage.ts:165`).
- `src/state/overlay/devtools.ts` (286 lines) — a redux-devtools-style action inspector.
- **`src/fingerprint/**` — a complete xxhash64 + deterministic stable-stringify element hasher, header says `STATUS: PARKED — NOT ACTIVE … NOT imported or used anywhere`.** I confirmed: zero importers. Two feature flags in the same state: `SNAPSHOT_V2_SHADOW_ENABLED = false` (`useOverlayStateManager.ts:206`), `shouldUseFaz3BRuntime()` gating v3 migration.
- Nothing in the source implements "Supporter Access", usage-time counting, or Explore — all live-app-only.

---

## 2. ARCHITECTURE

**Stack.** React 18.3 + Vite 5 + TypeScript 5.6, `framer-motion`, `react-colorful`, `react-tooltip`, `lucide-react` (in *dev*Dependencies but imported by shipped components — a packaging bug). No state library, no router, no test runner, no linter, no formatter. Terser with `drop_console: true`. `base: '/nzxt-esc/'` (GitHub Pages path baked in; the app actually ships on Cloudflare Pages at `/`). Two entries: `index.html` → `src/main.tsx` (branching), `config.html` → `src/config.tsx`. ~30.8 k LOC across 130 files.

**State management** — hand-rolled, three layers:

1. `StateManager` class (`src/state/overlay/stateManager.ts`) — `getState/subscribe/replaceState/dispatch`, one instance **per preset id**, cached in a module map that is deliberately never cleaned up ("keeps state across unmounts").
2. `OverlayRuntimeState` (`src/state/overlay/types.ts`):
```ts
export interface OverlayRuntimeState {
  elements: ElementStore;          // Map<string, OverlayElement>
  selection: SelectionState;       // { selectedIds: Set<string>, … }
  zOrder: ZOrder;                  // string[]
  history: HistoryState;           // { past: Action[], present, future, maxHistorySize:50 }
  transactions: TransactionState;  // { active, batch, startState }  ← rollback
  meta: StateMetadata;             // { version, createdAt, updatedAt, presetId }
}
```
   Action-based (`actions.ts`, 1348 lines), undo/redo capped at 50, batch transactions with full-state rollback. Genuinely well-shaped — and note runtime-only fields (selection, history, transactions) are documented as **never** serialised.
3. React binding via `useSyncExternalStore` (`useOverlayStateManager.ts:366`).

**Config ↔ display communication.** Two BroadcastChannels plus localStorage, and they do not agree with each other:

| Channel | File | Payload |
|---|---|---|
| `nzxtesc_overlay_runtime` | `src/state/runtimeBroadcast.ts:38` | `{type:'runtime_update', presetId, elements[], timestamp}` |
| `nzxtesc_overlay_runtime_vnext` | `src/state/overlay/useOverlayStateManager.ts:61` | versioned `SyncMessage` |
| `localStorage` `nzxtPresets` / `nzxtActivePresetId` | `src/preset/storage.ts` | full preset array; **manually re-dispatches a synthetic `StorageEvent` plus a custom `activePresetIdChanged` event** because same-tab writes don't fire `storage` |

The vNext protocol (`src/state/overlay/sync.ts`, 568 lines, headed **"FROZEN ZONE — DO NOT MODIFY LOGIC"**):
- `SYNC_MESSAGE_VERSION = 1`; types `state-update | state-sync-request | state-sync-response`; every message carries `{version, type, timestamp, tabId}`.
- Anti-echo by `tabId` compare + an `isBroadcastingRef` guard released on a **50 ms `setTimeout`** — a race, not a lock.
- **Full-state broadcast on every change.** No diffs, no throttle, no coalescing. `createStateUpdateMessage` runs `sanitizeRuntimeState` *and then a second `structuredClone(message)` purely as a validity assertion* on every send (lines 137-160).
- Merge policy differs by role, deliberately: **the Kraken tab always accepts remote as canonical** (`useOverlayStateManager.ts:710-728`, "no merge heuristics"); the editor runs `mergeStates` with a deep `areStatesDifferent` walk that JSON-stringifies every element's `data`.
- LCD boot: `KrakenOverlay` hydrates once per preset from localStorage via `importPresetToRuntimeState`, but **only if `elements.size === 0`**, with a three-tier fallback chain (runtime → `settings.overlay.elements` → empty Map) reconstructed inline at `KrakenOverlay.tsx:197-227`.

**Coordinate system / z-order / transform.** `src/transform/` is the best-engineered subsystem: `TransformMatrix` (2×3 affine), `CoordinateSystem` (LCD↔preview↔screen↔element-local, `offsetScale = previewSize / lcdResolution`, also "FROZEN ZONE"), `BoundingBox`, `HandlePositioning`, an `operationDetectorV2`, Move/Resize/Rotate operation classes, and a Command-pattern history (`MoveCommand`/`ResizeCommand`/`RotateCommand`) that is **parallel to and duplicative of** the action-based history in `state/overlay/history.ts`. Two undo stacks in one app.

Z-order: `zOrder: string[]` is canonical (front = last), `zIndex` on the element is a compatibility mirror, and both are used — `getElementsInZOrder(elements, zOrder)` in `KrakenOverlay`, but `UnifiedOverlayRenderer` re-sorts by `zIndex` again and also emits `zIndex` as CSS. Three sources of truth for one ordering.

**Code-quality signals.**
- **Tests: effectively zero.** 4 files under `src/preset/__tests__/` exporting `export async function testRoundTrip()` etc. — no `describe`, no `it`, **no test runner in `package.json`**, no CI running them. They are documentation.
- **CI: one workflow, `cleanup.yml`, whose only job is to delete all workflow runs.** No build, lint, typecheck or test on push.
- `tsc --noEmit` is in `build`, but the tree cannot typecheck (47 unresolvable imports). `any` used liberally in the NZXT surface and type guards.
- Comment archaeology is extreme: `FAZ-3C`, `FAZ-4-4H`, `FAZ-4-4M`, `FAZ-4-POST-FIX-Z-ORDER`, `FAZ-6 / Task 2E`, `ARCHITECT MODE`, `FROZEN ZONE`, `HOTFIX` — a phase-numbered, AI-assisted refactor log left in the shipping source. Two files carry "behavior-locked, do not modify" banners, which is an admission that the team cannot safely change its own sync and coordinate code.
- Inline styles everywhere in the editor (`OverlaySettings.tsx` is 1604 lines of JSX with style objects); `alert()` used for user-facing limit errors (`OverlaySettings.tsx:789`).
- **Licence is inconsistent three ways**: `package.json` `"license": "Personal-Use-Only"`, README "Personal Use License", and `LICENSE` is verbatim **CC BY-NC 4.0**. CC-BY-NC is not an OSI licence and forbids commercial use; either way **we must not copy code from this repo**. Ideas and protocols only.

---

## 3. FEATURE MATRIX — ESC vs kraken-hub

Read against `docs/design/design-architecture.md`, `docs/modules.md`, `docs/providers.md`, `docs/remote-control.md`, `src/modules/*`, `src/sync/*`, `src/platform/*`.

### 3.1 Where ESC is ahead (gaps for us) — graded by user value

| Feature | ESC (how) | kraken-hub | Value |
|---|---|---|---|
| **Free-form overlay canvas** — drag/rotate/resize arbitrary elements on the panel | `OverlayElement[]` + `src/transform/**` engine + `OverlayPreview` with handles, snapping guides, multi-select group bbox | **Missing.** We have modules (video/image/clock/stats), each owning the whole panel. No compositor, no element model, no per-element placement. | **CRITICAL** — this is the entire reason people choose ESC. It is the one structural gap. |
| **Compositing / layering** — sensors *over* a video background | `MediaRenderer` (bg) + `UnifiedOverlayRenderer` (fg) in one stage, `zIndex` per element | **Missing.** `ModuleHost` mounts exactly one renderer. | **CRITICAL** — "video wallpaper + my CPU temp" is the single most-requested combination and we cannot express it. |
| **Text / shape / date primitives** | `text`, `divider` (rect), `date` element types | **Missing** (clock module only, no free text, no shapes, no date). | HIGH |
| **On-panel clock as an element** | `clock` element, digital font option | **Partial** — clock exists but as a whole-panel module. | MED |
| **Now Playing + audio visualiser** | Companion `ws://localhost:27871`, SMTC metadata + 10-band spectrum + `/album-art` HTTP | **Missing.** Our companion is a yt-dlp *resolver* only (`companion/resolver`, `docs/resolver-protocol.md`). | HIGH — different companion, same install friction already paid. |
| **Preset library with import/export files** | `.nzxt-esc-preset` / `.nzxt-esc-overlay-preset`, versioned + migrated + conflict-resolved, favourites | **Partial** — we have a media library + `src/lib/libraryPacket.ts` + `src/transfer/*`, and `state/migrations.ts`, but no user-facing "save/share my whole look as a file". | HIGH — shareability is how ESC grows; a preset file is a social object. |
| **Starter templates** | 4 infographic layouts, one tap | **Missing** — no first-run layout gallery. | MED — cheap to add, big on first-run. |
| **Number tweening** | framer-motion spring per metric | **Missing by design** (I4 forbids per-frame React). | LOW-MED — we should get the *look* without their mechanism. |
| **Text outline/stroke** | `WebkitTextStroke` + `paintOrder:'stroke fill'` on every text-ish element | **Missing** — matters for legibility over video. | MED |
| **25 translated READMEs** | `docs/README.*.md` | Missing (English only). | LOW-MED for discovery/SEO. |

### 3.2 Where kraken-hub is ahead (their gaps)

| Feature | kraken-hub (how) | ESC | Their gap |
|---|---|---|---|
| **Encrypted phone remote** | Room codes (Crockford base32), HKDF + AES-GCM sealed envelopes, SHA-256 topic id, MQTT/ntfy/localStorage transports with failover — `src/sync/{crypto,roomCode,envelope,SyncService}.ts`, `docs/remote-control.md` | **Nothing.** Same-origin BroadcastChannel only. | Enormous. Their config *is* the CAM window; ours is a phone in your hand. |
| **Download-first + resolver companion** | `companion/resolver` (yt-dlp), `docs/resolver-protocol.md`, re-download at `maxHeight`, clip kept in library | Hot-links a Pinterest CDN mp4 as its factory default and embeds YouTube live | We play the actual file; they stream someone else's. |
| **YouTube geometry engine** | 1920×1920 iframe → centre-crop, chrome removed, ~1080p elicited; `src/modules/video/youtube/`, `docs/providers.md` | 640-sized iframe, 16:9 letterbox solve, chrome visible in `contain`, ~360p | Direct, demonstrable quality win over their marquee feature. |
| **Real quality control** | Per-provider: HLS `currentLevel`, DASH representation pin, Twitch `setQuality`, resolver re-ask; enumerated ladders, never guessed | None — no concept of quality anywhere | Large. |
| **Provider breadth** | local / direct file / HLS / DASH / Reddit / YouTube / Twitch / Vimeo / Streamable, each an adapter with a capability row | image · gif · mp4 · YouTube iframe · Pinterest-tagged URL | Large. |
| **Unified media library** | `src/platform/mediaStore.ts` + `idb.ts` + thumbnails (`modules/image/thumbnail.ts`) + `blobUrls` refcount + `persist.ts` quota | One IDB blob per preset, no thumbs, no GC, no quota handling, 150 MB cap | Large. |
| **Frame governor & FPS honesty** | Single `FrameClock` gated to `geometry.targetFps` (default **1**), `needsFrameLoop`, low-entropy guidance, `LowFpsBanner` | No frame loop at all; `targetFps` never read; framer-motion springs 60 Hz on a 1 FPS panel | Large — and invisible to them, which is worse. |
| **Real geometry** | `src/platform/geometry.ts` — 4 panels, `shape`, `safeInsetPx`, `inscribedSquarePx`, `radiusPx`, `src/render/safeArea.ts`; I3 forbids literal `640` | `border-radius:50%`, `lcdSize = width` for both axes, shape ignored | Square/320 panels are broken for them. |
| **Hardware diagnostics** | `src/diag/{collect,probes,report,wire}.ts` + `#/about`, `docs/hardware-checklist.md`, `docs/troubleshooting.md` | `console.log` behind a global | Large. |
| **Watchdog / sleep-wake** | `src/platform/watchdog.ts`, `pagehide` teardown (H23), watchdog-gated `location.reload()` | 2-second `setInterval` calling `video.play()` | Large. |
| **Tests & CI** | **111 test files** (vitest unit + jsdom + Playwright e2e + live suites), `npm run check` = typecheck+lint+invariants+format+test+build+size, budgets.json enforcement, ESLint import zones | 0 executable tests, 1 workflow that deletes CI history | Enormous. |
| **Bundle discipline** | 90 kB gzip display critical path, display/config code-split at `main.tsx`, ESLint `no-restricted-paths` + bundle-graph walk | Both entries eagerly pull framer-motion, react-tooltip, react-colorful and all 8 locale JSONs | Large. |
| **Licence** | MIT | CC BY-NC 4.0 / "Personal Use" / contradictory | We are forkable; they are not. |
| **Honesty as a design rule** | `panelClaims.ts`, `vocabulary.ts` + a test that fails on an un-vocabularised claim, indeterminate `Meter`, "without evidence the app does less" | README ships a feature list the shipped source cannot back | Cultural, and it is our differentiator. |

---

## 4. IDEAS WORTH STEALING (with source paths)

1. **The element model itself — `OverlayElement[]` + `zOrder: string[]`.**
   `src/types/overlay.ts:196-213`, `src/preset/vNext/schema_v3.ts:33-50`.
   The right shape: flat array, id-keyed, one canonical order array, per-type `data` payload. Beat it by (a) using a real discriminated union (`type` narrowing `data`) instead of their structural `'width' in data` guards, and (b) **making an element a module instance** — i.e. our `KrakenModule` becomes placeable, so "video as the background layer, stats as three elements on top" falls out of the architecture we already have rather than being a second architecture.

2. **Two file formats: whole-preset and layout-only.**
   `src/preset/schema.ts` vs `src/overlayPreset/schema.ts` (`format: 'overlay-preset'` discriminator).
   Separating "my look" from "my media" is why their presets are shareable at all — a layout file has no 150 MB blob in it and no dead CDN link. We should ship a `.krakenhub-look` (layout + module configs, media by `SourceRef`) distinct from a library packet.

3. **Versioned schema with a published history map + per-hop migrators.**
   `src/preset/constants.ts:34-39` (`SCHEMA_VERSION_HISTORY: Record<number,string>`), `src/preset/vNext/migration_v{0,1,2}_to_v3.ts`, `migrationIndex.ts`.
   We have `state/migrations.ts`; steal the *documented history map* — a one-line human description per version, in code, next to the migrator. Costs nothing, pays every time someone imports an old file.

4. **Never reject an import over an optional field.**
   `src/preset/schema.ts:94-106` — an invalid `background.source` is sanitised, dropped, warned about; the preset still loads. Pair with their typed import errors (`src/preset/errors.ts`) and warning list returned alongside the result (`importPresetToRuntimeState` returns `{state, warnings[]}`).

5. **`safeNZXT.subscribeMonitoring` retry-for-late-injection.**
   `src/nzxt/safeNZXT.ts:134-197` — 10 × 200 ms retry because CAM injects `window.nzxt` *after* page load, and a cleanup that only nulls the handler if it is still identity-equal to ours. Check `src/platform/nzxt.ts` and `monitoring.ts` handle the late-injection window; if we only probe once at boot we have a real bug on slow CAM starts.

6. **Fixed-width text containers for ticking values.**
   `ClockElementRenderer.tsx:67-79` — `max(fontSize * chars * 0.6, fontSize * 2)`. Digit-width jitter on a 640 px panel is genuinely ugly and this is the cheap fix. Applies to our stats module too (`src/modules/stats/layout.ts`).

7. **`WebkitTextStroke` + `paintOrder: 'stroke fill'`.**
   `OverlayElementRenderer.tsx:63-67` and every text path. One property pair, and text becomes legible over arbitrary video. We have no equivalent and we are the app whose whole point is video behind things.

8. **Role-asymmetric sync merge.**
   `useOverlayStateManager.ts:710-728` — "Kraken view always accepts remote as canonical, no merge heuristics." A display is a *view*, never a writer; only the editor merges. Our `SyncService` should state this as an invariant, not derive it per call site.

9. **Structural-clone pre-flight on the wire.**
   `sync.ts:137-160` — `structuredClone(message)` before `postMessage`, with the offending object logged. Ours are JSON-sealed so it is moot for MQTT, but the *pattern* — assert your payload is transferable at the boundary and name the offender — belongs in `src/sync/envelope.ts` as a DEV-only guard.

10. **Deterministic element fingerprint for change detection.**
    `src/fingerprint/computeFingerprintV2.ts` + `xxhash64.ts` — stable-stringify with sorted keys, stable sort by `(zIndex, id)`, hash. They *parked* it and kept JSON.stringify-diffing every element on every message. Do the opposite: hash once, compare 16 chars, skip the deep walk. Relevant to our `src/lib/diff.ts` and any future element list.

11. **The starter-template gallery.**
    `src/overlayPreset/templates.ts` — templates as `Omit<Element,'id'>[]` literals with ids assigned at apply time, truncated to the cap. Four presets, one modal, and a new user has something good on screen in one tap. We have nothing equivalent for first run.

12. **Companion protocol shape (from NowPlaying.WebSocket).**
    Push-only JSON over a fixed localhost port, a `Type` discriminator, **and a sibling HTTP endpoint for binary** (`/album-art`) so the browser gets an `<img src>` instead of a base64 blob over the socket. If we ever add now-playing, that split is right — and note we could consume *their* companion as-is, since the protocol is public and unauthenticated.

### Anti-patterns to avoid (all observed here)

- **Springs on a 1 Hz feed.** `AnimateNumber.tsx` — 60 Hz React `setState` per metric to smooth an integer that changes once a second, on a panel whose factory default is **1 FPS**. Our I4 already forbids this; this repo is the exhibit.
- **A memo comparator that always returns `false`.** `UnifiedOverlayRenderer.tsx:170-197` — builds and sorts a JSON key of every element, then unconditionally re-renders. Pure cost.
- **Three sources of truth for z-order** (`zOrder[]`, `element.zIndex`, array index) and **two undo stacks** (`state/overlay/history.ts` actions vs `transform/history/commands/*` commands).
- **"FROZEN ZONE — DO NOT MODIFY LOGIC" banners** (`sync.ts:9`, `CoordinateSystem.ts:9`). Code you are afraid to change is code without tests. The banner is the symptom; the missing test runner is the disease.
- **Phase-number archaeology in shipping comments** (`FAZ-4-4M`, `ARCHITECT MODE`, `HOTFIX`). Commit messages, not source.
- **Shipping `<React.StrictMode>` to the LCD** (`main.tsx:33`) — double-mounted effects, double-subscribed channels, on the constrained surface.
- **Publishing a repo that does not build** — deleted `hooks/` and `utils/`, a redirect stub for `index.html`, a README describing a superset product. Whatever the intent, the effect is that "open source" is a badge rather than a property. Our `docs/BEFORE-PUBLISHING.md` and `npm run check` exist to make sure that never describes us.
- **Licence drift across three files.** Ours is MIT in `LICENSE` and `package.json`; keep it that way and keep `npm run licenses` honest.
- **Hot-linking a third-party CDN as the factory default** (`DEFAULT_MEDIA_URL` = a `v1.pinimg.com` mp4). Every install leeches someone else's bandwidth and breaks when it 404s.
- **`alert()` for domain errors** (`OverlaySettings.tsx:789`).
- **Eagerly bundling all locales and framer-motion into the display entry** — no display/config split at all, against a panel that should paint black in milliseconds.

---

### One strategic read

ESC wins on **expressiveness** (a canvas of placeable elements) and loses on **everything underneath** (no frame governor, no geometry, no tests, no quality, no remote, no library hygiene, a 360p YouTube). kraken-hub is the inverse. The gap that actually matters is #1/#2 in §3.1: **we cannot put a sensor on top of a video.** If our module system grows a compositor — modules as placeable layers rather than exclusive owners of the panel — we take their headline feature onto a foundation they cannot match, and every other row in §3.2 becomes a reason to switch.