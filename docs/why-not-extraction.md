# Why kraken-hub does not extract YouTube streams

**Short version:** we measured it. From a static origin like GitHub Pages,
YouTube stream extraction is not "difficult" or "against the terms" — it is
**physically non-functional**, in three independent ways, any one of which is
fatal on its own. So kraken-hub ships an oversized-iframe geometry trick instead,
and a local download path for people who want the real thing.

This page publishes the measurements, because a documented dead end is more
useful to the next person than a dead code path. Everything below was probed live
on **2026-08-30** from a residential IP with no cookies. Repro commands are
included; the _numbers_ will drift, but the _shapes_ are structural.

---

## The three walls

### Wall 1 — InnerTube enforces an Origin allowlist

YouTube's internal player API, `POST /youtubei/v1/player`, is what every
extraction library ultimately calls. It rejects any third-party browser origin
outright, before CORS is even relevant.

| `Origin` header sent                          | HTTP status |
| --------------------------------------------- | ----------- |
| _(none)_                                      | **200**     |
| `https://www.youtube.com`                     | **200**     |
| `https://foo.github.io`                       | **403**     |
| _(OPTIONS preflight, any third-party origin)_ | **403**     |

No `Access-Control-Allow-Origin` header appears on any of those responses. This
is an origin allowlist, not a CORS policy: a browser page on `<user>.github.io`
cannot make this call at all, and there is no header, mode or credential setting
that changes it.

```bash
# 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://www.youtube.com/youtubei/v1/player?key=...' \
  -H 'Content-Type: application/json' \
  --data '{"videoId":"dQw4w9WgXcQ","context":{"client":{"clientName":"ANDROID","clientVersion":"19.09.37"}}}'

# 403 — the only difference is the Origin header
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://www.youtube.com/youtubei/v1/player?key=...' \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://foo.github.io' \
  --data '{"videoId":"dQw4w9WgXcQ","context":{"client":{"clientName":"ANDROID","clientVersion":"19.09.37"}}}'
```

### Wall 2 — googlevideo sends no CORS headers, so MSE cannot fetch a byte

Suppose you got a stream URL anyway (from a server, from a friend, from a cached
response). Media Source Extensions — which is how dash.js, hls.js, shaka and any
hand-rolled `SourceBuffer` pipeline work — must `fetch` the media itself, and
`fetch` enforces CORS.

A ranged GET of a fresh 1080p (itag 137) `googlevideo.com` URL returns:

```
HTTP/2 206 Partial Content
Content-Type: video/mp4
X-Content-Type-Options: nosniff
Content-Range: bytes 0-2000/…
```

…and **no `Access-Control-Allow-Origin` header at all**, identically with and
without an `Origin` request header. The HLS playlists on
`manifest.googlevideo.com` behave the same way.

```bash
curl -sI -H 'Range: bytes=0-2000' -H 'Origin: https://foo.github.io' \
  '<a fresh itag-137 googlevideo URL>' | grep -i 'access-control\|content-range'
# → prints the content-range and nothing else
```

So adaptive playback from a third-party origin is impossible regardless of how
the URL was obtained.

### Wall 3 — the only no-CORS format left is 360p

A plain `<video src>` on a _muxed_ (single-file, audio+video) URL needs no CORS.
That is the one path CORS cannot block — and YouTube has almost entirely stopped
offering it.

| InnerTube client                 | `formats` (muxed)                                                      | `adaptiveFormats` |
| -------------------------------- | ---------------------------------------------------------------------- | ----------------- |
| `ANDROID`                        | **itag 18 @ 360p only**                                                | 144p – 2160p      |
| `IOS`                            | _key absent entirely_                                                  | 144p – 2160p      |
| `WEB`                            | UNPLAYABLE — "Video unavailable"                                       | —                 |
| `WEB_EMBEDDED_PLAYER`            | ERROR — "This video is unavailable"                                    | —                 |
| `TVHTML5_SIMPLY_EMBEDDED_PLAYER` | ERROR — "YouTube is no longer supported in this application or device" | —                 |

360p is 640×360. The centre crop for a 640×640 panel needs roughly **1140 px** of
source width to avoid upscaling. 360p is about **56 %** of that. So even a fully
working extraction pipeline could not reach the quality bar that motivated
building one.

Two further structural problems, for completeness:

- **Extracted URLs are IP-bound and expire.** Every segment URI in the HLS
  manifest embeds `/ip/<the exact requesting client IP>/` and
  `/expire/<unix ts>/` with roughly a 6-hour TTL. "Resolve at build time and
  commit the URL" is therefore also dead: the URL is useless to anybody else.
- **The web client is SABR-only.** YouTube no longer returns per-format links for
  `WEB`, only a `serverAbrStreamingUrl` carrying UMP-framed segments, and yt-dlp
  itself warns that "web client https formats require a GVS PO Token" — a token
  produced by YouTube's own obfuscated BotGuard JS running in a real browser.

---

## "Just use a public proxy" — the networks are gone

The usual escape hatch is an Invidious or Piped instance, which proxies the media
and adds CORS headers. Both public networks have collapsed.

### Invidious

`api.invidious.io/instances.json` lists **5** HTTPS instances, and **every one of
them advertises `"api": false`.** Probed with a browser `User-Agent` and an
`Origin` header:

| Instance                   | `/api/v1/videos/dQw4w9WgXcQ`                                                |
| -------------------------- | --------------------------------------------------------------------------- |
| `inv.nadeko.net`           | 403 — "Endpoint disabled"                                                   |
| `invidious.nerdvpn.de`     | 401 — nginx Authorization Required                                          |
| `invidious.tiekoetter.com` | 403                                                                         |
| `yewtu.be`                 | 403 (openresty)                                                             |
| `invidious.f5.si`          | 200, but the body is an Anubis "Making sure you're not a bot!" interstitial |

Historical instances (`iv.ggtyler.dev`, `invidious.jing.rocks`, `id.420129.xyz`,
`inv.us.projectsegfau.lt`) no longer resolve.

```bash
curl -s https://api.invidious.io/instances.json | jq -r '.[] | "\(.[0])\t\(.[1].api)"'
```

Invidious' own documentation explains the cause: "Invidious companion is trying
to create a valid PO Token against YouTube servers. But it fails to create a
valid one", and "It is known that YouTube block datacenter and VPN IP addresses."
The listed mitigations are IP rotation and proxies — an arms race, not a fix.

### Piped

Of the **16** instances in TeamPiped's official documentation, exactly **one**
answered: `api.piped.private.coffee`. It has excellent CORS
(`access-control-allow-origin: *`) and useless content:

| Field          | Value                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `videoStreams` | 3 — two LBRY/Odysee mirrors and one 360p MPEG-4 via the instance's proxy |
| `audioStreams` | **0**                                                                    |
| `hls` / `dash` | `null` / `null`                                                          |

The others returned 526, 502, redirects to homepages, or failed to connect.

Building on a one-instance network whose maximum quality is 360p and whose audio
stream count is zero would produce an app that is broken on arrival and degrades
from there.

### The rest of the field

- **youtubei.js** states plainly: "To use YouTube.js in the browser, you must
  proxy requests through your own server." Its browser guide now carries a
  deprecation notice.
- **kira** (the SABR/Shaka demo) relies on a browser _extension_ to bypass CORS on
  desktop and needs a proxy on mobile. Not deployable as a static page.
- **cobalt** is off the table by policy: "Hosted API instances … are not intended
  to be used in other projects without explicit permission," enforced with
  Cloudflare Turnstile and API keys.

---

## What we built instead

The same research produced the fix, and it is a single geometry move.

CSS cannot hide a cross-origin player's chrome, and a `transform: scale()` on a
parent does **not** shrink the iframe's internal layout viewport — inside the
frame, the player still measures its own `width`/`height` attributes. Both facts
point the same way: **make the iframe big and square.**

At 1920×1920, the YouTube player letterboxes a 16:9 video into the vertical
middle. The video occupies `y ∈ [420, 1500]`; the title overlay, watermark and
control strip land on the black bars _outside_ that band. Crop the centre
1080×1080 and scale it to the panel:

```
width: 1920px; height: 1920px;
transform-origin: 0 0;
transform: translate(-248.889px, -248.889px) scale(0.5925926);
```

Two problems, one move: the chrome is cropped away, and the 1920 px measured
width is what makes YouTube serve ~1080p instead of the ~360p a 640×640 iframe
gets. The invariant `tx = ty = −0.388889 × displayW` holds for 16:9 in a square
element at zoom 1 regardless of the element size — 640 → −248.889 px, 320 →
−124.444 px, 240 → −93.333 px.

The full derivation, the ladder (1280/1600/1920/2560), the portrait variant and
the quality watchdog are in
[`design/design-videoEngine.md` §2](design/design-videoEngine.md).

**Honest limitation:** ads render inside the video rect, so the crop cannot
remove them. See [providers.md](providers.md#youtube-sharp-chrome-free-and-still-not-ad-free).

## And the path that is genuinely perfect

Extraction is impossible **in a browser page**. It is entirely possible on **your
own machine**, which is where yt-dlp already lives and where you already have the
right to keep a copy of something for yourself.

So kraken-hub's featured flow is: paste a URL → the app downloads the bytes into
its own clip library → it plays the local copy from then on. For direct,
CORS-reachable links the app does that alone. For YouTube it asks an **optional**
companion running on `127.0.0.1` — see
[resolver-protocol.md](resolver-protocol.md) — which is the only path that is
physically possible, and which puts the download on the user's machine at the
user's request.

The web app never bundles, hosts, proxies or ships extracted media, and it
remains fully functional with no companion installed.

---

## Sources

Live probes run 2026-08-30 and recorded in
[`design/research/research-youtubePlayback.md`](design/research/research-youtubePlayback.md),
alongside:

- [YouTube IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference)
  — `getPlaybackQuality`, `setPlaybackQuality` and `getAvailableQualityLevels`
  are documented as no-ops, and `suggestedQuality` "will be ignored".
- [YouTube player parameters](https://developers.google.com/youtube/player_parameters)
  — `modestbranding` is "deprecated and has no effect"; `showinfo` was removed in 2018. Neither hides the title overlay.
- [yt-dlp #12482](https://github.com/yt-dlp/yt-dlp/issues/12482) and
  [#13515](https://github.com/yt-dlp/yt-dlp/pull/13515) — SABR and PO tokens.
- [docs.invidious.io — YouTube errors explained](https://docs.invidious.io/youtube-errors-explained/)
- [EFF: GitHub reinstates youtube-dl](https://www.eff.org/deeplinks/2020/11/github-reinstates-youtube-dl-after-riaas-abuse-dmca)
  — for the record, hosting extraction _code_ is broadly tolerated. The reason we
  do not ship it is that it does not work.
