## PART 1 — Ring light / RGB control from a Web Integration

### Verdict: **NO — definitively impossible via the official contract.** (confidence: very high)

**The entire injected surface** (`v1/index.d.ts`, current `main`, verbatim):

```ts
window.nzxt?.v1?: {
  onMonitoringDataUpdate?: (data: MonitoringData) => void;  // read-only, 1 Hz
  width: number; height: number; shape: "circle"|"square"; targetFps: number;
}
```

Four read-only display descriptors plus one inbound callback. There is **no setter, no method, no event, no second namespace** — nothing writable at all, for lighting or anything else. Source: https://github.com/NZXTCorp/web-integrations-types/blob/main/v1/index.d.ts (repo tree contains only `v1/index.d.ts`; there is no v2).

Corroborating evidence:
- **Docs** (https://developer.nzxt.com/docs/development/, /docs/about/, /docs/faq/): describe only rendering + monitoring + the two-browser (Kraken Browser `?kraken=1` / Configuration Browser) localStorage/cookie channel + the `nzxt-cam://action/load-web-integration?url=…` deep link. Zero mention of RGB/LED/lighting/fan/pump control. The deep-link protocol's only documented action is loading an integration URL. (confidence: high)
- **Issue archaeology** — I enumerated *all* issues in both repos (state=all): `web-integrations-types` #5,6,8,9,10; `web-integrations-docs` #8,9,13,14,18,19. **Not one is about lighting/RGB/LED/ring.** The only feature asks are framerate (#8, answered: "framerate is locked to 1 fps… Monitoring updates will stay 1fps") and PSU monitoring data (#6, closed). (confidence: very high)
- **Maintainer statement, Aug 2026** — `johnnyliao-nzxt` on docs #18/#19: *"Yes, this repo is still maintained and window.nzxt.v1 keeps working as-is"* — i.e. explicit "as-is", no expansion. API has not grown since 2024. (confidence: high)
- **Community code search**: GitHub code search for `"window.nzxt.v1"` returns 43 files across ~15 projects (nzxt-esc, kraken-orb, kraken-dash, KrakenLyrics, Starfield/NieR/EICAS faces, hypercolor's research, and kraken-hub itself). **Zero** of them touch lighting through the page; the most advanced (NZXT-ESC) explicitly does display-only. No one has found an undocumented lighting hook. (confidence: high)

Terminology trap worth knowing: CAM's UI files the LCD under the **Lighting** tab and the docs literally say *"when the Web Integration **lighting mode** is enabled"*. That is UI taxonomy (the LCD is treated as a lighting zone), **not** API access to LEDs. Don't let it mislead a reader of the docs.

### Is there any other local channel? (confidence: high)
- **No documented CAM local HTTP/WebSocket API.** CAM exposes exactly two third-party surfaces: the injected `window.nzxt.v1` object and the `nzxt-cam://` / `nzxt-cam-beta://` URL protocol. `cam_helper.exe` is an internal stability subprocess, not an API.
- **Localhost companion → browser is fine, and precedented**: NZXT-ESC ships `NowPlaying.WebSocket`, a Windows companion the Kraken Browser reaches over a local WebSocket (Chromium treats `localhost` as a secure origin, so an HTTPS-hosted face can talk to `ws://localhost`). That's the pattern kraken-hub should reuse — but it only moves *data in*, it does not create a lighting path by itself. https://github.com/mrgogo7/nzxt-esc

### Best available indirect path: companion → USB HID → ring LEDs

The Kraken Elite ring **is** driveable — the protocol is reverse-engineered and shipping in real code.

| Route | Status | Notes |
|---|---|---|
| **liquidctl (stable)** | ❌ ring unsupported | Docs, verbatim: *"the Elite variant, which also features a light ring on the pump housing. **Controlling the light ring is not yet supported**"* — stated for both Kraken 2023 Elite and 2024 Elite RGB. https://github.com/liquidctl/liquidctl/blob/main/docs/kraken-x3-z3-guide.md (confidence: very high) |
| **liquidctl PR #882** | 🟡 open, HW-tested | "feat: add RGB ring support for Kraken 2024 Elite (0x3012)", opened 2026-04-05, last touched 2026-07-22, still OPEN. Adds `KRAKEN_2024_ELITE_RING (0x1E)`, ring on external channel cid=1, 24 LEDs, `fixed`→`super-fixed` redirect onto Hue2-direct 0x22. Author reports fixed/super-fixed/breathing/fading/pulse/spectrum-wave/rainbow-flow/marquee/candle/off **all working** on fw 1.2.0, with LCD + pump/fan untouched. Closes issue #800. (confidence: high that it works on the author's HW) |
| **OpenKraken** (davidboulay) | ✅ works today | Python/PyQt6, **Linux only**, Kraken 2024 Elite RGB `1e71:3012`. Speaks HUE2 "Direct" itself: `0x22 0x10` (LEDs 0–59), `0x22 0x11` (>20 LEDs), apply `0x22 0xA0` byte7 `0x28`(OpenRGB)/`0x08`(liquidctl); query info via `0x20 0x03`→`0x21 0x03`; RGB→GRB; 64-byte reports. Covers 24-LED pump ring + RGB Core fan chain. Full byte layouts in its `PROTOCOL.md`/`INTERFACES-LIGHTING.md`. https://github.com/davidboulay/OpenKraken (confidence: high) |
| **OpenRGB** | 🟡 partial/broken | Detects Kraken 2024 Elite but users report stuck in Direct mode, brightness/speed sliders greyed, "Saving Not Supported" (GitLab #4985; also #4828, #5222). (confidence: medium) |
| **SignalRGB** | ❌ | Open feature request as of 2025-09-06: cannot control the Elite ring while the LCD is in use; *"Workarounds don't work."* https://forum.signalrgb.com/t/…/8720 (confidence: high) |

**Hard caveats for a kraken-hub companion (all high confidence unless noted):**
1. **CAM conflict is real and documented.** liquidctl: *"Monitoring and/or configuring the coolers is not possible with CAM running, otherwise you'll get errors such as `OSError('read error')`."* HWiNFO forums: CAM opens the cooler **exclusive** and blocks other readers; the community workaround tool exists precisely because of this. Kraken-hub's whole premise requires **CAM running** (it's what renders the web integration) — so the companion would be fighting the one process that must stay alive. This is the central risk, not a footnote.
2. **Reply-stealing**, even when a handle *can* be opened: OpenKraken documents that a second process reading the same node consumes request replies → `AssertionError: missing messages`. Expect the inverse too — your writes may desync CAM's own state machine.
3. **Firmware rejects hardware animation modes** (per OpenKraken) → effects must be **host-streamed at ~4 fps** (clamped 0.5–5), brightness applied host-side (no device brightness command), colors **reset on AC power cycle**, effects **stop when your process exits**. Note this **contradicts** liquidctl PR #882's claim that hardware breathing/spectrum-wave work — likely firmware-version dependent (PR tested fw 1.2.0; CAM 4.76.1 shipped a "Kraken Elite V2 abnormal LED flickering" firmware fix). Resolve empirically before promising anything. (confidence: medium on the contradiction's cause)
4. **No Windows precedent exists.** Every working ring implementation is Linux (`hidraw` + libusb). A Node port = `node-hid` + these packets; Windows HID is usually shareable (the NZXT-Kraken-Sensor-Unlocker holds a concurrent handle to defeat CAM's sensor lock), so it *may* co-exist — but CAM will keep re-asserting its own lighting profile, so expect flicker/tug-of-war. **Effort: ~2–5 days for a proof of concept** (node-hid, enumerate `1e71:3012`/`3014`, port ~200 lines of packet logic, 4 fps writer loop, kill-switch); **productionizing it safely: much more**, and it's per-model, per-firmware fragile.
5. **NZXT explicitly disclaims it**: *"not officially compatible with any third-party RGB or fan/pump control software and is only validated for use with NZXT CAM."* (support article 39793638025883)

**The zero-risk lighting story you already have:** the Kraken Elite (2024/V2) has a **"RGB Ring Sync"** display mode where the ring samples the on-screen content and matches its colors. If that sampling applies to Web Integration content (not just image/GIF modes), then **kraken-hub controls the ring implicitly by choosing what it paints** — a "ring-aware palette" feature costing zero native code. NZXT's support table lists RGB Ring Sync as a *display mode* alongside Web Integration (which would imply mutual exclusivity), while reviews describe it as the ring "syncing with on-screen content." **This is the single highest-value open question** — recommend a 5-minute user test: set mode to Web Integration on a 2024 Elite and check whether the ring tracks the rendered face. (confidence: low/unresolved — sources conflict)

---

## PART 2 — CAM Kraken Elite LCD feature parity

Authoritative mode matrix, NZXT support article 47990298264475 (verbatim table; `support.nzxt.com` blocks WebFetch — retrieved via the Zendesk API endpoint `https://support.nzxt.com/api/v2/help_center/en-us/articles/<id>.json`, useful trick for the parent):

| Model | Screen | Display modes |
|---|---|---|
| **Kraken Elite (2024)** | 2.72" circular LCD + RGB Ring, 640×640@60 | Infographic + Image/GIF (**single, dual, triple**) · Infographic (single, dual, triple) · Image/GIF · Clockface · **Audio Visualizer** · Web Integration · **RGB Ring Sync** |
| Kraken Elite (2023) | 2.36" circular, 640×640@60 | same minus RGB Ring Sync |
| Kraken Plus (2025) | 1.54" square, 240×240@30 | Infographic + Image (single only) · Infographic (single, dual) · Image/GIF · Clockface · Web Integration |
| Kraken (2023) | 1.54" square, 240×240 | same as Plus |
| Kraken Z (Z53/63/73) | 2.36" circular, 320×320 | Infographic (single/dual/triple) · Image/GIF · Clockface · Web Integration |

### Parity table — CAM feature → exists? → options/notes

| CAM feature | In CAM? | Options / limits | Conf. |
|---|---|---|---|
| Single Infographic | ✅ | One live metric; font color + background color pickers | high |
| Dual Infographic | ✅ | Two metrics simultaneously (Elite/Z/Plus) | high |
| **Triple** Infographic | ✅ Elite/Z only | Not on Plus/Kraken 2023 | high |
| **Infographic + Image/GIF** (= **stats over GIF**) | ✅ | Metric(s) composited over a still or animated GIF backdrop. Elite: single/dual/triple; Plus: single only. **CAM *does* overlay stats on GIFs — the "stats over media" gap is video-only, not GIF** | high |
| **Stats over MP4/WebM video** | ❌ | CAM accepts PNG/JPG/GIF only; no video container, no YouTube-as-background. **This is the real differentiator** | high |
| Metrics available on-device | ✅ limited | CPU temp / load / clock, GPU temp / load / clock, **liquid temp**. Older CAM listed these as standalone modes (CPU Temp, Liquid Temp, GPU Temp, CPU Load, GPU Load, CPU Clock, GPU Clock) | high |
| RAM usage as an LCD stat | ❌ stock | Not in the infographic picker — **but exposed to web integrations** (`Ram.totalSize/inUse/modules[]`), and community faces (Starfield Compass, NieR HUD) show it | med-high |
| Fan / pump RPM as an LCD stat | ❌ stock | Not a stock infographic option; **web API gives `Cpu.fanSpeed`/`Gpu.fanSpeed`** (note: no *pump* RPM and no Kraken fan RPM in the API — `Kraken` has only `liquidTemperature`) | med-high |
| Power draw (W) as LCD stat | ❌ stock | Web API has `Cpu.power/tdp`, `Gpu.power` | high |
| Network / storage / disk stats | ❌ | CAM shows these in its desktop dashboard/overlay, **not on the LCD**, and **not** in `MonitoringData` | high |
| **FPS on the LCD** | ❌ | FPS exists only in CAM's in-game OSD overlay; no FPS in the web API and no LCD mode. Any FPS face needs our own companion (RTSS/PresentMon) | med-high |
| Clockface | ✅ | Radial **or** 4-digit; 12/24-hour | high |
| Custom text / arbitrary strings | ❌ | No text mode at all in stock CAM | high |
| Image / GIF upload | ✅ | PNG/JPG/GIF; **~25 MB** upload cap (reviews) / ~24 MB encoded GIF firmware cap (OpenKraken); CAM auto-resizes per model; square screens crop circular-authored art | med-high |
| **GIPHY / Tenor in-app search** | ✅ | GIPHY search added Nov 2023; Kraken Plus article cites a Tenor-powered browser. Lowest-friction personalization CAM ships | high |
| Carousel / slideshow | ✅ | Rotates **up to 5** configured faces at a user-set interval. **The only composition primitive in CAM** | high |
| Transitions between faces | ❌ | No documented crossfade/transition options — hard cut | med |
| Rotation / orientation | ✅ | 0/90/180/270° in software (support article "How do I rotate the screen on my Kraken cooler?") | high |
| Brightness control | ✅ | Available in CAM; firmware has **no true off** (0% brightness is the "off") | med-high |
| Audio Visualizer | ✅ Elite only | Built-in; not on Plus / Kraken 2023 / Z | high |
| Web Integration | ✅ | Preset cards + Custom URL; `nzxt-cam://action/load-web-integration?url=…` one-click install; official presets = **Spotify Now Playing, Google Photos Slideshow, Unsplash Slideshow, YouTube Embed** (still just those four since 2023) + a curated community list in `NZXTCorp/web-integrations-examples/community.md` (Shadertoy, Dual Info, Starfield, Starfield Compass, NieR Automata HUD, Aviation EICAS, Home Assistant, Kraken Elite Custom Faces…) | high |
| Web-integration data rate | ⚠️ | **1 Hz monitoring, hard-locked**; NZXT: *"currently the framerate is locked to 1 fps… Monitoring updates will stay 1fps"* (docs #8). Faces must tween | high |
| Now Playing / media session | 🟡 | Only via the Spotify preset with the user's own OAuth — **CAM does not proxy OS media-session data**. Community solves with a local WS companion | high |
| **RGB Ring Sync** | ✅ Elite 2024 only | Ring samples displayed content and matches its colors; also the LCD-linked lighting story. Interaction with Web Integration content = unverified (see Part 1) | med |
| Lighting profiles / effects | ✅ (CAM, not LCD) | Separate Lighting panel; unreachable from a web page | high |
| Free element positioning / layering | ❌ | Fixed templates only | high |
| Element scale / rotate / opacity | ❌ | — | high |
| Custom fonts | ❌ | Font **color** only, no font choice | med |
| Layout editor / WYSIWYG | ❌ | Community built NZXT-ESC inside a web integration precisely to fill this | high |
| Local-file assets for web faces | ❌ | No local-file API; faces must self-host in IndexedDB (NZXT-ESC does this) | high |
| Temp-conditional / profile-switching faces | ❌ | Carousel is time-based only | med |
| Runs without CAM | ❌ | Support article: without CAM you lose custom cooling curves, RGB effects, **and custom display modes**; firmware falls back to a static liquid-temp face | high |
| Linux / macOS | ❌ | Windows-only; NZXT disclaims third-party control software | high |

**CAM 2025–2026 trajectory** (confidence: high): 4.75.4/4.75.5 (fall 2025) Kraken Elite firmware wave — coolant-temp precision on Elite 420, sleep/wake display fixes, **LED-ring blinking during heavy GIFs fixed**, CPU-temp source consistency between CAM and LCD; 4.75.6 (2025-11-10) fan-channel interference; 4.76.0/4.76.1 (2026-02-24/27) cam_helper crash + lighting-profile-loss fixes + Kraken Elite V2 LED-flicker firmware; **4.76.3 (2026-04-06, latest)** Function Elite / Relay Headset firmware-stuck fixes. **No new display modes and no Web Integration API expansion in 18+ months** — the platform is in maintenance mode. Good news for a differentiator; also means don't expect a lighting API to appear.

### Competitive reality check for the "stats over video" differentiator
**NZXT-ESC (mrgogo7) already ships it** — layer-based editor as a web integration: up to 20 presets / 40 elements, per-element position/rotate/scale/opacity, **MP4/WebM/GIF/PNG/JPG + YouTube + Pinterest backgrounds**, sensor overlays (CPU/GPU temp, load, freq, power, fan speed, RAM, liquid), clocks/dates/text/shapes/icons, audio visualizer + Now Playing via a local WebSocket companion, IndexedDB media persistence, `nzxt-cam://` install. Same author filed the "is this repo maintained" issues NZXT answered in Aug 2026. **Parity with CAM is table stakes; the real bar is NZXT-ESC.** Differentiate on what it lacks: real-time (>1 Hz) interpolated metrics, curated/designed faces rather than a blank canvas, FPS/game data via companion, multi-source data (Home Assistant, Spotify without user OAuth friction), and reliability under CAM's 1 Hz + sleep/wake quirks.

Also relevant: **hyperb1iss/hypercolor** published `docs/research/faces/nzxt-cam.md` (2026-06-09) — an independent competitive analysis of this exact ecosystem that corroborates every finding above; worth mining. https://github.com/hyperb1iss/hypercolor/blob/main/docs/research/faces/nzxt-cam.md

Note: `/Users/ubberkid/kraken-hub/docs/design/research/research-nzxtPlatform.md` (26 KB, dated Aug 30) already exists in-repo — worth diffing against this report for staleness, particularly the CAM 4.76.3 timeline and the ring-control conclusion.

**Sources:**
- [web-integrations-types v1/index.d.ts](https://github.com/NZXTCorp/web-integrations-types/blob/main/v1/index.d.ts) · [types issues](https://github.com/NZXTCorp/web-integrations-types/issues) · [docs issues](https://github.com/NZXTCorp/web-integrations-docs/issues)
- [developer.nzxt.com /docs/development](https://developer.nzxt.com/docs/development/) · [/docs/about](https://developer.nzxt.com/docs/about/) · [/docs/faq](https://developer.nzxt.com/docs/faq/)
- [web-integrations-examples + community.md](https://github.com/NZXTCorp/web-integrations-examples)
- [NZXT: display modes by Kraken model](https://support.nzxt.com/hc/en-us/articles/47990298264475-What-display-modes-are-available-for-my-Kraken-cooler) · [Kraken Plus modes](https://support.nzxt.com/hc/en-us/articles/39717097276827-What-display-modes-are-available-on-the-Kraken-Plus) · [Do I need CAM running](https://support.nzxt.com/hc/en-us/articles/48178636759579) · [third-party RGB software](https://support.nzxt.com/hc/en-us/articles/39793638025883) · [CAM 4.76.1](https://support.nzxt.com/hc/en-us/articles/47188373673371-NZXT-CAM-4-76-1-Release-Notes) · [CAM 4.76.3](https://support.nzxt.com/hc/en-us/articles/48821709985819-NZXT-CAM-4-76-3-Release-Notes) · [CAM update notes index](https://support.nzxt.com/hc/en-us/sections/40544778490139-CAM-Update-Notes)
- [liquidctl kraken-x3-z3 guide](https://github.com/liquidctl/liquidctl/blob/main/docs/kraken-x3-z3-guide.md) · [PR #882](https://github.com/liquidctl/liquidctl/pull/882) · [issue #800](https://github.com/liquidctl/liquidctl/issues/800)
- [OpenKraken](https://github.com/davidboulay/OpenKraken) (README FAQ + INTERFACES-LIGHTING.md + PROTOCOL.md)
- [OpenRGB #4985](https://gitlab.com/CalcProgrammer1/OpenRGB/-/issues/4985) · [#5222](https://gitlab.com/CalcProgrammer1/OpenRGB/-/issues/5222) · [SignalRGB request](https://forum.signalrgb.com/t/support-and-or-workaround-to-allow-rgb-control-of-nzxt-kraken-elite-with-lcd-screen/8720) · [HWiNFO CAM exclusive access](https://www.hwinfo.com/forum/threads/nzxt-kraken-hwinfo-nzxt-cam-finally-defeated.8009/)
- [NZXT-ESC](https://github.com/mrgogo7/nzxt-esc) · [hypercolor CAM research](https://github.com/hyperb1iss/hypercolor/blob/main/docs/research/faces/nzxt-cam.md) · [ocinside Kraken Z73 CAM](https://www.ocinside.de/review/nzxt_kraken_z73/5/) · [OC3D Kraken CAM update](https://overclock3d.net/reviews/cases_cooling/nzxt-improves-their-kraken-cpu-coolers-with-cam-and-firmware-updates/)