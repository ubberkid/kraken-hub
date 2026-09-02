# Hardware checklist (H01–H33)

kraken-hub is built from NZXT's public documentation and three rounds of live
protocol probing. Every claim in these docs that rests on documentation rather
than measurement carries the marker `⚠ not verified on hardware` and a link to an
**H-id** on this page.

This is that page. Each H-id is one unknown, with the steps that close it and the
fields to record. **Closing an H-id means sweeping the docs for its marker.**

As of 2026-08-31 the first hardware report has landed: a maintainer's **Kraken
Elite on CAM 4.76.5**, against app 0.1.0 (`2f556b4`). It closes the automatic
identity, timing, storage-delivery and capability rows — **H01, H02, H03, H12,
H14, H17, H18** — and they are written up under
[Known results](#known-results). Everything else on this page is still open, and
one device is one device: a different CAM build, a different GPU or a different
Kraken model can and will differ, especially for hardware-decoded codecs
(**H17**) and `devicePixelRatio` (**H02**).

If you own a Kraken — especially a **Kraken Plus** or a **Kraken Z**, where the
tables below are almost entirely empty — walking even part of this list is the
single highest-value contribution to the project. File the result as a
[hardware report](https://github.com/ubberkid/kraken-hub/issues/new?template=hardware_report.yml).

---

## The mechanic: getting text off a screen you cannot select

An LCD has no keyboard, no scrollbar and no clipboard. So the display page
**writes** its measurements to `localStorage`, and the configuration page
**reads** them back:

```
CAM ─┬─ Kraken Browser (hidden, ?kraken=1&diag=1) ── writes ─┐
     │                                                        │ kraken-hub:v1:diag:display
     └─ Configuration Browser (#/about) ────────── reads ─────┘  → "Copy report"
```

CAM's two browsers share one storage partition, which is what makes this work.
Your ordinary Chrome and your phone do **not** share it — opening `#/diag` in a
normal browser tab shows that browser's own probes and no display report.

**The same-machine loop:**

1. In CAM, point the Web Integration at your kraken-hub URL.
2. Open the display's diagnostics: append `?kraken=1&diag=1` — or use the
   **Open display diagnostics** button under _Report → Show the technical
   detail_. Leave it open; it republishes every 5 s.
3. Open **Configure** in CAM, then the version line in the footer (`#/about`;
   `#/diag` still resolves there).
4. Press **Copy report** and paste it into the hardware report. It carries this
   browser's probes and the display's, whichever exist.

### From another machine

The loop above assumes CAM and your editor are on the **same computer**. Very
often they are not: CAM runs on the Windows PC with the Kraken in it, and you
are on a laptop. `localStorage` is not shared across machines, so none of the
steps above can reach the report at all.

Pair a room once, and then pull it over the network instead:

1. **On the PC, once.** Open kraken-hub's configuration page → **Remote** →
   **Create a code**. Nothing else on the PC ever needs touching again.
2. **On any other browser** — laptop, phone, whatever — open the same site,
   go to **Remote**, open **Type a code instead**, and use **Room code → Join**. Wait for the
   status chip to say `online`.
3. Open the version line in the footer → **Report → Show the technical detail →
   Ask your Kraken**. It probes itself for about five seconds and sends the
   report back over the paired room, encrypted.
4. Press **Copy report** and paste it into the hardware report, exactly as with
   the same-machine route. **Send it in** goes straight to the issue form.

```
Windows PC                                  your laptop / phone
──────────                                  ───────────────────
CAM ── Kraken Browser (?kraken=1) ──── requestDiag ◄── About → Report
                       │
                       └── DiagReport (tele, chunked, AES-GCM) ──► "Copy report"
```

The display does **not** need to have been opened with `?diag=1` — which matters,
because you cannot edit the URL of a hidden Kraken Browser window from another
computer. Any normally-booted display in the room answers.

Two caveats worth knowing before you file a bug about it:

- The report is a **quick** probe set, budgeted at ~5 s. It carries everything
  the same-machine report does except the measurements that genuinely need a
  minute of watching — the CAM monitoring-feed interval (**H04**) among them.
  For those, use the same-machine loop above.
- **CAM caches the integration.** A display that has been running since before
  this feature was deployed has no `requestDiag` handler and will ignore the
  request in silence. Restart CAM, or reload the Web Integration, and try again.

The same-machine flow above remains the alternative, and is still the right one
when both windows are on one computer.

---

For the pattern tests you also need a **phone that records 60 fps video** and a
steady hand. Record the LCD, then count distinct values of the on-screen counter
per second of footage. That is the only way to measure what CAM actually
_captures_, as opposed to what the page renders.

---

## Before you start: the frame-rate slider

**CAM → Lighting → your Kraken → Web Integration → Frame Rate.**

It defaults to **1 FPS**. Every timing number below is meaningless without
recording where this slider was, and half of all "kraken-hub looks like a
slideshow" reports are this slider. Record the value on every measurement.

---

## The checklist

Status column:

- **auto** — the probe runs today; the number is already in the JSON.
- **manual** — you have to look at the panel, or restart something.
- **M4** — the measurement surface is specified but not built yet; do the
  manual version and say so.

### Identity and geometry

| ID      | Unknown                        | How to measure                                                                                                                | Record                                                                                                         | Status                                                                         |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **H01** | Device identity                | Automatic. `device.nzxtRaw` is exactly what CAM injected, verbatim, with no defaulting applied.                               | `width`, `height`, `shape`, `targetFps`, plus your CAM version and model name (type them into the report form) | auto — ✅ confirmed on CAM 4.76.5 (Elite; [known results](#known-results))     |
| **H02** | `devicePixelRatio`             | Automatic. The geometry math assumes **1**; if it is not 1 on your device, the crop constants need a second look.             | `device.dpr`, `device.screen.{width,height,innerWidth,innerHeight}`                                            | auto — ✅ confirmed on CAM 4.76.5 (one Elite; [known results](#known-results)) |
| **H03** | `window.nzxt` injection timing | Automatic. Timed from `performance.timeOrigin` to the first successful read, counting retries of the 200 ms × 10 ladder.      | `injection.firstSeenMs`, `injection.attempts`, `injection.reinjections`, `injection.present`                   | auto — ✅ confirmed on CAM 4.76.5 (Elite; [known results](#known-results))     |
| **H22** | Kraken Plus specifics          | H01 + H02 on a Kraken Plus, plus one straight-on photo of the panel. This is the one genuinely blank row in the README table. | everything from H01/H02, and whether the shape is really `circle`                                              | auto                                                                           |

### The monitoring feed

| ID      | Unknown          | How to measure                                                                                                                                                                                          | Record                                                                                                       | Status |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| **H04** | Feed reliability | Leave the display open for 60 s with the Stats module active. Today the interval histogram is **not** captured automatically (`timings.monitoringIntervalMs` is `null`); report by observation instead. | Does it tick at ~1 Hz? Any stalls? Which fields are ever `undefined`? Is `kraken.liquidTemperature` present? | M4     |

There is **no pump RPM field**. If you see one, that is the single most
interesting thing you could report.

### Playback and media

| ID      | Unknown                     | How to measure                                                                                                                                                                                                                                                                  | Record                                                                                  | Status                                                                                                                                                     |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H05** | Cross-origin iframe allowed | Set the video module's source to any YouTube URL and open the display. If the picture appears, the CAM webview permits a third-party iframe and the IFrame API reached `onReady`. **Then photograph the panel** and confirm no player chrome is visible anywhere in the circle. | works / blank / error card; chrome visible anywhere? how long until first frame?        | manual                                                                                                                                                     |
| **H06** | Muted autoplay              | Automatic in effect: if the bundled demo clip plays on a cold boot with no state, muted autoplay works.                                                                                                                                                                         | plays / does not play, and the error card text if not                                   | manual                                                                                                                                                     |
| **H07** | Unmuted autoplay            | Turn **Audio** on in the video module and reload the display.                                                                                                                                                                                                                   | plays / `NotAllowedError` / plays but silent                                            | manual                                                                                                                                                     |
| **H08** | Audio routing               | With audio on and a clip with sound, listen. The webview's output device is unknown to us.                                                                                                                                                                                      | audible from the PC's speakers? which output device? does CAM have its own mixer entry? | manual                                                                                                                                                     |
| **H17** | Codec support               | Automatic. `canPlayType` **and** `MediaSource.isTypeSupported` for H.264, HEVC, AV1, VP9, VP8, AAC, Opus, FLAC.                                                                                                                                                                 | the whole `capabilities.codecs` matrix                                                  | auto — ✅ confirmed on CAM 4.76.5 (Elite; [known results](#known-results)). HEVC and AV1 are **GPU-dependent** — still worth reporting from other machines |
| **H18** | API surface                 | Automatic. Chromium version, Electron version, WebGL/WebGPU/WebCodecs/`crypto.subtle`/`navigator.storage`/EventSource/BroadcastChannel, `hardwareConcurrency`, `deviceMemory`.                                                                                                  | `capabilities.userAgent`, `capabilities.chromiumVersion`, `capabilities.features`       | auto — ✅ confirmed on CAM 4.76.5 (Elite; [known results](#known-results))                                                                                 |

`capabilities.chromiumVersion` is the number the build target
(`chrome108` in `vite.config.ts`) is guessing at. It is worth reporting on its
own. One report is in: CAM 4.76.5 runs **Electron 32.1.0 / Chromium 128**, so
`chrome108` is conservative rather than wrong. It stays where it is until more
than one CAM build has been seen — an older CAM on an older machine is exactly
the case the conservative target exists for.

### Frame rate — the measurements that matter most

The Elite **compresses every captured frame**, so busy pixels cost achieved FPS.
That is the other half of "video looks bad on the LCD", and H09/H10/H11 exist to
put numbers on it.

**Protocol for all three:** set the CAM frame-rate slider to its maximum, open
the pattern, record 5 s of the LCD on a phone at 60 fps, then count **distinct
counter values per second** in the footage. Report the slider value alongside.

| ID      | Unknown                         | How to measure                                                                                                                                                                                                                       | Record                                                                      | Status                                                                     |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **H09** | Achieved FPS — flat content     | `?kraken=1&diag=1&pattern=flat` — a near-static frame whose only moving element is a large counter incremented once per `rAF`. The pattern owns the stage: no module is mounted underneath it, so nothing else is on the frame path. | `capture_fps_flat`, plus `targetFps`                                        | auto                                                                       |
| **H10** | Achieved FPS — full-bleed video | Play the bundled demo clip full-screen (`?kraken=1&demo=1`) and record. The dedicated `&pattern=video` overlay with the counter is not built yet.                                                                                    | `capture_fps_video` — expected well below H09                               | M4                                                                         |
| **H11** | Achieved FPS — YouTube engine   | Same, with a YouTube URL configured. `&pattern=youtube` is likewise not built yet.                                                                                                                                                   | `capture_fps_youtube`                                                       | M4                                                                         |
| **H12** | In-page render FPS              | Automatic — a 3 s `rAF` sampler. This separates "the page is slow" from "CAM captures slowly", and they are very different bugs.                                                                                                     | `timings.rafFps` (p50/p95/max), `timings.achievedFps`, `timings.longFrames` | auto — ✅ confirmed on CAM 4.76.5 (Elite; [known results](#known-results)) |

If H12 is high and H09 is low, the bottleneck is CAM's capture and compression
pipeline, and no amount of optimising kraken-hub will help. If both are low, it
is us.

### Layers — what a stack of layers costs (H24–H28)

The layers design (`docs/design/design-layers-architecture.md`) composes a look
out of up to eight stacked layers, one absolutely-positioned host `div` each,
and it makes two performance promises: **per-layer JS is negligible** and **the
page still renders at the slider value**. The W0 spike exists to put numbers on
both, and to ask the one question no code inside the page can answer on its own
— whether CAM's compressor, when the picture gets busy, shows up as reduced
in-page `achievedFps` (H28). If it does, the governor can see trouble coming and
throttle; if it does not, the declared per-layer cost is the ONLY capture-side
lever the app has, and every cost number the UI shows is an **estimate** and
must say so.

**Protocol for all five stacks:** open
`?kraken=1&diag=1&pattern=stack&stack=<a|b|c|d|e>` on the LCD with the CAM frame
rate slider at maximum. Each stack draws the H09 counter on top, so the H09/H10
filming protocol applies unchanged: record 5 s at 60 fps, count distinct counter
values per second. Add `&debug=1`
to read the per-layer line for each layer, or open `#/diag` in CAM's browser.

The stacks: **a** video + stats strip · **b** video + stats + clock + text ·
**c** plasma-like base + stats · **d** plasma-like + 4 overlays at `a:0.8` ·
**e** eight layers.

| ID      | Unknown                                                    | How to measure                                                                                                                                                                                      | Record                                                                                       | Status                                                                             |
| ------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **H24** | Per-layer `frame()` cost on real hardware                  | Run each stack; read the per-layer `p95` / `ema` lines in the debug overlay after ~15 s.                                                                                                            | `p95Ms` and `emaMs` per layer, per stack — the numbers G1's 4 ms trip point is calibrated on | simulator ✅ ([w0-measurements](design/w0-measurements.md)); **CAM hardware open** |
| **H25** | Whole-page cost of a deep stack                            | Same run: read `achieved` and `long frames` at stack **a** and at stack **e**.                                                                                                                      | `achievedFps` and `longFrames` per stack; the a→e delta is the answer                        | simulator ✅ (no delta, 0 long frames); **CAM hardware open**                      |
| **H26** | Cost of a translucent overlay (its own compositor surface) | Compare stack **d** (4 overlays at `a:0.8`, 4 extra surfaces) with stack **e** (8 layers, 1 translucent).                                                                                           | `achievedFps` for **d** vs **e**, and the counter FPS for both                               | simulator ✅ (no page-side delta); **CAM hardware open**                           |
| **H27** | Capture FPS per stack                                      | Film the counter for each stack (H09 protocol) — this is the only measurement of what the panel actually shows.                                                                                     | `capture_fps_stack_a` … `capture_fps_stack_e`, plus the slider value                         | manual — **open**                                                                  |
| **H28** | **Does compressor load reduce page `achievedFps`?**        | Read `achievedFps` in the page (debug overlay / `#/diag`) while filming the counter, for the cheapest stack (**c**, low-entropy gradient) and the most expensive (**e**). Compare page vs captured. | Answer below, in words                                                                       | manual — **open, and it decides the governor's design**                            |

**H28 — the answer** (fill this in; leave it empty rather than guessing):

> _Page `achievedFps` at stack c: ……… · captured FPS at stack c: ………_
>
> _Page `achievedFps` at stack e: ……… · captured FPS at stack e: ………_
>
> _Does the page's own `achievedFps` fall when the captured FPS falls?_
> **……… (yes / no / partly — and by how much)**

If **yes**, the page can see compressor overload and `layerGovernor`'s G2/G3
tiers are a real defence. If **no**, nothing inside the page can observe it: the
declared per-layer cost stays an estimate, the UI keeps saying "estimated", and
the only remaining levers are the ones chosen at design time — low-entropy
effects, opaque scrims, no full-surface fades.

### What W5–W8 shipped, on hardware (H29–H33)

The layer stack stopped being a spike: effects, text layers, gliding stats
values and `.krakenlook` files all ship now, and each of them makes a claim
about the **Kraken Browser** specifically that no test on a developer machine
can settle. Chromium 128 in CAM's webview is not the Chrome you are reading
this in — it has a different GPU path, no network in the ordinary case, and a
compressor between the page and the panel.

Every row here is **unverified**. None has been run on a Kraken.

| ID      | Unknown                                     | How to measure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Record                                                                                                                                                    | Status     |
| ------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **H29** | Which GL the Effects base actually draws on | Set the base to an effect (Lava lamp is fine) and open `?kraken=1&diag=1`. The effect host — `div.kh-effect` — carries **`data-gl`**, one of `webgl2`, `webgl1` or `none`, naming the renderer that is actually running; a granted context whose program would not link reads `none`, because the still gradient is what is on the panel. **`data-gl-lost="true"`** is present only while a context is lost and waiting to be rebuilt. Read it off the element (the report's `capabilities.features.webgl2` / `.webgl` say what the webview _offers_, which is the other half), and cross-check `notes` for `no WebGL context — the effect stays on its still frame`. | `data-gl` on the effect host; `capabilities.features.{webgl,webgl2}`; whether the panel shows a moving effect or a static two-colour ramp; any GL `notes` | unverified |
| **H30** | Does a stack with overlays hold `targetFps` | `?kraken=1&diag=1&pattern=stack&stack=<a\|b\|c\|d\|e>` — the five stacks from `src/diag/patterns/stack.ts`, now running the real compositor and the real `effect`/`text` modules. Read `achieved` and `long frames` from the debug overlay (add `&debug=1`) after ~15 s on each.                                                                                                                                                                                                                                                                                                                                                                                      | `achievedFps` and `longFrames` per stack against the slider's `targetFps` — five rows                                                                     | unverified |
| **H31** | Do the curated webfonts load in CAM         | Add a text layer and set its face to **Serif**. `src/modules/text/fonts.ts` injects one `<link>` at `fonts/serif.css`, **document-relative**, resolved against wherever the page is served from. Photograph the panel: Playfair Display, or the Georgia/Times fallback stack. A face that never arrives degrades silently by design, so the panel is the only witness.                                                                                                                                                                                                                                                                                                | Playfair or fallback? Does `public/fonts/serif.css` 404 from CAM's URL? Same for the other five faces                                                     | unverified |
| **H32** | Do stats values glide at the panel's rate   | Put a stats layer on the panel and film it (the H09 protocol: 5 s at 60 fps). A 1 Hz sample is tweened over **420 ms** (`TWEEN_MS`), so a value that changes should show intermediate numbers rather than jumping. Count distinct values per second in the footage, or judge it by eye. The `hz1` governor tier must **snap** instead — no glide at one update per second.                                                                                                                                                                                                                                                                                            | distinct values per second during a change; does the panel snap once the governor drops a layer to `hz1`?                                                 | unverified |
| **H33** | An 8-layer Look end to end, under 8 kB      | Build a full Look — eight layers, a video base, overlays with real settings — on CAM's configuration window with a phone paired. The trim ladder in `SyncService.fitStateEnvelope` drops `orig` first, then the module bank down to the base kind with `partial: true`, and **never touches `look.layers`**; if nothing fits it logs and refuses rather than shipping a truncated stack.                                                                                                                                                                                                                                                                              | Does the phone show the same **eight** layers? Any `state snapshot does not fit the 8 KB sync cap` in the report's `notes`?                               | unverified |

**H30 does not answer H28.** It reads the page's own `achievedFps` per stack,
which is what H25 asks for on the same patterns; whether CAM's compressor is
visible in that number at all is still **H28**, and still open. Film the counter
(**H27**) in the same run if you want both halves.

### Storage and liveness

| ID      | Unknown                     | How to measure                                                                                                                                                                                    | Record                                                                                                                                        | Status                                                                                   |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **H13** | IndexedDB persistence       | Add a clip (Library → paste a link, or add a file). Note it plays. **Quit CAM completely** (tray icon → Quit, not just close the window), relaunch, and reopen the display.                       | survived CAM restart? survived a PC reboot? `storage.persisted`, `storage.usageBytes`, `storage.quotaBytes`                                   | manual                                                                                   |
| **H14** | `storage` event reliability | Automatic, and cumulative. Open the display, then change any setting in the Configuration Browser a few times.                                                                                    | `storage.delivery.{viaEvent, viaPoll, viaMem}` — **any nonzero `viaPoll` is the finding**, because it is what justifies the 1 s poll fallback | auto — ✅ confirmed on CAM 4.76.5 (Elite; `viaPoll` 0 — [known results](#known-results)) |
| **H15** | localStorage persistence    | Same restart protocol as H13, watching whether the configured source and (later) the room code survive.                                                                                           | survived / cleared                                                                                                                            | manual                                                                                   |
| **H16** | Page lifecycle              | Leave it running. Then: change a CAM setting; then sleep and wake the PC.                                                                                                                         | does CAM reload the page on a settings change? does the panel freeze after sleep and does it recover? roughly how many reloads per day?       | manual                                                                                   |
| **H21** | LCD dimming / sleep         | Leave the display untouched for 30 minutes.                                                                                                                                                       | dims? sleeps entirely? on what timer? does it wake on its own?                                                                                | manual                                                                                   |
| **H23** | `pagehide` on teardown      | With a clip playing past the 10 s mark, close the LCD window from CAM (or change a CAM setting so it reloads the page), then reopen it. Playback should resume roughly where it was, not at zero. | did it resume? by how far was it off? does `kraken-hub:v1:video:positionCheckpoint` exist after the close?                                    | manual                                                                                   |

H16's freeze-after-sleep case is a known failure mode of the CAM webview and the
reason kraken-hub runs a liveness watchdog. Whether the watchdog actually
recovers it on real hardware is unmeasured.

**H23** is the one flush path the code cannot prove on its own. Two things hang
off `pagehide`: the display's position checkpoint, and `SyncService.stop()`,
which is what lets `MqttTransport` flush its last message before ending the
client. Both are correct in Chromium and both are belt-and-braces — the periodic
10 s checkpoint and the fact that `publish()` already awaits the broker callback
mean nothing breaks if the event never arrives. But whether CAM's Electron
webview delivers `pagehide` when it tears down the LCD window is unverified, and
"resumed where it left off after CAM restarted it" is the visible symptom that
answers it.

### Layout and network

| ID      | Unknown                                      | How to measure                                                                                                                                                                                                                                                                                                                                                                                                                        | Record                                                                                                 | Status |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| **H20** | True circular safe radius                    | `?kraken=1&diag=1&pattern=rings` (there is a **Ring target** button for it under _Report → Show the technical detail_) draws concentric labelled rings at 100/96/92/88/84/80 % of the panel width, and owns the stage — no module is mounted behind the target, so what you photograph is the rings and the background, nothing else. Photograph the panel **straight on**, and report the outermost label that is **fully** visible. | `visibleRadiusPct` — this calibrates the safe-area inset, currently a community-practice guess of 0.88 | manual |
| **H19** | Network reachability from inside the webview | The button under _Report_ lands with the sync transports in M2. Until then: does the display load at all from a remote URL, and does anything on your network block nonstandard ports?                                                                                                                                                                                                                                                | reachable / blocked, plus any corporate proxy in the way                                               | M4     |

---

## `DiagReport` field reference

This is the shape of the JSON the **Copy report** button gives you
(`schemaVersion: 1`).

| Field                               | Meaning                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                     | Report format version. The About page ignores a report whose version it does not know.                                                                                                              |
| `capturedAt`                        | `Date.now()` at capture.                                                                                                                                                                            |
| `app.{version,gitSha,buildTime}`    | Which build produced this. Always include it; a report without it cannot be reproduced.                                                                                                             |
| `mode`                              | `"display"` or `"config"` — which of CAM's two browsers wrote it.                                                                                                                                   |
| **`device`**                        |                                                                                                                                                                                                     |
| `device.{width,height,shape}`       | Resolved panel geometry, after fallbacks.                                                                                                                                                           |
| `device.targetFps`                  | The CAM frame-rate slider, as the page sees it. **H01.**                                                                                                                                            |
| `device.geometrySource`             | Where the geometry came from: the injected API, a `?sim=` preset, or the fallback.                                                                                                                  |
| `device.dpr`                        | `devicePixelRatio`. **H02** — the crop math assumes 1.                                                                                                                                              |
| `device.safeInsetPx`                | Circular safe-area inset in px, derived from `safeRadiusPct`. **H20** calibrates it.                                                                                                                |
| `device.inscribedSquarePx`          | The largest square inside the circle — what overlays are laid out against.                                                                                                                          |
| `device.screen.*`                   | `screen.{width,height}` and `inner{Width,Height}`.                                                                                                                                                  |
| `device.nzxtRaw`                    | **Exactly** what CAM injected, or `null` if it never did. The ground truth for H01.                                                                                                                 |
| **`injection`**                     |                                                                                                                                                                                                     |
| `injection.firstSeenMs`             | ms from `performance.timeOrigin` to the first successful read. **H03.**                                                                                                                             |
| `injection.attempts`                | Retries of the 200 ms × 10 ladder before it bound.                                                                                                                                                  |
| `injection.reinjections`            | Times CAM replaced the object after the first bind.                                                                                                                                                 |
| `injection.present`                 | Whether `window.nzxt.v1` is readable right now.                                                                                                                                                     |
| **`capabilities`**                  |                                                                                                                                                                                                     |
| `capabilities.userAgent`            | Verbatim UA string.                                                                                                                                                                                 |
| `capabilities.chromiumVersion`      | Parsed from the UA. **H18** — the build target is guessing at this.                                                                                                                                 |
| `capabilities.electronVersion`      | Present when CAM's UA admits to Electron.                                                                                                                                                           |
| `capabilities.codecs`               | Per codec: `element` (`canPlayType`) and `mse` (`MediaSource.isTypeSupported`). **H17.**                                                                                                            |
| `capabilities.features`             | Boolean map: `webgl`, `webgl2`, `webgpu`, `webCodecs`, `offscreenCanvas`, `mediaSource`, `eventSource`, `broadcastChannel`, `cryptoSubtle`, `storageManager`, `indexedDb`, `audioContext`. **H18.** |
| `capabilities.hardwareConcurrency`  | CPU threads the webview reports.                                                                                                                                                                    |
| `capabilities.deviceMemoryGb`       | `navigator.deviceMemory`, when present.                                                                                                                                                             |
| **`timings`**                       |                                                                                                                                                                                                     |
| `timings.rafFps`                    | `{count,p50,p95,max}` over a 3 s `rAF` window. **H12.**                                                                                                                                             |
| `timings.monitoringIntervalMs`      | Reserved for the H04 histogram — currently always `null`.                                                                                                                                           |
| `timings.achievedFps`               | What the frame governor actually delivered.                                                                                                                                                         |
| `timings.longFrames`                | Frames that overran their budget.                                                                                                                                                                   |
| **`storage`**                       |                                                                                                                                                                                                     |
| `storage.usageBytes` / `quotaBytes` | `navigator.storage.estimate()`. **H13.**                                                                                                                                                            |
| `storage.persisted`                 | `navigator.storage.persisted()` — whether eviction is off the table.                                                                                                                                |
| `storage.localStorageAvailable`     | False in a partitioned or blocked context.                                                                                                                                                          |
| `storage.localStorageDegraded`      | True when writes are failing and the app fell back to memory.                                                                                                                                       |
| `storage.delivery.viaEvent`         | State changes delivered by the `storage` event. **H14.**                                                                                                                                            |
| `storage.delivery.viaPoll`          | State changes the 1 s poll caught that the event missed. **The interesting number.**                                                                                                                |
| `storage.delivery.viaMem`           | Same-page updates; not evidence either way.                                                                                                                                                         |
| **`manual`**                        | `visibleRadiusPct` (H20), `audioAudible` (H08), `dimsWhenIdle` (H21). Currently always `null` — fill these in by hand in the report form.                                                           |
| `notes`                             | The last 16 log-ring entries. Warnings and errors from the run that produced the report.                                                                                                            |

Nothing in the report is personal: no URLs you configured, no room code, no
tokens, no file names. It is device and browser facts plus the log ring.

---

## Paste-ready results table

Copy this into the hardware report issue and fill in what you measured. Leave a
row blank rather than guessing — a blank row is data, a guess is not.

```markdown
| Field                                                 | Value |
| ----------------------------------------------------- | ----- |
| Model                                                 |       |
| CAM version                                           |       |
| kraken-hub version + gitSha                           |       |
| OS                                                    |       |
| Frame Rate slider (CAM)                               |       |
|                                                       |       |
| **H01** width×height / shape                          |       |
| **H01** targetFps                                     |       |
| **H02** devicePixelRatio                              |       |
| **H03** firstSeenMs / attempts                        |       |
| **H04** monitoring ~1 Hz?                             |       |
| **H04** liquidTemperature?                            |       |
| **H05** YouTube iframe works                          |       |
| **H05** any chrome visible?                           |       |
| **H06** muted autoplay                                |       |
| **H07** unmuted autoplay                              |       |
| **H08** audio audible / device                        |       |
| **H09** capture FPS, flat                             |       |
| **H10** capture FPS, video                            |       |
| **H11** capture FPS, YouTube                          |       |
| **H12** rafFps p50 / p95                              |       |
| **H13** clip survived CAM restart                     |       |
| **H13** clip survived reboot                          |       |
| **H13** storage.persisted                             |       |
| **H14** viaEvent / viaPoll                            |       |
| **H15** settings survived restart                     |       |
| **H16** reload on CAM setting change                  |       |
| **H16** froze after sleep / recovered                 |       |
| **H17** H.264 / VP9 / AV1 / HEVC                      |       |
| **H18** Chromium version                              |       |
| **H19** network blocked?                              |       |
| **H20** outermost visible ring %                      |       |
| **H21** dims / sleeps after                           |       |
| **H23** resumed after CAM restart                     |       |
| **H24** worst layer p95 (stack a / e)                 |       |
| **H25** achievedFps (stack a / e)                     |       |
| **H25** longFrames (stack a / e)                      |       |
| **H26** achievedFps (stack d / e)                     |       |
| **H27** capture FPS a / b / c / d / e                 |       |
| **H28** does compressor load reduce page achievedFps? |       |
| **H29** `data-gl` on the effect host                  |       |
| **H30** achievedFps a / b / c / d / e vs target       |       |
| **H31** Serif layer: Playfair or fallback             |       |
| **H32** stats glide visible / hz1 snaps               |       |
| **H33** phone shows all 8 layers                      |       |
| **H22** Kraken Plus notes                             |       |
```

Attach the display JSON as a fenced code block, and any photographs of the panel
— especially the H20 ring target and the H05 YouTube crop.

---

## Known results

Updated by maintainers from submitted hardware reports.

| Device            | Reporter                | H-ids closed                      | Report                                        |
| ----------------- | ----------------------- | --------------------------------- | --------------------------------------------- |
| Kraken Elite 640  | maintainer (own device) | H01, H02, H03, H12, H14, H17, H18 | CAM 4.76.5, 2026-08-31, app 0.1.0 (`2f556b4`) |
| Kraken Plus       | —                       | —                                 | —                                             |
| Kraken Z 320      | —                       | —                                 | —                                             |
| Kraken (2023) 240 | —                       | —                                 | —                                             |

Three of the four rows are still empty, and that is still the honest state of
this project's hardware knowledge.

### Kraken Elite — CAM 4.76.5

**Source for every row below:** maintainer's Kraken Elite, CAM 4.76.5,
2026-08-31, app 0.1.0 (`2f556b4`). Windows, CAM frame-rate slider at its
maximum. Read it as **one device on one CAM build**, not as a platform
guarantee.

| ID      | Measured                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H01** | `device.nzxtRaw` = `{ width: 640, height: 640, shape: "circle", targetFps: 40 }` — exactly the documented Elite geometry, with no defaulting applied.                                                                                                                                |
| **H02** | `devicePixelRatio` = **1**. The crop math's assumption holds. The hidden Kraken Browser reports `screen` as **0×0** with a 640×640 viewport, so screen dimensions are useless there — never derive geometry from them.                                                               |
| **H03** | `window.nzxt` injected at **34 ms**, on **attempt 1**, with **0 re-injections**, `present: true`. The 200 ms × 10 retry ladder never needed a second rung — but it costs nothing and a slower machine is exactly what it is for.                                                     |
| **H12** | In-page rAF is **locked at 40 fps**: `rafFps` p50 = p95 = **40**, `achievedFps` **39.9999**, `longFrames` **0**. The page renders precisely at the slider value and drops nothing. What CAM then _captures_ (H09–H11) is a separate, still-unmeasured number.                        |
| **H14** | `storage.delivery` = `viaEvent: 3`, `viaPoll: 0`. The `storage` event is reliable across CAM's two browsers on this build — **no change was ever caught by the poll alone**. The unconditional 1 s poll stays: it is cheap, and a single device is not evidence for every CAM build. |
| **H17** | Full codec matrix, `canPlayType` **and** `MediaSource.isTypeSupported`: H.264, VP8, VP9, **AV1**, **HEVC**, AAC, Opus, FLAC. HEVC and AV1 are decided by the **GPU and its drivers**, not by CAM — do not read this row as "the platform supports HEVC".                             |
| **H18** | **Electron 32.1.0 / Chromium 128**. WebGPU and WebCodecs both present, alongside WebGL2, `crypto.subtle`, `navigator.storage`, EventSource, BroadcastChannel and IndexedDB. `navigator.storage.persisted()` = **true** with a **~1.49 TB** quota.                                    |

Two things this report also produced, both now fixed, both worth keeping on the
record because they are the reason a hardware report is worth more than a code
review:

- `mqtt connect failed — trying the next transport` /
  `TypeError: (intermediate value).connect is not a function` — the browser
  bundle's mqtt namespace has no named `connect`. MQTT never once connected on
  hardware; sync silently ran on ntfy.
- `source-unplayable: r?.mute is not a function` — the YouTube adapter called a
  player method before `onReady`. **The entire YouTube engine failed on the one
  device it exists for**, while every test passed.

**Partially closed:**

- **H05** — the cross-origin iframe _constructs_ and the IFrame API script
  loads inside the CAM webview, so a third-party iframe is permitted. The rest
  of H05 is not closed: `onReady` never got a fair run on this report (the
  adapter crashed before it, see above), and **nobody has photographed the panel
  to confirm the crop hides every piece of player chrome**. H05 stays open.
- **H13** — `storage.persisted` is `true` with a ~1.49 TB quota, which is the
  _precondition_ for the clip library surviving. Whether a clip actually
  survives quitting CAM and rebooting the PC is the measurement, and it has not
  been made. H13 stays open.

**Still completely open:** the capture-side FPS numbers (**H09**–**H11**), the
monitoring feed (**H04**), autoplay and audio (**H06**–**H08**), localStorage
and lifecycle across restarts (**H15**, **H16**), network reachability
(**H19**), the ring target (**H20**), idle dimming (**H21**), `pagehide` on
teardown (**H23**), the layer-stack numbers on real hardware (**H24**–**H27**)
and above all **H28**, which decides whether the layer governor can see
compressor overload at all — and **H22**, which this report cannot touch at all: the
reporter's device is an Elite, and H22 is a claim about a **Kraken Plus**. That
row is still the emptiest one on the page.

The five rows W5–W8 added (**H29**–**H33**) postdate that report entirely, so
they are open by construction: nobody has yet run an effect, a webfont, a
gliding stats face or an eight-layer Look on a Kraken.
