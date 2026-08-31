# kraken-hub — Video Engine Design (flagship module)

**Scope:** provider adapters, YouTube geometry engine, A-B loop, render controls, local-file pipeline, resolver interface, validation/error UX, FPS reality. Everything below is self-contained and implementation-ready for executor subagents.

**Repo root assumed:** `/Users/ubberkid/kraken-hub/`

---

## 0. Module file layout (exact)

```
src/modules/video/
  index.ts                     # module registration + public config type
  VideoModule.tsx              # display-side React root (kraken=1)
  VideoConfigPanel.tsx         # config-side React (CAM Configuration Browser)
  types.ts                     # VideoModuleConfig, LoopConfig, RenderConfig, SourceRect
  routing/
    patterns.ts                # URL_ROUTES table (regex -> ProviderId + extractor)
    detect.ts                  # detect(url) -> ProviderMatch  (pure, unit-testable)
    validate.ts                # validateUrl(url) -> ValidationResult (errors/warnings)
    sniff.ts                   # range-probe + magic-byte sniff (best effort, CORS-tolerant)
  adapters/
    VideoAdapter.ts            # the interface + AdapterEvent union + base class
    registry.ts                # ProviderId -> lazy factory (dynamic import)
    HtmlVideoAdapterBase.ts    # shared <video> plumbing (used by 4 adapters)
    youtubeEmbed.adapter.ts
    localFile.adapter.ts
    directFile.adapter.ts
    hls.adapter.ts
    dash.adapter.ts
    twitch.adapter.ts
    vimeo.adapter.ts
    streamable.adapter.ts
    resolver.adapter.ts
  youtube/
    geometry.ts                # ALL the crop math (pure functions, unit-tested)
    ytApiLoader.ts             # single-flight loader for https://www.youtube.com/iframe_api
    maskController.ts          # overlay state machine
    qualityWatch.ts            # onPlaybackQualityChange + loaded-fraction ladder
  loop/
    LoopEngine.ts              # abstract; validation + crossing prediction
    HtmlVideoLoop.ts
    PolledLoop.ts              # youtube / twitch / vimeo
    crossfade.ts               # optional dual-<video> crossfade
  render/
    RenderController.ts        # SourceRect + RenderConfig -> CSS transform string
    fit.ts                     # cover/contain/contain-circle/fill math (pure)
    safeArea.ts                # circular inset helpers (shared with other modules)
  local/
    clipStore.ts               # IndexedDB: clips + clipBlobs + quota + persist()
    blobUrlRegistry.ts         # refcounted createObjectURL/revokeObjectURL
    ingest.ts                  # file -> metadata + thumbnail + validation
  resolver/
    resolverClient.ts          # /health, /resolve, /job polling, timeouts, caching
    resolverTypes.ts           # FROZEN wire contract (v1)
  telemetry/
    videoTelemetry.ts          # ring buffer -> localStorage + sync `tele` channel
  ui/
    ErrorCard.tsx              # on-LCD non-interactive error surface
    FpsAdvisory.tsx            # targetFps<=5 nag -> badge
    Spinner.tsx
docs/
  video-engine.md
  youtube-geometry.md
  resolver-protocol.md
  local-clips.md
  fps-and-compression.md
  why-not-stream-extraction.md
```

---

## 1. Provider adapter interface

### 1.1 Core types (`src/modules/video/adapters/VideoAdapter.ts`)

```ts
export type ProviderId =
  | 'youtube-embed' | 'local-file' | 'direct-file'
  | 'hls' | 'dash' | 'twitch' | 'vimeo' | 'streamable' | 'resolver';

export interface ProviderCapabilities {
  /** backward seek inside the buffered range without a visible spinner/flash */
  canSeekSilently: boolean;
  canSetQuality: boolean;
  canReadQuality: boolean;
  /** provider paints UI over the media; must be hidden GEOMETRICALLY, not by CSS */
  hasOwnChrome: boolean;
  needsMuteForAutoplay: boolean;
  /** true pause with no visual side effect (YouTube = false: pause overlay) */
  canTruePause: boolean;
  canSetRate: boolean;
  canSeek: boolean;
  reportsDuration: boolean;
  /** pixels live in our DOM (transformable, screenshot-able) vs a cross-origin iframe */
  pixelSource: 'video-element' | 'cross-origin-iframe';
}

/** Everything RenderController needs. Adapter chooses its own layout box. */
export interface SourceRect {
  /** adapter surface layout box, CSS px */
  surfaceW: number; surfaceH: number;
  /** chrome-free, bar-free rect inside the surface — used for fit:'cover' */
  safe:  { x: number; y: number; w: number; h: number };
  /** full media rect inside the surface (may be overlapped by chrome) — fit:'contain' */
  full:  { x: number; y: number; w: number; h: number };
  mediaAspect: number;
  /** true decoded pixels behind `full.w` — telemetry only (supersample ratio) */
  nativeW?: number; nativeH?: number;
}

export type AdapterEvent =
  | { type: 'ready'; duration: number; caps: ProviderCapabilities }
  | { type: 'playing' } | { type: 'buffering' } | { type: 'held' } | { type: 'ended' }
  | { type: 'timeupdate'; t: number }
  | { type: 'durationchange'; duration: number }
  | { type: 'sourcerect'; rect: SourceRect }
  | { type: 'quality'; height: number | null; label: string | null }
  | { type: 'error'; err: VideoError }
  | { type: 'stalled'; sinceMs: number };

export interface MountContext {
  container: HTMLElement;          // the 640x640 viewport (overflow:hidden)
  url: string;
  match: ProviderMatch;
  display: DisplayInfo;            // {width,height,shape,targetFps,dpr}
  config: VideoModuleConfig;
  signal: AbortSignal;             // teardown/abort during async mount
  emit: (e: AdapterEvent) => void;
}

export interface VideoAdapter {
  readonly id: ProviderId;
  /** initial static caps; refined after mount (e.g. isLive) */
  capabilities: ProviderCapabilities;
  mount(ctx: MountContext): Promise<void>;
  play(): Promise<void>;
  /** pause-EQUIVALENT. Semantics are per-adapter; see §3.5 */
  hold(): Promise<void>;
  isHeld(): boolean;
  seek(t: number, opts?: { precise?: boolean; loopSeek?: boolean }): Promise<void>;
  setRate(r: number): Promise<void>;
  getCurrentTime(): number;        // sync, best-known (may be interpolated)
  getDuration(): number;           // NaN when unknown
  getBufferedEnd(): number;        // seconds; 0 when unknown
  setMuted(m: boolean): void;
  setQuality?(heightHint: number): Promise<boolean>;
  getQuality?(): { height: number | null; label: string | null };
  getSurface(): HTMLElement;       // element RenderController transforms
  getSourceRect(): SourceRect;
  teardown(): Promise<void>;
}
```

**Contract rules**
- `mount()` MUST NOT touch `container.style.transform`. Adapters build their surface at *natural/oversized* layout size; `RenderController` owns all transforms. This is what makes iframe and `<video>` providers uniform.
- `teardown()` MUST be idempotent, must remove listeners, must revoke blob URLs, must `player.destroy()` / `hls.destroy()` / `dashPlayer.reset()`, and must null out `video.src` + `video.load()` before revoking.
- Every adapter emits `sourcerect` whenever natural dimensions become known (`loadedmetadata`, YT `onReady`, resolver response). `RenderController` recomputes on that event only — never per frame.

### 1.2 Capability matrix

| provider | canSeekSilently | canSetQuality | hasOwnChrome | needsMuteForAutoplay | canTruePause | canSetRate | pixelSource |
|---|---|---|---|---|---|---|---|
| local-file | ✅ | n/a (`false`) | ❌ | ✅ | ✅ | ✅ | video-element |
| direct-file | ✅ (after buffer) | ❌ | ❌ | ✅ | ✅ | ✅ | video-element |
| hls | ⚠️ within buffer | ✅ (`hls.currentLevel`) | ❌ | ✅ | ✅ | ✅ | video-element |
| dash | ⚠️ within buffer | ✅ (`setQualityFor`) | ❌ | ✅ | ✅ | ✅ | video-element |
| resolver | ✅ | ✅ (via `maxHeight` re-resolve) | ❌ | ✅ | ✅ | ✅ | video-element |
| youtube-embed | ⚠️ measured at runtime | ❌ (API is a documented no-op) | ✅ | ✅ | ❌ | ✅ (discrete set) | cross-origin-iframe |
| twitch | ⚠️ VOD only | ✅ (`setQuality`, not tier-gated) | ✅ | ✅ | ✅ | ❌ | cross-origin-iframe |
| vimeo | ⚠️ | ❌ for public videos (Plus/PRO/Business gated) | ✅ | ✅ | ✅ | ⚠️ PRO-gated | cross-origin-iframe |
| streamable | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | cross-origin-iframe |

`canSeekSilently` for youtube-embed starts `false` and is **promoted to `true`** after 3 consecutive loop crossings with no `BUFFERING` state — see §3.4.

### 1.3 URL routing table (`routing/patterns.ts`)

Evaluated top-to-bottom; first match wins. All regexes run against a **normalized** URL (trim, strip zero-width chars, `http:`→`https:` upgrade attempted first, lowercase host, strip trailing `/`).

```ts
export const URL_ROUTES: Route[] = [
  // --- hard rejects (run FIRST so they can't be swallowed by direct-file) ---
  { id: 'reject-container', re: /\.(mkv|mka|avi|flv|wmv|rmvb|3gp)(\?|#|$)/i,
    error: 'unsupported-container' },
  { id: 'reject-reddit-comments', re: /^https:\/\/(www\.|old\.)?reddit\.com\/r\//i,
    error: 'reddit-comment-url' },

  // --- explicit local clip URI (our own scheme; travels through URL params/MQTT) ---
  { provider: 'local-file', re: /^krakenhub-clip:([A-Za-z0-9_-]{8,})$/, id: 1 },

  // --- YouTube (11-char ids) ---
  { provider: 'youtube-embed',
    re: /^https:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)([\w-]{11})/, id: 1,
    meta: (u) => ({ portrait: /\/shorts\//.test(u), start: ytStartParam(u) }) },
  { provider: 'youtube-embed', re: /^https:\/\/youtu\.be\/([\w-]{11})/, id: 1,
    meta: (u) => ({ start: ytStartParam(u) }) },

  // --- Vimeo (group 2 = unlisted hash) ---
  { provider: 'vimeo', re: /^https:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d+)(?:\/([0-9a-f]{6,20}))?/, id: 1 },

  // --- Twitch ---
  { provider: 'twitch', re: /^https:\/\/(?:www\.|m\.)?twitch\.tv\/videos\/(\d+)/, id: 1, meta: () => ({ kind: 'vod' }) },
  { provider: 'twitch', re: /^https:\/\/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/, id: 1, meta: () => ({ kind: 'clip' }) },
  { provider: 'twitch', re: /^https:\/\/(?:www\.)?twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/, id: 1, meta: () => ({ kind: 'clip' }) },
  { provider: 'twitch', re: /^https:\/\/(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})\/?$/, id: 1, meta: () => ({ kind: 'channel', live: true }) },

  { provider: 'streamable', re: /^https:\/\/streamable\.com\/(?:e\/)?([a-z0-9]{4,8})/, id: 1 },

  // --- Reddit video: default to direct-file (see §1.5), dash only when audio wanted ---
  { provider: 'reddit', re: /^https:\/\/v\.redd\.it\/([a-z0-9]+)/i, id: 1 },

  // --- by extension ---
  { provider: 'hls',        re: /\.m3u8?(\?|#|$)/i },
  { provider: 'dash',       re: /\.mpd(\?|#|$)/i },
  { provider: 'direct-file',re: /\.(mp4|m4v|webm|ogv|ogg)(\?|#|$)/i },
  { provider: 'direct-file',re: /\.(mov)(\?|#|$)/i, warn: 'mov-codec-risk' },

  // --- warn-only annotations (do not decide the provider) ---
  { annotate: true, re: /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i, warn: 'discord-expiring-url' },
  { annotate: true, re: /^https:\/\/i\.imgur\.com\//i, warn: 'imgur-unreliable' },
  { annotate: true, re: /[?&]list=/i, warn: 'youtube-playlist-ignored' },
];
```

Unmatched HTTPS URL → `providerId: 'direct-file'`, `confidence: 0.2`, flag `needsFallbackChain: true` (§7.3).

### 1.4 Resolver interposition (not a URL pattern)

`resolver` is a **policy layer**, applied in `detect()`'s caller:

```
resolverPolicy: 'off' | 'youtube-only' | 'preferred' | 'fallback'
```
- `off` (default) → never used.
- `youtube-only` → if match is `youtube-embed` and resolver `/health` is OK, swap to `resolver`.
- `preferred` → try resolver for *any* match whose provider has `hasOwnChrome || !canSetQuality`.
- `fallback` → use resolver only after the primary adapter emits a fatal error.

Any resolver failure downgrades to the original match and emits telemetry `resolver-fallback` (never a user-visible error unless the primary also fails).

### 1.5 DASH library decision — **dash.js 5.2.1** (not shaka)

Justification, in priority order:
1. **Target workload is v.redd.it.** Its `DASHPlaylist.mpd` is non-conformant in small ways (missing/loose `mimeType`, separate video-only and audio-only AdaptationSets, occasional 403 on the audio set). dash.js is the DASH-IF reference implementation and is deliberately permissive about manifests it can still play; shaka validates harder and rejects a class of manifests dash.js tolerates.
2. **Bundle:** dash.js ≈ 400 KB min vs shaka ≈ 600 KB+, and both are lazy `import()`ed — but on a device whose *frame budget* is the scarce resource, less parse/compile work at mount matters.
3. **Attach-to-existing-`<video>` API** (`player.initialize(videoEl, url, autoplay)`) maps 1:1 onto `HtmlVideoAdapterBase`; shaka's `Player` + `attach()` + `load()` lifecycle needs more glue.
4. We already ship hls.js for HLS, so shaka's "one library for both" advantage doesn't apply.
5. Rejected shaka strengths (EME/DRM, LL-DASH, offline) are all irrelevant here.

**Reddit-specific strategy (important simplification):** the Kraken display is *always muted*, so v.redd.it's split-audio problem does not affect the LCD. Therefore:
- `provider: 'reddit'` resolves at mount to **`direct-file`** on the highest working `https://v.redd.it/<id>/DASH_<h>.mp4`, probed in order `1080, 720, 480, 360` by attaching to a throwaway `<video preload="metadata">` with a 4 s timeout each. v.redd.it sends `ACAO: *`, so this is CORS-clean and skips the dash.js bundle entirely.
- Only when `config.audio.enabled === true` (or the direct probe ladder fully fails) do we mount `dash` on `DASHPlaylist.mpd`.
- dash.js audio-failure handling: subscribe to `MediaPlayer.events.ERROR`; if the failing request's `mediaType === 'audio'` twice in a row while video keeps buffering, log `dash-audio-dropped`, force `setMuted(true)`, and continue — never let an audio 403 kill video.

---

## 2. YouTube geometry engine (full detail)

### 2.1 The principle

CSS cannot hide YouTube chrome (cross-origin). A CSS `transform: scale()` on a *parent* does not shrink the iframe's internal layout viewport, so the player still measures its own `width`/`height` attributes. Both problems are solved by one move: **make the iframe large and shaped so the player letterboxes the video, then crop the center — the chrome lands on the black bars.**

### 2.2 Geometry math (`youtube/geometry.ts`, pure functions)

Inputs:
```ts
interface GeomInput {
  displayW: number; displayH: number;       // window.nzxt.v1.width/height, default 640
  dpr: number;                               // clamp(devicePixelRatio || 1, 1, 3)
  zoom: number;                              // >= 1 for cover
  sourceAspect: number;                      // default 16/9
  mode: 'square' | 'tight';                  // default 'square'
  qualityFloorPx: number;                    // default 1920 (perf mode: 1280)
  ladder: number[];                          // [1280, 1600, 1920, 2560]
}
```

**Step 1 — required crop size.**
```
S_needed = ceil(max(displayW, displayH) * dpr * zoom)
```

**Step 2 — crop side as a function of element width `W_el` (letterbox case, `a = sourceAspect`):**
- Landscape (`a ≥ 1`), square element: video rendered `W_el × W_el/a`, bars `B = (H_el − W_el/a)/2`, max square crop `C = W_el / a`.
- Portrait (`a < 1`): a square element *pillarboxes* (chrome overlaps video). Must use a **tall** element with aspect `< a`. Then `C = W_el`.

**Step 3 — element width selection:**
```
W_el = smallest N in ladder such that  C(N) >= S_needed   AND  N >= qualityFloorPx
if none qualifies -> N = max(ladder)  and emit telemetry 'geometry-undersized'
```

**Step 4 — element height:**
```
mode 'square' : H_el = W_el                        (a >= 1 only)
mode 'tight'  : H_el = round(W_el/a) + 2*BAR_SAFE  , BAR_SAFE = max(180, 0.12*W_el/a)
portrait      : H_el = round(W_el/a) + 2*BAR_SAFE  , BAR_SAFE = max(240, 0.125*W_el/a)
                (verify H_el/W_el implies elementAspect < a; if not, raise BAR_SAFE)
```

**Step 5 — crop rect + transform.** With effective crop `C_eff = C / zoom`, pan `(px, py) ∈ [-0.5, 0.5]`:
```
sx0 = (W_el - C_eff)/2 + px * (C - C_eff)
sy0 = (H_el - C_eff)/2 + py * (C - C_eff)
s   = displayW / C_eff
transform-origin: 0 0
transform: translate({-sx0*s}px, {-sy0*s}px) scale({s})
```

### 2.3 Worked examples

**Elite 640×640, DPR 1, zoom 1, 16:9, mode `square`:**
- `S_needed = 640`. `C(N) = N·9/16`. `C(1280)=720 ≥ 640` ✓ but `qualityFloorPx=1920` forces `N = 1920`.
- `C = 1080`, `H_el = 1920`, bars `B = (1920−1080)/2 = 420`. Video occupies `y ∈ [420, 1500]`.
- Crop rect: `sx0 = sy0 = (1920−1080)/2 = 420`, side `1080` → `x,y ∈ [420,1500]`.
- `s = 640/1080 = 0.5925926`. `tx = ty = −420 × 0.5925926 = −248.889 px`.
- CSS: `width:1920px; height:1920px; transform-origin:0 0; transform: translate(-248.889px,-248.889px) scale(0.5925926);`
- Verify: element `(420,420)` → `(0,0)`; element `(1500,1500)` → `(640,640)`. ✓
- Supersample ratio at true 1080p: `1080/640 = 1.6875×`. At 720p served: `720/640 = 1.125×`. At 480p: `0.75×` (upscaled — triggers the quality alarm).

**Useful invariant:** for 16:9 in a *square* element at zoom 1, `tx = ty = −(0.21875 / 0.5625) × displayW = −0.388889 × displayW`, **independent of N**.
- 640 → **−248.889 px**; 320 (Kraken Z) → **−124.444 px**; 240 (Kraken 2023) → **−93.333 px**.

**Elite, zoom 1.5:** `C_eff = 1080/1.5 = 720`; `sx0 = (1920−720)/2 = 600`; `s = 640/720 = 0.888889`; `tx = −600 × 0.888889 = −533.333 px`. Native pixels behind the visible area = `720` (vs 640 needed) → still ≥1×. **Pixel-parity zoom limit at N=1920 is `1080/640 = 1.6875×`.** Beyond that, step to `N=2560` (parity limit `1440/640 = 2.25×`).

**Elite, N=2560:** bars `= (2560−1440)/2 = 560`; crop `1440` at `(560,560)`; `s = 640/1440 = 0.444444`; `tx = ty = −560 × 0.444444 = −248.889 px` (same invariant).

**Elite, mode `tight`, 16:9:** `W_el=1920`, video height 1080, `BAR_SAFE = max(180, 129.6) = 180` → `H_el = 1440`. `sx0 = 420`, `sy0 = (1440−1080)/2 = 180`. `s = 0.5925926`; `tx = −248.889`, `ty = −106.667`. Element area drops from 3.686 Mpx to 2.765 Mpx (**−25 % compositor surface**, same 1080 crop, same 1920 measured width for the quality heuristic). Ship `square` as default (max chrome margin, matches the researched recommendation); expose `tight` under performance mode after on-device verification.

**Shorts / portrait 9:16 (`a = 0.5625`), Elite:** `C = W_el`. `S_needed = 640` → `W_el ≥ 640`, but quality floor pushes to `1280` (portrait sources max out at 1080×1920 anyway; `W_el = 1280` measured width is the largest that still makes sense). Take `W_el = 1080`: video height `= 1080/0.5625 = 1920`; `BAR_SAFE = max(240, 240) = 240` → `H_el = 2400`; element aspect `0.45 < 0.5625` ✓ letterboxed. `sx0 = 0`, `sy0 = 240`, `C = 1080`, `s = 0.5925926`, `tx = 0`, `ty = −142.222 px`. ⚠️ Whether a 1080-wide element still elicits 1080p from the size heuristic is **unverified** — flag `geometry-portrait-unverified` and expose `portraitWidth` config (default 1080, alt 1440).

**Baked-in bars** (2.39:1 film inside a 16:9 upload): the black bars are *pixels*, not letterbox. Handle with `sourceInset: {top,bottom,left,right}` as fractions of the video rect, applied to `full`/`safe` before the crop math.

### 2.4 `sourceAspect` resolution (no reliable auto-detect)

There is no cross-origin way to read the true aspect: the iframe is opaque, `i.ytimg.com` thumbnails are always 16:9 with bars baked in, and oEmbed returns *player* dimensions, not source dimensions. Therefore:
```ts
sourceAspect: number | 'auto'   // 'auto' => /shorts/ URL ? 9/16 : 16/9
```
Config UI + remote UI expose presets: `16:9, 9:16, 4:3, 1:1, 21:9 (2.33), 2.39:1`. Document this honestly in `docs/youtube-geometry.md` as a known manual step.

### 2.5 Exact embed URL and iframe attributes

```ts
const YT_INCLUDE_INERT_VQ = false; // measured: `vq` is echoed in client.originalUrl only,
                                   // never parsed into PLAYER_VARS. Kept as a named constant
                                   // so the finding is discoverable in code.

function buildEmbedUrl(id: string, startSec: number): string {
  const p = new URLSearchParams({
    enablejsapi: '1',
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    controls: '0',
    rel: '0',
    iv_load_policy: '3',
    disablekb: '1',
    fs: '0',
    cc_load_policy: '0',
    color: 'white',
    loop: '0',                          // JS A-B loop only; never the loop= param
  });
  if (location.origin !== 'null') p.set('origin', location.origin);
  if (startSec > 0) p.set('start', String(Math.floor(startSec)));
  return `https://www.youtube-nocookie.com/embed/${id}?${p}`;
}
```

Iframe element (attributes AND CSS must both carry the size — the attribute is what the player measures):
```html
<iframe
  width="1920" height="1920" style="width:1920px;height:1920px;border:0;display:block"
  src="…"
  allow="autoplay; encrypted-media; picture-in-picture"
  referrerpolicy="strict-origin-when-cross-origin"
  frameborder="0" scrolling="no" tabindex="-1" title="video"
  loading="eager"></iframe>
```
Never add `sandbox` (breaks postMessage/API). Never add `modestbranding` (deprecated, no effect). Attach via `new YT.Player(iframeEl, {events})` on the **pre-existing** iframe so we, not the API, own the width/height attributes.

`ytApiLoader.ts`: single-flight promise, injects `https://www.youtube.com/iframe_api` once, chains any pre-existing `window.onYouTubeIframeAPIReady`, 10 s timeout → `VideoError('yt-api-unavailable')`.

### 2.6 Overlay mask state machine (`youtube/maskController.ts`)

The mask is a `position:absolute; inset:0` div **over the viewport** (not inside the transformed stage), `z-index:2`, `pointer-events:none`, background = poster image (`https://i.ytimg.com/vi/<id>/maxresdefault.jpg`, `object-fit:cover`, falls back to `hqdefault.jpg` then flat `maskColor`, default `#000`).

States: `HIDDEN → SHOWING → VISIBLE → HIDING → HIDDEN`. Transition: `opacity 180ms linear` on fade-out; **instant** (`transition:none`) on fade-in.

| trigger | action |
|---|---|
| mount | `VISIBLE` |
| `onStateChange` UNSTARTED(−1), CUED(5), PAUSED(2), ENDED(0) | `VISIBLE` instant |
| `onStateChange` BUFFERING(3) | `VISIBLE` instant |
| `seek()` issued | `VISIBLE` instant, set `seekPending` |
| `onStateChange` PLAYING(1) && `getCurrentTime() > A + 0.05` && !seekPending | after `holdAfterPlayingMs` (default 120 ms) → `HIDING` |
| loop crossing, `observedSilentSeek === true` | mask flash capped at 100 ms |
| `VISIBLE` for > `maskMaxMs` (2500 ms) while state is PLAYING | force `HIDING` (failsafe — never leave a black screen) |
| `VISIBLE` for > 15 000 ms | escalate to `ErrorCard('stalled')` + telemetry |

**Never call `pauseVideo()`** (it triggers `ytp-pause-overlay`'s suggested-video grid and the title overlay). `hold()` for youtube-embed = engage a **micro-loop**: `setPlaybackRate(min available, typically 0.25)` and set a temporary loop `[t, t + 0.30]`. Documented alternative (`config.youtube.pauseStrategy: 'microloop' | 'maskedPause'`): `maskedPause` raises the mask to fully opaque, waits 2 rAF, *then* calls `pauseVideo()` — the overlay is invisible behind our own DOM. Default is `microloop` per locked decision; `maskedPause` is documented as the lower-power option for long holds.

**Never let playback reach `duration`** (end screen). Effective end is always `min(B, duration − endGuardSec)`, `endGuardSec` default `1.0`. When no A-B loop is configured, we still install an implicit loop `[0.05, duration − 1.0]`.

### 2.7 Quality verification + fallback ladder (`youtube/qualityWatch.ts`)

`onPlaybackQualityChange` still fires and is our only read-only signal. Map labels → heights:
`small→240, medium→360, large→480, hd720→720, hd1080→1080, hd1440→1440, hd2160/highres→2160`.

Watchdog, armed 6 s after first `PLAYING`:
```
observedH = last quality height (null if never fired)
targetH   = ceil(cropSide)          // 1080 at N=1920
bufferHealthy = getVideoLoadedFraction() * duration - getCurrentTime() > 6
bufferingEventsIn30s = counter
```
- `observedH >= 720` → OK, publish `tele.quality`.
- `observedH < 720 && bufferHealthy && bufferingEventsIn30s <= 1` → **size-limited hypothesis**. Step the ladder **once**: `N: 1920 → 2560`, remount (preserving current time), remember in `sessionStorage['krakenhub:v1:video:ytLadder'] = 2560`. If still `< 720` after the retry, stop escalating and publish `tele.quality-capped`.
- `observedH < 720 && (!bufferHealthy || bufferingEventsIn30s > 1)` → **network-limited**. Do NOT step up (it would make things worse). Publish `tele.network-limited`; if `perf === 'auto'`, step *down* to `N = 1280` to reduce decode+composite cost.

**2560 trade-off, documented:** a 2560×2560 element is 6.55 Mpx of composited surface and may pull a 1440p/2160p decode. On a machine already running games, this can cost more frames than the extra sharpness buys, especially since CAM's Elite pipeline compresses frames and the LCD is only 640×640. Rule of thumb baked into docs: **only step to 2560 if `zoom > 1.6875`, or if the quality watchdog proves a size cap.**

### 2.8 Ad honesty

YouTube embeds can and do serve ads and, on some videos, in-video cards. Ads render **inside the video rect**, so the geometry trick cannot remove them — the crop only hides the *player chrome*. During an ad the mask stays down (we can't reliably detect ads from the embed API). This is stated plainly in `README.md`, in `docs/youtube-geometry.md`, and in the config UI next to the YouTube URL field, alongside the recommendation: for an ad-free, chrome-free, full-quality result use **local-file** or the **resolver**.

---

## 3. A-B loop engine

### 3.1 Config and semantics

```ts
export interface LoopConfig {
  enabled: boolean;
  start: number;                 // seconds, >= 0
  end: number | null;            // null => duration - endGuardSec
  mode: 'hard' | 'crossfade';    // crossfade: HTML-video adapters only
  crossfadeMs?: number;          // default 250, clamped 60..1000
}
export const LOOP_DEFAULTS = { minSpanSec: 0.25, endGuardSec: 1.0, epsSec: 0.02 };
```

### 3.2 Validation (`LoopEngine.validate`)

Run on config change **and** on every `durationchange`:
1. `start = max(0, start)`.
2. `endResolved = end ?? (isFinite(duration) ? duration - endGuardSec : NaN)`.
3. If `isFinite(duration)`: `endResolved = min(endResolved, duration - endGuardSec)`; `start = min(start, endResolved - minSpanSec)`.
4. If `endResolved - start < minSpanSec` → `invalid: 'loop-span-too-short'`, loop disabled, warning to telemetry (not an error card — playback continues unlooped).
5. If `start >= duration` → clamp to `0` and warn `loop-start-past-duration`.

**Duration unknown** (`NaN`, `0`, `Infinity`, live streams): loop stays in `PENDING`. Playback proceeds unlooped; the engine subscribes to `durationchange`/`onReady` and re-validates once. If duration is still unknown after 10 s (live HLS/Twitch channel), set `enabled=false`, capability `canSeek=false`, and publish `tele.loop-unavailable-live`. Live sources are never looped.

### 3.3 `HtmlVideoLoop` (local-file, direct-file, hls, dash, resolver)

`timeupdate` alone fires at ~4 Hz → up to 250 ms of overshoot. Use a **hybrid**:
- rAF tick (primary): predictive crossing.
  ```
  const t = v.currentTime, rate = v.playbackRate || 1;
  const dt = (now - lastTick) / 1000;
  if (!seeking && t + rate * Math.max(dt, 1/60) >= end - epsSec) doLoop();
  ```
- `timeupdate` (redundant safety net for when rAF is throttled by `visibilitychange` — the Kraken Browser is a hidden window and may be rAF-throttled; **this is the reason the hybrid exists, not an optimization**).
- `doLoop()`: set `seeking = true`; `v.currentTime = start`; clear on the `seeked` event (or a 500 ms timeout). Guard prevents seek storms.
- After the seek, if `v.readyState < 3` for > 300 ms, raise the mask.

`hold()` = real `pause()`. `play()` = `v.play()` with a catch → on `NotAllowedError`, force `v.muted = true` and retry once; if that also fails, `ErrorCard('autoplay-blocked')`.

### 3.4 `PolledLoop` (youtube-embed, twitch, vimeo)

- Poll `getCurrentTime()` on rAF (YouTube's value is locally interpolated, so rAF gives smooth readings; Vimeo's `getCurrentTime()` is a Promise — poll at 10 Hz with an in-flight guard and use the `timeupdate` event payload as the primary clock).
- `LOOKAHEAD_S = max(0.08, 2 × pollIntervalS)`. Crossing when `(end − t) / rate <= LOOKAHEAD_S`. When `remaining < 0.35 s`, schedule a `setTimeout` at the predicted crossing instant for sub-poll precision.
- On crossing: `mask.showInstant()` → `seekTo(start, true)` (YT) / `seek(start)` (Twitch) / `setCurrentTime(start)` (Vimeo) → wait for `PLAYING` **or** for `getCurrentTime() >= start + 0.05`, whichever first → fade mask after `holdAfterPlayingMs`.
- **Buffer priming:** the first pass plays `[start, end]` uninterrupted so the span sits in one buffered region; backward seeks inside a buffered range typically do not spin. `primed = getVideoLoadedFraction() * duration >= end` or `crossings >= 1`.
- **Adaptive `canSeekSilently`:** count `BUFFERING` states within 600 ms of the last 3 crossings. Zero → set `capabilities.canSeekSilently = true` and cut the mask flash to 100 ms. Any → revert to state-driven masking. Publish the observed value as telemetry so the config UI can show "loop is seamless / loop shows a brief flash".
- Twitch: `seek()` works for VOD/clip only; `kind:'channel'` (live) disables loop entirely. Vimeo: never call `setLoop(true)` (it suppresses `ended`, which we use as a failure signal).

### 3.5 `hold()` semantics per adapter class

| adapter | `hold()` |
|---|---|
| html-video family | `v.pause()` (true pause) |
| youtube-embed | micro-loop `[t, t+0.30]` at `setPlaybackRate(0.25)`; alt `maskedPause` |
| twitch | `player.pause()` (Twitch has no pause-overlay ad grid) |
| vimeo | `player.pause()` — but raise the mask first, Vimeo shows a play button + title on pause |
| streamable | not supported → `hold()` resolves as a no-op, `canTruePause:false` |

### 3.6 Optional crossfade (`loop/crossfade.ts`)

Only for `local-file` / `direct-file` / `resolver` (same-origin or CORS-clean progressive files). Two `<video>` elements sharing the same `src`/blob URL; the idle one pre-seeks to `start` and stays paused; at `end − crossfadeMs` it `play()`s and the two CSS-crossfade opacity over `crossfadeMs`, then roles swap. **Cost: two simultaneous decoders.** Default `false`, hard-disabled when `perf === 'performance'` or `targetFps <= 10`, and the config UI states the cost.

---

## 4. Render controls (`render/RenderController.ts`)

```ts
export interface RenderConfig {
  fit: 'cover' | 'contain' | 'contain-circle' | 'fill';
  zoom: number;         // >= 1 for cover; clamped [1, 4] (perf mode [1, 1.5])
  offsetX: number;      // [-0.5, 0.5] normalized pan within the available slack
  offsetY: number;
  rotate: 0 | 90 | 180 | 270;
  allowChrome: boolean; // required to use fit:'contain' on hasOwnChrome providers
}
```

### 4.1 One math path for iframes and `<video>`

Both provider classes report a `SourceRect`; `RenderController` never branches on provider type. It emits a single transform onto the adapter surface, inside a rotor wrapper.

DOM:
```html
<div class="kh-viewport">          <!-- W×H, overflow:hidden, position:relative, background:#000 -->
  <div class="kh-rotor">           <!-- W×H, transform-origin:50% 50%, transform: rotate(θ) -->
    <div class="kh-stage">         <!-- position:absolute; top:0; left:0; transform-origin:0 0 -->
      <!-- adapter surface: <iframe 1920×1920> OR <video 1920×1080> -->
    </div>
  </div>
  <div class="kh-mask"></div>      <!-- z-index 2 -->
  <div class="kh-overlays"></div>  <!-- z-index 3: ErrorCard, FpsAdvisory, badges -->
</div>
```

Source rect selection:
- `fit: 'cover'` → `rect = sourceRect.safe`
- `fit: 'contain' | 'contain-circle' | 'fill'` → `rect = allowChrome ? sourceRect.full : sourceRect.safe`
- For `hasOwnChrome` providers with `allowChrome === false`, `contain` on the *safe* rect means containing a square crop — visually identical to `cover` on a square display. So: **`fit` is forced to `'cover'` for `hasOwnChrome` providers unless `allowChrome === true`**, and the config UI disables the other options with the tooltip "YouTube/Twitch/Vimeo paint their own UI; kraken-hub hides it by cropping. Contain would show it."

Math (`render/fit.ts`, pure, unit-tested):
```ts
// cover
const s = Math.max(W / rect.w, H / rect.h) * zoom;
// contain
const s = Math.min(W / rect.w, H / rect.h) / 1;          // zoom applied on top
// contain-circle : largest rect of aspect `a` inscribed in the circle of diameter D
//   h = D / sqrt(1 + a^2), w = a*h
const a = rect.w / rect.h, D = Math.min(W, H);
const hC = D / Math.sqrt(1 + a * a), wC = a * hC;
const s = (wC / rect.w) * zoom;
// fill (non-uniform)
const sx = W / rect.w * zoom, sy = H / rect.h * zoom;

// visible source window, then top-left placement
const visW = W / sx, visH = H / sy;
const slackX = Math.max(0, rect.w - visW), slackY = Math.max(0, rect.h - visH);
const sx0 = rect.x + (rect.w - visW) / 2 + offsetX * slackX;
const sy0 = rect.y + (rect.h - visH) / 2 + offsetY * slackY;
const vx = Math.max(0, (W - rect.w * sx) / 2);   // letterbox centering for contain
const vy = Math.max(0, (H - rect.h * sy) / 2);
stage.style.transform =
  `translate(${(vx - sx0 * sx).toFixed(3)}px, ${(vy - sy0 * sy).toFixed(3)}px) scale(${sx},${sy})`;
```

**Worked check (contain, 640×640, 16:9 video 1920×1080, `allowChrome`):**
`s = min(640/1920, 640/1080) = 0.333333`. `vx = 0`, `vy = (640 − 360)/2 = 140`. `sx0 = 0, sy0 = 420` (video band starts at y=420 in the square iframe). `tx = 0 − 0 = 0`; `ty = 140 − 420×0.33333 = 140 − 140 = 0`. Transform: `translate(0,0) scale(0.333333)` → 640×640 element showing a 640×360 video band centered. ✓

**contain-circle, 640 circle, 16:9:** `a = 1.7778`; `hC = 640/√(1+3.1605) = 640/2.03960 = 313.79`; `wC = 557.85`. `s = 557.85/1920 = 0.290547`. Video drawn 557.9×313.8 centered — fully inside the round bezel. ✓

### 4.2 Rotation

`kh-rotor` gets `transform: rotate(θdeg)` with `transform-origin: 50% 50%`. All Kraken panels are square, so 90/270 need no dimension swap. Guard anyway: if `W !== H` and `θ ∈ {90,270}`, the rotor is sized `H×W` and offset by `(W−H)/2, (H−W)/2` before rotating. Rotation is a compositor-only property; it costs one extra layer. Under `perf === 'performance'`, when `θ === 0` the rotor is removed from the DOM entirely rather than left with an identity transform.

### 4.3 Circular safe area (`render/safeArea.ts`)

`shape === 'circle'` affects **overlays only**, never the video (video is meant to bleed to the bezel). Overlay content is constrained to the inscribed square of a concentric circle at `safeRadiusPct` (default `0.88` of `D/2`):
```
insetPx = (D/2) * (1 - safeRadiusPct / Math.SQRT2)
```
For `D = 640`, `safeRadiusPct = 0.88`: `insetPx = 320 × (1 − 0.62225) = 120.9 px` → overlay box `398×398` centered. Error cards and the FPS advisory live inside that box. Minimum overlay font size **22 px** (readable at 640×640 after CAM's compression).

### 4.4 Compositor hygiene

- `will-change: transform` on `kh-stage` **only** (one promoted layer). Never on `kh-mask` or `kh-viewport`.
- Zero CSS `filter`, `backdrop-filter`, `box-shadow`, or `border-radius` on the stage — each forces extra raster work per frame.
- Transform values rounded to 3 decimals to avoid sub-pixel churn.
- Transforms are written **imperatively** (not through React state) from `RenderController`, so config changes never re-render the tree that owns the `<iframe>`/`<video>` (a React re-render that recreates the iframe would restart playback).

---

## 5. Local-file pipeline

### 5.1 Why upload must happen inside CAM's Configuration Browser

CAM's Kraken Browser and Configuration Browser are two windows in the **same Electron session/partition** on the same origin — that shared partition is exactly what makes localStorage/`storage` events/IndexedDB work as the sanctioned config→display channel. The user's normal Chrome/Firefox on the same PC, and their phone, are **different browsers with entirely separate storage partitions**. A Blob written to IndexedDB from the remote page lands in storage the Kraken Browser can never read. There is no static-hosting workaround: no shared server, no cross-partition API.

**How the remote page communicates this:**
- The remote control page hides the upload control entirely and renders a `LocalClipsPanel` explaining: *"Local clips live in NZXT CAM's browser storage on your PC. To add one: CAM → Lighting → Kraken → your kraken-hub card → Configure, then drop the file in."* with a copy-able deep link `https://cam-redirect.nzxt.com/action/load-web-integration?url=<site>`.
- The remote page can still **select** existing clips: the display publishes its clip index on the `tele` channel — `{ ch:'tele', kind:'clipIndex', clips:[{id,name,durationSec,size,w,h,mime}] }`, capped at 40 entries, republished on library change and every 5 min. Thumbnails are **not** sent (payload budget); the remote shows name + duration + resolution.
- Selecting a clip sets `source.url = 'krakenhub-clip:<id>'` in the retained state snapshot.
- If the remote sets a clip id the display doesn't have, the display renders `ErrorCard('clip-missing')` and re-publishes the clip index.

### 5.2 IndexedDB schema (`local/clipStore.ts`)

DB name **`krakenhub.v1`** (the `<user>.github.io` origin is shared across all of that user's repos — never use a generic name). Version 1.

| store | keyPath | contents |
|---|---|---|
| `clips` | `id` | `{ id, name, mime, size, durationSec, width, height, createdAt, lastUsedAt, thumbBlob, sha256Prefix }` |
| `clipBlobs` | `id` | `{ id, blob }` — split so list queries never load video bytes |
| `kv` | `k` | module scratch (`persistGranted`, `lastQuotaCheck`) |

Indexes: `clips.by-createdAt`, `clips.by-lastUsedAt`. `id = crypto.randomUUID()` (or 16 random bytes base32) — never the filename.

All localStorage keys are namespaced `krakenhub:v1:<module>:<key>`. Cache Storage entries prefixed `krakenhub-v1-`. Service worker registered as `./sw.js` so its scope is confined to `/<repo>/`.

### 5.3 Ingest (`local/ingest.ts`)

Triggered from `VideoConfigPanel` by `<input type="file" accept="video/mp4,video/webm,video/quicktime" multiple>` **and** a drop zone covering the panel (`dragover`/`dragenter` `preventDefault()`, `dragleave` counter to avoid flicker, `drop` reads `e.dataTransfer.files`).

Per file:
1. **Reject** by extension/MIME: `.mkv/.mka/.avi/.flv/.wmv` → `ErrorToast('unsupported-container')` with the exact message in §7.1. Chromium cannot demux Matroska in `<video>`; this is a hard platform limit, not a bug.
2. **Codec feature-detect**: `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')` and `...av01.0.08M.08` before accepting HEVC/AV1 files — HEVC in Chromium is hardware-dependent with no software fallback, so it can fail on a machine whose GPU lacks HEVC decode. Warn, don't hard-reject (the file may still play).
3. **Probe**: create an offscreen `<video preload="metadata" muted playsinline>` with `URL.createObjectURL(file)`. On `loadedmetadata`, capture `duration`, `videoWidth`, `videoHeight`. 8 s timeout → `probe-timeout`, offer "add anyway".
4. **Thumbnail**: `currentTime = min(1, duration * 0.1)`; on `seeked`, draw cover-cropped into a 320×320 canvas → `canvas.toBlob(b => …, 'image/webp', 0.8)`. Revoke the object URL immediately after.
5. **Quota**: `const {usage, quota} = await navigator.storage.estimate()`. Refuse when `usage + file.size > quota * 0.9` with a message naming both numbers in MB. Show a usage bar in the panel.
6. **Persistence**: on the first successful add (inside the user gesture), `await navigator.storage.persist()`; store the result in `kv.persistGranted` and render a badge — *Persistent* (green) or *Best-effort — Chromium may evict clips under disk pressure* (amber). Re-request on each subsequent add if not yet granted.
7. Write `clipBlobs` then `clips` in a **single** `readwrite` transaction across both stores so a metadata row never exists without bytes.
8. Publish an updated clip index over the sync channel and via a `storage` event on `krakenhub:v1:video:clipIndex`.

### 5.4 Blob URL lifecycle (`local/blobUrlRegistry.ts`)

Refcounted module-level `Map<clipId, {url: string; refs: number}>`.
- `acquire(clipId)` → creates via `URL.createObjectURL(blob)` on first ref.
- `release(clipId)` → decrements; on zero, `URL.revokeObjectURL`.
- Adapter `mount()` calls `acquire`, `teardown()` calls `release` — **after** `video.removeAttribute('src'); video.load();` (revoking while the element still references it can abort decode with a confusing `MEDIA_ELEMENT_ERROR`).
- Never create object URLs in a render function or rAF loop. A leaked object URL pins the whole Blob in memory for the lifetime of the document — and the Kraken Browser document lives for weeks.
- On `pagehide`, release everything.

### 5.5 Size guidance (docs + inline in the panel)

Recommended: ≤ 200 MB per clip, ≤ 2 GB total library. Square-crop before uploading — you're feeding a 640×640 round screen, so a 1080×1080 square clip has zero wasted pixels and one third the bitrate of a 1920×1080 one at equal quality.

```bash
ffmpeg -i input.mp4 \
  -vf "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080,fps=30" \
  -c:v libx264 -profile:v high -crf 21 -pix_fmt yuv420p \
  -movflags +faststart -an output.mp4
```
`-an` (drop audio) is deliberate: the LCD is always muted, and stripping audio saves space and decode work. `+faststart` matters for the `direct-file` adapter when the same file is later hosted.

---

## 6. Resolver interface spec (FROZEN v1)

Base URL: `http://127.0.0.1:<port>`, default port **8976**, user-configurable. `http://127.0.0.1` and `http://localhost` are *potentially trustworthy origins* and are therefore **exempt from Chromium's mixed-content blocking** even on our HTTPS page. `http://<LAN-IP>` is **not** exempt — the config UI must reject any resolver base that isn't loopback.

### 6.1 Wire contract (`resolver/resolverTypes.ts`)

```
GET /health
200 { "ok": true, "name": "krakenhub-resolver", "version": "1.0.0", "api": 1,
      "capabilities": ["resolve","stream","probe"], "maxHeight": 2160 }

GET /resolve?url=<encoded>&maxHeight=1080&prefer=progressive&audio=0[&token=…]
200 { "status": "ok",
      "kind": "progressive" | "hls" | "dash" | "file",
      "streamUrl": "http://127.0.0.1:8976/stream/<opaque>.mp4",
      "mime": "video/mp4",
      "width": 1920, "height": 1080, "fps": 30,
      "durationSec": 213.4,
      "title": "…", "thumbUrl": "http://127.0.0.1:8976/thumb/<opaque>.jpg",
      "expiresAt": 1788150000 }
202 { "status": "pending", "jobId": "…", "retryAfterMs": 1500 }
400 { "status": "error", "code": "unsupported-url",  "message": "…" }
404 { "status": "error", "code": "not-found",        "message": "…" }
429 { "status": "error", "code": "rate-limited",     "retryAfterMs": 5000 }
502 { "status": "error", "code": "upstream-failed",  "message": "yt-dlp: …" }

GET /job/<jobId>          -> same envelope as /resolve
GET /stream/<opaque>.mp4  -> 200/206; MUST support Range
```

Error `code` is a closed enum: `unsupported-url | not-found | upstream-failed | rate-limited | forbidden | internal`.

### 6.2 CORS requirements on the companion

On **every** endpoint including `/stream` and `/thumb`:
```
Access-Control-Allow-Origin: *                (or echo the configured origin)
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Range, Content-Type, X-Krakenhub-Token
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges
Accept-Ranges: bytes
```
`OPTIONS` must return `204` with those headers. A plain `<video src>` on a progressive file does not strictly require CORS, but `hls`/`dash` (MSE) absolutely do, and Range support is required for reliable seeking — so the spec mandates all of it uniformly.

### 6.3 Security posture

- **Bind `127.0.0.1` only.** Never `0.0.0.0`. The config UI rejects non-loopback resolver hosts.
- v1 ships **no auth** (any local page can call it — the honest framing is "the resolver is a machine-local capability granted to every site you visit"). Optional shared token via `?token=` / `X-Krakenhub-Token`, configured in the panel, is part of the frozen contract from day one.
- The companion **must** refuse `file://`, `data:`, and local filesystem paths in `url=`, and must not act as a general HTTP proxy: `/stream/<opaque>` serves only tokens it minted, with a TTL.
- Rate limit (e.g. 10 resolves/min) and cap concurrent yt-dlp processes at 2.
- Docs state plainly: installing the companion means any website you open can ask your machine to download videos. Ship it as opt-in, source-available, with the port configurable.

### 6.4 How the video module uses it (`resolver/resolverClient.ts`)

- `checkHealth()` — `AbortSignal.timeout(1200)`, memoized in memory + `sessionStorage['krakenhub:v1:resolver:health']`, re-checked every 60 s and on every fatal primary-adapter error.
- `resolve(url, opts)` — `AbortSignal.timeout(15000)`; on `202`, poll `/job/<id>` at `retryAfterMs` up to 60 s total.
- On success, mount `direct-file` (kind `progressive`/`file`), `hls`, or `dash` on `streamUrl`. `hasOwnChrome: false`, `canSetQuality: true` (re-resolve with a different `maxHeight`), full A-B loop with real pause and silent seeks — i.e. the **best** playback path in the whole app.
- On any failure (`/health` down, timeout, non-`ok` status), silently fall back to the geometry engine and emit `tele.resolver-fallback` with the reason. Users never see a hard error for a resolver miss.
- `maxHeight` request is derived from geometry: `maxHeight = clamp(ceil(max(displayW,displayH) * dpr * zoom * 1.25), 480, 2160)` → for 640/DPR1/zoom1 that's **800 → snapped up to 1080**. Never request 2160 for a 640 panel.

### 6.5 Future companion (out of v1 scope, interface frozen)

`krakenhub-resolver`: a small Go or Rust binary wrapping `yt-dlp`. `GET /resolve` shells out to `yt-dlp -J --no-playlist <url>`, picks the best progressive format ≤ `maxHeight` (or muxes with ffmpeg into a temp mp4 when only adaptive formats exist), and serves it from `/stream/<opaque>.mp4` with Range support and an LRU disk cache (default 4 GB). Ships as a signed release artifact + `winget`/`brew` recipe. It exists to give the *user* the ability to play *their own* copy on their own hardware; kraken-hub itself never bundles, hosts, or proxies extracted media, and the web app remains fully functional without it.

---

## 7. Input validation + error UX

### 7.1 Validation rules and exact messages (`routing/validate.ts`)

| code | severity | trigger | behavior + message |
|---|---|---|---|
| `mixed-content-http` | auto-fix | `http://` scheme, non-loopback | Silently rewrite to `https://` and probe. If the probe fails → `http-not-upgradable`. Panel shows: *"Upgraded to https:// — GitHub Pages is HTTPS-only and browsers block http:// media."* |
| `http-not-upgradable` | error | https rewrite failed | *"This link is http:// only. The Kraken display is served over HTTPS, so the browser will block it. Download the file and add it as a local clip instead."* |
| `unsupported-container` | error | `.mkv .mka .avi .flv .wmv .rmvb` | *".mkv can't be played — Chromium has no Matroska support in `<video>`, and no library fixes that. Remux to MP4: `ffmpeg -i in.mkv -c copy out.mp4`."* (message includes the copyable command) |
| `discord-expiring-url` | warn | `cdn.discordapp.com` / `media.discordapp.net` | *"Discord links are signed and expire in about 24 hours — this will stop working. Download the file and add it as a local clip."* Allowed, but the config UI marks the saved entry with a decay icon. |
| `imgur-unreliable` | warn | `i.imgur.com` | *"Imgur redirects hotlinked videos to its homepage; this often won't load."* |
| `reddit-comment-url` | error | `reddit.com/r/...` | *"Paste the `v.redd.it/…` link (open the video, copy the video link), not the comments page."* |
| `youtube-playlist-ignored` | warn | `&list=` | *"Playlists aren't supported in v1 — only this video will play."* |
| `local-clip-remote-context` | error | remote page sets `krakenhub-clip:` for an id the display lacks | See §5.1 |
| `url-too-long` | error | > 2048 chars | *"That link is unusually long and won't survive the sync channel."* |
| `mov-codec-risk` | warn | `.mov` | *"`.mov` files often contain ProRes or HEVC, which may not decode. MP4/H.264 is safest."* |
| `codec-unsupported` | error | feature-detect fails at mount | *"Your PC can't decode this file (HEVC needs GPU support Chromium won't emulate)."* |

Warnings never block. Errors block **saving from the config UI**, but on the display side an error always renders as a card (§7.4) rather than a blank screen.

### 7.2 Where validation runs

- **Config UI (CAM Configuration Browser)** and **remote page**: at input time, synchronously, with inline messages. This is where users can actually read and react.
- **Display page**: again at mount, because state can arrive from URL params or a retained MQTT snapshot written by an older/forked client. The display never trusts incoming state.

### 7.3 Unknown-URL fallback chain

Order is chosen so the **no-CORS-required** attempt goes first:
1. **`<video>` attempt** — attach the URL to a `<video preload="metadata">`, 6 s `loadedmetadata` timeout. Plain progressive playback needs no CORS, so this succeeds for the majority of real-world direct links. Success → mount `direct-file`.
2. **Range-probe sniff** — `fetch(url, {method:'GET', headers:{Range:'bytes=0-2047'}})` in a `try/catch` (a CORS rejection is *expected* and is not an error). If it returns:
   - `Content-Type` `application/vnd.apple.mpegurl` / `audio/mpegurl`, or the body starts with `#EXTM3U` → `hls`.
   - `Content-Type` `application/dash+xml`, or the body contains `<MPD` → `dash`.
   - `video/mp4` / `video/webm` → retry `direct-file` once with `crossorigin="anonymous"` cleared.
3. **Blind `hls` attempt** if the path contains `m3u`, **blind `dash` attempt** if it contains `mpd` or `manifest`.
4. **Proxy retry** — if a user-configured `proxyBase` exists, retry steps 1–3 through it. Ship the proxy field **empty**; document a deploy-your-own Cloudflare Worker and state explicitly that a plain passthrough proxy is **insufficient for HLS** (variant/segment URLs inside the manifest resolve to the origin host and re-fail CORS — the worker must rewrite playlist URLs). `allorigins.win` is offered as an optional preset, never a default; `corsproxy.io` is not offered (it 403s benign domains).
5. **Error card** `source-unplayable`, with the chain's per-step reasons in telemetry.

Each step is guarded by `AbortSignal`, and the whole chain is capped at 25 s so the display never sits on a spinner indefinitely.

### 7.4 On-LCD error card (`ui/ErrorCard.tsx`)

The display is **non-interactive** — no clicks, no keyboard, no scroll — so an error must be self-explanatory and must not depend on any action taken on the LCD.

Design rules:
- Flat, low-entropy background (`#141414`), no gradients, no blur, no animation beyond a 1 Hz pulse dot. Low entropy = compresses well = stays legible under CAM's Elite frame compression at low FPS.
- Constrained to the circular safe box (398×398 at 640). Title 30 px / 700, body 22 px / 400, monospace detail line 18 px. Max 3 lines of body.
- Content: category glyph, one-line human cause, the offending URL/provider middle-ellipsized to 40 chars, and a fixed footer line: **"Fix in CAM → Kraken → Configure"** plus the room code if the sync channel is active.
- Auto-retry with backoff `2s, 4s, 8s, 30s (cap)` for transient classes (`network`, `stall`, `autoplay-blocked`, `resolver-unreachable`), with a small `retry 3/∞` counter. **No retry** for deterministic classes (`unsupported-container`, `http-not-upgradable`, `clip-missing`, `codec-unsupported`).
- After 3 failed retries, if a previous source played successfully this session, fall back to it and show a corner badge instead of a full card ("last source failed — playing previous").

### 7.5 Telemetry (`telemetry/videoTelemetry.ts`)

Every error/warning goes to **three** places:
1. `localStorage['krakenhub:v1:video:lastError']` (single JSON object) and `krakenhub:v1:video:log` (ring buffer, last 20, capped at 32 KB). The Configuration Browser shares the origin, so it receives these **for free via the `storage` event with zero network** — this is the single most reliable diagnostic path and must never be skipped. Add a 1 s polling fallback in case the `storage` event is unreliable in the Electron webview.
2. The sync `tele` channel (MQTT/ntfy), throttled to 2 Hz, so the phone sees it.
3. `console.error` with a `[kraken-hub/video]` prefix for developers using CAM's devtools.

Telemetry payload:
```ts
{ ch:'tele', kind:'videoError', ts, code, severity, provider, urlHash, message,
  retryCount, display:{w,h,shape,targetFps}, achievedFps, quality:{height,label},
  geometry:{ N, crop, scale }, resolver:{ configured, healthy } }
```
`urlHash` = first 8 hex of SHA-256 — never put the raw URL on a public broker (payloads are AES-GCM encrypted anyway, but defense in depth).

Continuous (non-error) telemetry at 0.5 Hz: `achievedFps`, `quality`, `currentTime`, `bufferedEnd`, `held`, `loopCrossings`, `maskVisiblePct`. This is what makes the remote UI trustworthy.

---

## 8. FPS / compression reality

### 8.1 The advisory (`ui/FpsAdvisory.tsx`)

`targetFps` is a **user slider in CAM** (Lighting → Kraken → Web Integration → Frame Rate) that **defaults to 1**. A user who never touches it will see a slideshow and blame kraken-hub.

- Read `window.nzxt.v1.targetFps` at boot and **re-read every 2 s** (CAM may change it live without reloading the page).
- `targetFps <= 5` → render a full-card advisory for 20 s, then shrink to a persistent corner badge `1 FPS ⚠`. Card text: *"LCD frame rate is 1 FPS. In CAM: Lighting → Kraken → Web Integration → Frame Rate → drag to max (40 on Elite)."*
- The advisory clears itself automatically once `targetFps > 5` is observed. It is never dismissible from the LCD (non-interactive) but **is** dismissible from the config UI (`krakenhub:v1:video:fpsAdvisoryDismissed`).
- The same guidance appears in the config panel's first-run checklist and in `README.md` above the fold.

### 8.2 The compression truth

NZXT's own engineer: the Elite pipeline **compresses frames, so achieved FPS varies with frame content**, worst case being roughly pre-update performance. Full-bleed, high-entropy video is precisely the pathological input. So:
- **`targetFps` is a ceiling, not a promise.** Measure the real thing: rAF counter over a rolling 2 s window → `achievedFps`, published as telemetry and shown in the config UI next to the target.
- Document the content heuristics in `docs/fps-and-compression.md`: flat color areas, limited palettes, a static frame with a small moving region, no film grain, no dithering, no rapid full-frame cuts. A 30 fps 1080×1080 clip of a slow loop will hold higher effective FPS than a 60 fps action scene.
- The 640×640 resolution is **not** the bottleneck — the slider and the compressor are.

### 8.3 Performance mode

```ts
perf: 'auto' | 'quality' | 'performance'   // default 'auto'
```
`auto` promotes to `performance` when `targetFps <= 10` **or** `achievedFps < targetFps * 0.6` sustained for 10 s.

`performance` changes:
| lever | quality | performance |
|---|---|---|
| YouTube iframe floor `N` | 1920 | 1280 (crop 720, still 1.125× at 640) |
| YouTube geometry mode | `square` | `tight` (−25 % compositor surface) |
| zoom clamp | [1, 4] | [1, 1.5] |
| loop crossfade | allowed | disabled |
| rotor layer when `rotate === 0` | present | removed from DOM |
| poster mask | image | flat color |
| telemetry rate | 0.5 Hz | 0.2 Hz |
| preferred source fps | any | prefer 30 fps; local clips ingested above 30 fps get a "consider re-encoding to 30" hint |
| `<video>` surface layout | native size | capped so `max(w,h) <= 1280` |

### 8.4 Hardware verification list — do these FIRST

The whole geometry engine rests on four unverified assumptions. Ship a `#/probe` hash view (display-side, no navigation) that measures and prints all of them on the LCD **and** writes them to `krakenhub:v1:probe` so the config UI can read them:

1. **`window.devicePixelRatio`** in the Kraken Browser, plus whether `window.nzxt.v1.width` is CSS px or device px (compare against `document.documentElement.clientWidth`). All the crop math assumes DPR 1; DPR 2 doubles `S_needed`.
2. **Is a cross-origin `youtube-nocookie.com` iframe permitted at all** in the CAM webview, and does the IFrame API's postMessage handshake complete?
3. **Muted autoplay without a user gesture** — for `<iframe>`, for `<video src=blob:>`, and for `<video src=https:>` separately.
4. **Decode/composite headroom at 1920×1920** — measure `achievedFps` for: flat color, a local 1080×1080 30 fps clip, a local 1080p 60 fps clip, YouTube at N=1280, N=1920, N=2560. This single table decides the default `qualityFloorPx` and whether `tight` mode should be the default.
5. Secondary: `navigator.userAgent` / Chromium version; `MediaSource.isTypeSupported` for HEVC + AV1; whether audio reaches speakers; whether `localStorage`/IndexedDB survive a CAM restart and a CAM update; `navigator.storage.persist()` outcome; whether the `storage` event actually fires cross-window in this Electron build (if not, the 1 s poll becomes the primary path); `targetFps` reported by a Kraken Plus.

Until #1 and #4 return, `qualityFloorPx` defaults to **1920** and `geometryMode` to **`square`** — the configuration the research recommends and the one with the widest chrome margin.

---

## 9. Implementation sequencing (for executors)

1. `types.ts`, `render/fit.ts`, `youtube/geometry.ts`, `routing/patterns.ts`, `routing/validate.ts`, `loop/LoopEngine.ts` — **all pure, all unit-tested, zero DOM**. Land these first; they encode every number in this document.
2. `VideoAdapter.ts` + `HtmlVideoAdapterBase.ts` + `directFile.adapter.ts` + `HtmlVideoLoop.ts` + `RenderController.ts` — the first end-to-end path, testable in a plain browser with a public MP4.
3. `local/clipStore.ts` + `ingest.ts` + `blobUrlRegistry.ts` + `localFile.adapter.ts` + upload UX. This is the highest-quality playback path and the one that works without any third party.
4. `#/probe` view. Run it on hardware. Feed results back into defaults.
5. `youtube/*` + `youtubeEmbed.adapter.ts` + `PolledLoop.ts` — the flagship, but only after #4 confirms the iframe is even allowed.
6. `hls.adapter.ts`, `dash.adapter.ts` (both lazy `import()`), Reddit direct-probe ladder.
7. `twitch`, `vimeo`, `streamable` adapters.
8. `resolver/*` + `resolver.adapter.ts` (interface + client only; companion is a fast-follow).
9. `ErrorCard`, `FpsAdvisory`, `videoTelemetry`, docs.

**Cross-module contracts this module depends on (owned elsewhere, must match):** `DisplayInfo` from the NZXT bootstrap (`{width,height,shape,targetFps,dpr}` via property-assignment + retry, never `window.nzxt` reassignment); the settings store's atomic single-JSON-key write + `storage` event + 1 s poll fallback; the sync layer's `state`/`cmd`/`tele` channels; `safeArea.ts` shared with Clock/Stats.

---

### Critical Files for Implementation
- /Users/ubberkid/kraken-hub/src/modules/video/youtube/geometry.ts
- /Users/ubberkid/kraken-hub/src/modules/video/adapters/VideoAdapter.ts
- /Users/ubberkid/kraken-hub/src/modules/video/render/RenderController.ts
- /Users/ubberkid/kraken-hub/src/modules/video/routing/patterns.ts
- /Users/ubberkid/kraken-hub/src/modules/video/local/clipStore.ts