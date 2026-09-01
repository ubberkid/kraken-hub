# Troubleshooting

Symptom, mechanism, fix. Where a fix rests on something nobody has measured on
real hardware, the row says so and links the H-id in
[hardware-checklist.md](hardware-checklist.md) that would settle it.

Before anything else, two questions answer most reports:

1. **Is the CAM frame-rate slider up?** It ships at 1 FPS. See
   [below](#video-plays-as-a-slideshow-one-frame-per-second).
2. **What does the version footer say?** Every configuration page ends with
   `kraken-hub v… · <sha> · built …`. Quote it — it names the exact deploy. It is
   also a link: it opens the About page, whose **Report** section is where the
   diagnostics live — **Copy report** puts them on your clipboard.

---

## The panel is blank, or black

**Symptom.** The LCD shows nothing, or a black circle, where kraken-hub should
be. CAM's own images still work.

**Causes, in the order worth checking.**

| Cause                                 | How to tell                                                                                                                                                                       | Fix                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The URL is missing its trailing slash | The address in CAM ends `…/kraken-hub` rather than `…/kraken-hub/`                                                                                                                | Re-paste it from the configuration page's copy button. Pages answers the slashless form with a 301, and a redirect on load is untested inside CAM.                                                                              |
| A module crashed                      | Open `?kraken=1&diag=1` in an ordinary browser at the same URL — a crashed module draws an **error card**, not a black screen, so a truly black panel means it never got that far | The card names the failure and always ends "Fix in CAM → Lighting → your Kraken → your kraken-hub card → Configure".                                                                                                            |
| The page never booted                 | The configuration page works, but the panel is black                                                                                                                              | CAM caches aggressively. Toggle the card off and on. If it recovers, that is the reload path working.                                                                                                                           |
| The panel is asleep, not blank        | It wakes when you move the mouse or open CAM                                                                                                                                      | CAM's own dimming, not kraken-hub — timing unmeasured, [H21](hardware-checklist.md).                                                                                                                                            |
| Frozen after the PC slept             | It was fine before the machine slept, and has been static since                                                                                                                   | A known CAM webview failure mode. kraken-hub runs a liveness watchdog that reloads the page — whether that actually recovers it on hardware is unmeasured, [H16](hardware-checklist.md). Toggling the card in CAM always works. |

**Getting the diagnostics off a panel you cannot copy text from:** open the
display with `?kraken=1&diag=1`. It publishes a full `DiagReport` through
`localStorage` every five seconds, and the configuration page's **About → Report
→ Copy report** — the version line in the footer opens it — puts that JSON on
your clipboard. That is the intended path; do not photograph the LCD and
transcribe it.

## Video plays as a slideshow, one frame per second

**Symptom.** Everything is correct but the motion is a series of stills.

**Cause.** CAM's **Frame Rate** slider. Every Web Integration starts at 1 FPS,
and no web page can override it: the slider controls how often CAM captures the
page, not how fast the page draws.

**Fix.** CAM → Lighting → your Kraken → Web Integration → **Frame Rate** →
drag to maximum. Elite 40, Kraken (2023) 25, Kraken Z is capped at 1 by NZXT and
will not be raised. Kraken Plus is unmeasured, [H22](hardware-checklist.md).

**If it is still choppy at maximum**, that is a second, real mechanism: the Elite
compresses each captured frame, so achieved FPS depends on frame _content_.
High-entropy full-screen video — grain, confetti, fast pans — is its worst case.
Flat colour and large shapes are its best. Actual achieved-FPS numbers for flat
content, full-bleed video and the YouTube engine are
[H09–H11](hardware-checklist.md) and are, honestly, not yet measured. If you have
a Kraken, measuring them is the single most useful contribution you can make.

## A clip I downloaded has vanished

**Symptom.** A clip that played yesterday is gone from the library, or plays and
then errors with a missing-blob card.

**Cause.** Chromium evicted it. Clip bytes live in IndexedDB, which is
best-effort storage unless the origin is _persisted_; under disk pressure the
browser is entitled to drop the whole bucket without asking.

**Fix.**

- **Library** shows a usage meter under the shelf and whether persistence was
  granted. kraken-hub calls `navigator.storage.persist()` on first store;
  Chromium grants it heuristically and can refuse.
- Free disk space on the drive holding CAM's profile. Eviction is a
  disk-pressure response.
- Keep fewer, smaller clips. A 640×640 square crop at CRF 21 is a fraction of the
  size of the 1080p original and looks identical on the panel — the ffmpeg
  one-liner is in [local-clips.md](local-clips.md).

Whether IndexedDB survives a CAM restart and a reboot on real hardware is
[H13](hardware-checklist.md); whether `localStorage` does is
[H15](hardware-checklist.md). Both are believed fine — a widely used community
integration relies on it — and neither has been measured here.

## Nothing autoplays

**Symptom.** The video is loaded and paused; the panel shows a still frame.

**Cause.** Chromium's autoplay policy. A page with no user gesture may autoplay
**muted** video only.

**Fix.** There is nothing to fix, because the display is muted by design and
always passes `muted` + `playsinline`. If a video is genuinely not starting, it
is not the autoplay policy — check the source with `?kraken=1&diag=1` and read
the error card.

Muted autoplay inside the CAM webview specifically is
[H06](hardware-checklist.md); unmuted is [H07](hardware-checklist.md); whether
the webview reaches your speakers **at all** is [H08](hardware-checklist.md), and
until somebody measures it there is no volume control in the app at all. A
control that could only ever be disabled is worse than no control.

## The phone remote will not connect

**Symptom.** The remote shows the room code but the line under the transport
never reads _Linked to your Kraken_, or the display never reacts.

**Causes.**

| Cause                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The codes differ                           | Scanning the QR cannot get this wrong, because the code rides in the link; a typed code can. They must match exactly. Crockford base32 has no I, L, O or U precisely so that `1`/`I` and `0`/`O` cannot be misread, and the **Room code** field now filters those letters out as you type rather than accepting a code that cannot exist — so a code that looks right in the field is at least a possible one. A code that is still not eight usable characters is refused in place, under the field, instead of submitting silently.                                                                                                                                                                                                                                     |
| The public broker is blocked               | `broker.emqx.io:8084` is WebSocket-over-TLS on a non-standard port. Corporate and school networks block it routinely. kraken-hub fails over to `ntfy.sh` over ordinary HTTPS automatically, in under five seconds — if both are blocked, override the endpoints under **About → Connection → Use my own broker** and point them at your own broker.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The display was never opened               | The remote drives the **display**, not the configuration page. If the Kraken Browser is not running, there is nothing on the other end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The room was never joined on both sides    | Generating a code on the pairing card pairs that browser. The phone must join the same room — scanning the QR does it automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The file transfer will not start or finish | Sending a file is a real feature — **Remote → Add → Send a file** — but it goes **peer to peer over WebRTC**, from the phone straight to the display, with one STUN server and deliberately **no TURN relay**. So: both devices must be on the **same network**, because there is no relay to fall back to; the **display** must be running, because the display is the receiver (the configuration window is not); and the cap is **500 MB** per file, checked against the library's remaining quota before a byte moves. The app names the network requirement — _"Your phone and PC need to be on the same network."_ — only once a transfer has genuinely failed or timed out, so seeing it means the handshake really did fail, not that you were warned in advance. |

Whether CAM's webview can reach either endpoint at all is
[H19](hardware-checklist.md) — the Report section's technical detail names the
targets but deliberately never probes them unasked.

## Settings changes do not reach the panel

**Symptom.** You change something in the configuration window and the LCD keeps
showing the old thing.

**Cause.** The channel between the two CAM browsers is `localStorage` plus the
`storage` event. If the event does not fire, the change waits.

**Fix.** It should resolve itself within one second: kraken-hub runs an
**unconditional 1-second poll** alongside the event listener. On CAM 4.76.5 the
`storage` event is confirmed reliable ([H14](hardware-checklist.md#known-results),
`viaPoll` 0), so in practice the event does the work — the poll is there because
other CAM versions are unmeasured. If it takes longer than a second, the display
page is not running — reopen it from CAM.

The diagnostics report counts the two paths separately
(`storage.delivery.viaEvent` / `viaPoll`). **Any nonzero `viaPoll` is a finding**,
because it is the evidence that justifies the fallback existing. Please report it.

## The companion is not detected

**Symptom.** The companion is running but YouTube still plays through the
geometry engine, and the **Local downloader** card reads _Not running_ rather
than _Running_. The card lives on the home screen: tap the **Video** chip that
is already active to open the module's options, then open **Advanced**.

**Causes.**

- **It is not actually running**, or it exited. Its window prints a banner
  ending in "kraken-hub will detect this automatically" while it is up; closing
  that window stops it. `curl http://127.0.0.1:8976/health` should return JSON.
- **SmartScreen ate it.** On Windows the unsigned exe shows "Windows protected
  your PC" and does nothing until you pick **More info → Run anyway**. If you
  dismissed that dialog, the companion never started.
- **You are looking for an `npx` command.** There isn't one — the package is not
  published to npm. On Windows, download
  [kraken-hub-resolver-win-x64.exe](https://github.com/ubberkid/kraken-hub/releases/latest/download/kraken-hub-resolver-win-x64.exe);
  elsewhere, run `npm install && npm run build:companion && node companion/resolver/dist/cli.js`
  from a clone.
- **A different port.** The default is `8976`. If you started it with `--port`,
  set the same **Port** under _Advanced → Local downloader_.
- **A token is set on one side only.** `--token` locks the companion; the app has
  to be told the same token.
- **The health check is memoized.** kraken-hub probes once, with a 1.2 s timeout,
  and remembers the answer. Start the companion _first_, then reload the
  configuration page.
- **Policy is `Never`.** The default is **YouTube**. Check _Advanced → Local
  downloader → Use it for_.

Detection failing is never an error state by design: with no companion the app
silently uses the geometry engine, so "nothing happened" is the expected
appearance of both success and absence. The card is the only way to tell them
apart.

## "Blocked: mixed content" / an `http://` link does nothing

**Symptom.** A source URL beginning `http://` is rejected, or loads nothing.

**Cause.** kraken-hub is served over HTTPS. Browsers block active `http://`
subresources on an HTTPS page — this is the browser's rule, enforced before any
of our code runs, and there is no flag for it.

**Fix.**

- Use the `https://` form of the same URL if the server offers one.
- Download the file yourself and add it via **Library → Add → Browse…** (or drop
  the file onto the add panel).
- The one legitimate exception is the resolver companion on `127.0.0.1`:
  loopback is explicitly **exempt** from mixed-content blocking, which is why the
  companion binds loopback and only loopback.

## `.mkv` will not play

**Cause.** Chromium does not implement the Matroska container. Not a codec
problem and not a kraken-hub problem — no browser plays `.mkv`.

**Fix.** Remux it, which is a container change and does not re-encode:

```bash
ffmpeg -i input.mkv -c copy -movflags +faststart output.mp4
```

If the stream inside is not H.264/AAC-compatible, that command will say so and
you will need a real transcode. kraken-hub tells you all of this in the URL
field, before you commit.

## Video is fine, YouTube shows ads

**Cause.** Ads render **inside the video rect**, in the same pixels as the video.
kraken-hub's geometry crop removes the player's chrome — title, watermark,
control strip, pause overlay, end screen — because those live on the letterbox
bars outside the crop. It can do nothing about content the player draws in the
picture itself, and the embed API exposes no reliable ad signal.

**Fix.** Play a local clip. Either paste a direct URL the server shares, or run
the [companion](../companion/resolver/README.md), which downloads the video to
your machine and plays it as an ordinary local clip: no ads, no chrome, full
quality, real pause, seamless loop. This is the honest reason the documentation
keeps pointing there.

## Two kraken-hub deployments are fighting over one configuration

**Symptom.** You run your own fork _and_ somebody else's build under the same
`<user>.github.io`, and each overwrites the other's settings and clip library.

**Cause.** Browser storage is scoped by origin, not by path, and kraken-hub's
storage prefix is the fixed string `kraken-hub:v1:`. Two deployments on one
origin are one bucket.

**Fix.** Put the second on its own origin — a custom domain, or a different
GitHub account. Details and the design correction are in
[self-hosting.md](self-hosting.md#nothing-is-hardcoded).

---

## Still stuck

Open the display with `?kraken=1&diag=1`, press **Copy report** on the
configuration page's **About** page (the version line in the footer), and
[file an issue](https://github.com/ubberkid/kraken-hub/issues/new/choose) with
it attached. That report contains the device identity, the Chromium version, the
codec matrix, storage persistence, the state-delivery counters and the frame
timings — which is most of what anyone would otherwise ask you for.
