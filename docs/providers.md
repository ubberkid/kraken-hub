# Providers — what actually works, and what doesn't

kraken-hub plays video from a lot of places. It does **not** play all of them
equally well, and the differences are not arbitrary: they come from what each
provider's player lets a third-party page do. This page is the honest version of
that. If a row says "no", it means we tried and it does not work — not that it is
on a roadmap.

Two facts shape every row below.

**A cross-origin player is opaque.** YouTube, Twitch, Vimeo and Streamable render
inside an `<iframe>` on their own origin. CSS on our page cannot reach inside it,
so no stylesheet can hide their title bar, watermark, spinner or pause overlay.
The only lever is **geometry**: make the iframe large and shaped so the player
letterboxes the video, then crop the centre. The chrome lands on the black bars
and is cropped away. That is what kraken-hub does for all four of them, and it is
also why `fit` is forced to `cover` on those providers unless you explicitly
allow chrome.

**The Kraken display is always muted.** That sounds like a limitation and is
frequently an advantage: it is why Reddit's split-audio problem does not affect
us, and why dropping a failing audio track is free.

---

## Capability matrix

| Provider                                          | Source               | Chrome-free           | Quality control                                         | Silent A‑B loop        | True pause | Notes                                                                   |
| ------------------------------------------------- | -------------------- | --------------------- | ------------------------------------------------------- | ---------------------- | ---------- | ----------------------------------------------------------------------- |
| **Local clip**                                    | IndexedDB blob       | ✅ none to hide       | n/a — it is your file                                   | ✅                     | ✅         | The best path in the app. No CORS, no ads, works offline.               |
| **Resolver companion**                            | `127.0.0.1`          | ✅ none to hide       | ✅ via `maxHeight` (re-downloads)                       | ✅                     | ✅         | Equal best. Optional; see [resolver-protocol.md](resolver-protocol.md). |
| **Direct file** (`.mp4`, `.webm`, `.m4v`, `.ogv`) | `<video src>`        | ✅                    | ❌ (one rendition)                                      | ⚠️ once buffered       | ✅         | Downloaded into the clip library when the server allows it.             |
| **HLS** (`.m3u8`)                                 | hls.js (light build) | ✅                    | ✅ per-level                                            | ⚠️ within the buffer   | ✅         | Needs CORS — it is MSE. Live playlists disable looping.                 |
| **DASH** (`.mpd`)                                 | dash.js 5            | ✅                    | ✅ per-representation                                   | ⚠️ within the buffer   | ✅         | Needs CORS. Dynamic (live) manifests disable looping.                   |
| **Reddit** (`v.redd.it`)                          | probe → direct file  | ✅                    | ✅ by ladder rung                                       | ✅                     | ✅         | See below — usually never touches dash.js at all.                       |
| **YouTube**                                       | geometry engine      | ✅ chrome, ❌ **ads** | ⚠️ bias only (720/1080/1440 → 1280/1920/2560 px player) | ⚠️ measured at runtime | ❌         | See below.                                                              |
| **Twitch**                                        | Embed JS API         | ✅                    | ✅ real `setQuality`                                    | ⚠️ VOD/clip only       | ✅         | Live channels cannot loop or seek.                                      |
| **Vimeo**                                         | player.js            | ✅                    | ❌ for public videos                                    | ⚠️                     | ✅         | Quality control is gated on the _uploader's_ paid tier.                 |
| **Streamable**                                    | oEmbed → iframe      | ✅                    | ❌                                                      | ❌                     | ❌         | No player API at all. Plays; nothing else.                              |

"Silent A‑B loop" means the loop seam does not show a spinner or a flash. For the
`⚠️` rows kraken-hub _measures_ it: after three consecutive clean crossings the
adapter promotes `canSeekSilently` to true and cuts the mask flash to 100 ms, and
publishes the observed value as telemetry — so the config UI can tell you whether
_your_ loop is seamless rather than guessing.

### What the Quality control does, per provider

The **Quality** row on the video panel (and in the remote's More controls) is not
the same control everywhere, because "change the resolution" is not the same
operation everywhere. It shows what you are getting in all four cases, and it
offers control only where control is real:

| Control shown       | Providers                       | What choosing a height actually does                                                                                                                            |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Picker** (real)   | HLS, DASH, Twitch, resolver     | HLS pins `currentLevel`; DASH pins a representation and turns ABR off; Twitch calls `setQuality`; the resolver re-asks at a new `maxHeight` and downloads that. |
| **Bias** (indirect) | YouTube                         | Resizes the hidden player to 1280 / 1920 / 2560 px wide. YouTube still chooses; the width is the only thing it listens to.                                      |
| **Read-only**       | Local clip, direct file, Reddit | Nothing — the file has one resolution. The row shows it and stops.                                                                                              |
| **Nothing yet**     | Anything not mounted            | Says so, rather than offering options nothing would honour.                                                                                                     |

The picker's options are not a guessed ladder. Every provider that _can_
enumerate its renditions publishes them the moment they become knowable — a
parsed HLS manifest, an initialised DASH stream, Twitch's `getQualities()` — and
those exact heights are what you see. The resolver is the one exception, and an
honest one: yt-dlp has already chosen a stream, so there is no ladder to read,
but the companion reports the **source height**, and every rung of the standard
ladder below it is genuinely obtainable by asking again with a lower
`maxHeight`. Nothing above it is offered, because nothing above it exists.

Two consequences worth knowing:

- **On the resolver path, changing the quality re-downloads.** The old clip keeps
  playing until the new one lands, then they swap; both stay in the library, so
  switching back is instant. That is why a pinned height becomes part of the key
  a clip is remembered by.
- **`Auto` means the provider's own adaptive logic**, not "whatever kraken-hub
  last set". Switching back to Auto genuinely hands control back — `currentLevel
= -1` on HLS, `autoSwitchBitrate` on for DASH, `auto` on Twitch.

---

## YouTube: sharp, chrome-free, and still not ad-free

kraken-hub's YouTube path is genuinely much better than the official NZXT
integration — a 1920×1920 iframe elicits ~1080p where a 640×640 one gets ~360p,
and the centre crop removes the title overlay, the watermark, the control strip
and the pause overlay entirely.

**It cannot remove ads.** Ads render _inside the video rect_, in the same pixels
as the video. The crop hides the player's chrome; there is nothing it can do
about the content the player chooses to put in the picture. The embed API also
gives no reliable ad signal, so the overlay mask stays down through one. This is
stated in the config UI next to the URL field, and it is the honest reason the
docs keep pointing at local clips and the resolver companion.

Three more YouTube-specific truths:

- **Aspect ratio is a manual setting.** There is no cross-origin way to read a
  video's true aspect: the iframe is opaque, `i.ytimg.com` thumbnails are always
  16:9 with bars baked in, and oEmbed reports _player_ dimensions rather than
  source ones. `Auto` means 9:16 for a `/shorts/` link and 16:9 for everything
  else. If the crop lands on the wrong part of the picture, that setting is why.
- **We never call `pauseVideo()` by default.** It raises the suggested-video grid
  inside the video rect. "Hold" is a micro-loop at 0.25× instead. There is one
  opt-in alternative — see [Hold behaviour](#hold-behaviour-micro-loop-vs-masked-pause).
- **We never let playback reach the end.** The end screen is inside the video
  rect too, so there is always an implicit loop that stops one second short.
- **Playlists are ignored.** `&list=` plays the single video and warns.

### Hold behaviour: micro-loop vs masked pause

**CAM → Kraken → Configure → Video → YouTube → Hold behaviour** offers two ways
to hold a frame, and they trade power against risk:

| `youtube.pauseStrategy`   | What it does                                                                                                                                                                                | Cost                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **`microloop`** (default) | Sets the slowest playback rate the player offers and re-seeks inside a ~0.3 s span. The player never leaves the `PLAYING` state, so no overlay is ever raised.                              | The decoder keeps running. Video keeps being decoded and composited for the whole hold.       |
| `maskedPause`             | Raises kraken-hub's own fully opaque overlay mask, waits a few frames for it to actually paint, and only then calls `pauseVideo()`. The suggested-video grid does appear — behind the mask. | If the mask ever drops (a crash, a reload, a mask failsafe firing), the grid is on the panel. |

**Prefer `maskedPause` for long holds and low-power situations** — a paused clip
left on the panel for minutes or hours, or a machine where the decoder running
flat out for a still frame is a real cost. The saving is genuine: a paused
YouTube player decodes nothing, and CAM's capture pipeline has a static frame to
compress.

**Keep `microloop` for anything short.** It is the default because it is
failure-tolerant: it does not depend on our mask being correct, and the
2.5 s mask failsafe (which exists to stop a stuck mask hiding working video)
would uncover the pause overlay if it fired during a masked pause.

## Reddit: the cheap path first

`v.redd.it` publishes each rendition as a plain progressive file next to the
manifest — `https://v.redd.it/<id>/DASH_1080.mp4` and friends — and sends
`Access-Control-Allow-Origin: *`.

Since the display is muted, kraken-hub probes `1080 → 720 → 480 → 360` with a
throwaway `<video preload="metadata">` (4 s each) and plays the first one that
answers as an ordinary direct file. That skips the dash.js bundle, the MSE
pipeline and Reddit's intermittently-403ing audio track entirely.

dash.js is loaded only if you turned audio on, or if every rung of the ladder
failed. In that case, two consecutive audio failures make kraken-hub drop the
audio track and keep the video — a 403 on a track nobody can hear must never
take the picture down.

**Paste the `v.redd.it/…` link, not the comments page.** A `reddit.com/r/…` URL
is rejected with that message.

## Twitch: the `parent` parameter, and why forks just work

Twitch refuses to render `player.twitch.tv` unless every hostname that frames it
is listed in the embed's `parent` parameter. kraken-hub computes that from
`location.hostname` **at runtime**, so a fork on its own `<user>.github.io`, a
custom domain, or plain `http://127.0.0.1` works with no configuration. There is
nothing to change when you fork this repo.

Quality control is real here — `setQuality` is not tier-gated — so kraken-hub
asks for the rendition that matches the crop instead of letting ABR pick for a
panel it cannot see.

Live channels (`twitch.tv/<name>`) disable both looping and seeking: the window
slides, so a seek into it is an unrecoverable spinner on a screen nobody can
click. VODs and clips loop and seek normally.

## Vimeo: quality is not ours to set

`player.setQuality()` exists in Vimeo's SDK, and for an ordinary public video it
silently does nothing — the capability is gated on the **uploader's** Plus/PRO/
Business tier, not on yours. So kraken-hub reports `canSetQuality: false` rather
than offering a control that pretends. The geometry crop is the only quality
lever, and it is the same one that works on YouTube.

Two smaller notes: Vimeo paints a play button and the title when paused, so
kraken-hub raises the overlay mask _before_ pausing; and `setLoop(true)` is never
called, because it suppresses the `ended` event the loop engine uses as its
failure signal.

## Streamable: it plays, and that is all

Streamable ships no player API — no `postMessage` protocol, no SDK, no clock, no
seek, no pause, no quality. The one useful thing it offers is oEmbed, which
reports the source's true width and height; kraken-hub uses that to crop a
vertical clip correctly instead of assuming 16:9. If the oEmbed call is refused,
it assumes 16:9 and plays anyway.

A‑B looping is unavailable on Streamable. That is the provider, not a gap.

---

## Links that are rejected, and what to do instead

| Link                                                    | What kraken-hub says                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `.mkv`, `.mka`, `.avi`, `.flv`, `.wmv`, `.rmvb`, `.3gp` | Chromium has no Matroska/AVI demuxer in `<video>`, and no library fixes that. Remux: `ffmpeg -i in.mkv -c copy out.mp4`              |
| `reddit.com/r/…`                                        | Paste the `v.redd.it/…` link — open the video and copy the video link.                                                               |
| `http://` (non-loopback)                                | Silently upgraded to `https://`. If that fails, the link is unusable on an HTTPS page; download the file and add it as a local clip. |
| anything over 2048 characters                           | Won't survive the sync channel.                                                                                                      |

And two that are allowed but warned about:

- **Discord CDN links** (`cdn.discordapp.com`) are signed and expire in about 24
  hours. They will stop working. Download the file instead.
- **`.mov`** files often contain ProRes or HEVC. HEVC in Chromium depends on GPU
  support with no software fallback, so it can fail on one machine and work on
  another. MP4/H.264 is safest.

---

## The unknown-URL fallback chain

A link with no recognisable host and no file extension — a redirect, a signed CDN
path — is not rejected. kraken-hub tries, in this order:

1. **Attach it to a `<video>`** (6 s). Plain progressive playback needs _no CORS
   at all_, so this succeeds for the majority of real-world direct links, and it
   is deliberately first for that reason.
2. **Range-probe the first 2 KB.** A CORS refusal here is expected and is not an
   error. When it does succeed, the content type or the magic bytes (`#EXTM3U`,
   `<MPD`) identify the format exactly.
3. **Guess blindly from the path** — `m3u` means try HLS, `mpd`/`manifest` means
   try DASH.
4. **Retry the whole chain through a proxy**, if and only if you configured one.
5. Give up and show the error card, with every step's reason in the diagnostics
   log.

The whole chain is capped at 25 seconds, so the LCD never sits on a spinner.

### About that proxy field

It ships **empty**, and it should usually stay empty. A proxy sees every URL your
display plays.

If you do need one, the honest caveat: **a plain passthrough proxy cannot fix
HLS.** The variant and segment URLs _inside_ an `.m3u8` resolve back to the
origin host, so they re-fail CORS one layer down. Making HLS work through a proxy
requires a worker that rewrites playlist URLs. Deploying your own Cloudflare
Worker is the recommended route.

`allorigins.win` is offered as a preset because it is genuinely useful for
one-off progressive files, not because it is reliable — it is a free public
service with no uptime promise. `corsproxy.io` is deliberately _not_ offered: it
403s benign domains, producing a failure that looks like your fault.

---

## The ad-free, chrome-free, full-quality path

For anything you actually care about looking good on the panel:

1. **Add it as a local clip** ([local-clips.md](local-clips.md)), or
2. **run the resolver companion** ([resolver-protocol.md](resolver-protocol.md)),
   which downloads the video into that same local library for you.

Both give you a plain `<video>` on bytes you own: no CORS, no player chrome, no
ads, real pause, silent seeks, and playback that keeps working with the network
switched off.
