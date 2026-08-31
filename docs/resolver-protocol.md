# The resolver companion — protocol v1 (frozen)

The resolver is a small program you run on your own PC. kraken-hub asks it for a
plain video file on `127.0.0.1`, downloads that into its local clip library, and
then plays the clip forever — ad-free, chrome-free, at full quality, and with the
companion switched off.

**It is optional, and it is optional in the strongest sense.** The web app
health-checks it once, silently. If it is not there, YouTube falls back to the
geometry engine and everything else falls back to streaming, with no error, no
banner and nothing for the user to dismiss. A resolver miss is never a visible
failure.

This document is the **frozen v1 wire contract**. The TypeScript form is
[`src/modules/video/resolver/resolverTypes.ts`](../src/modules/video/resolver/resolverTypes.ts);
they are kept in sync deliberately, and anything added after v1 must be
_additive and optional_ so that a v1 client keeps working against a v2 companion
and vice versa.

> **The reference implementation ships in [`companion/resolver`](../companion/resolver/README.md)**
> — an npm workspace in this repo, shipped to end users as a single standalone
> Windows executable
> ([download](https://github.com/ubberkid/kraken-hub/releases/latest/download/kraken-hub-resolver-win-x64.exe)),
> and run from a clone everywhere else. The contract was frozen before either side was
> written, precisely so that the two could be built independently — and so that
> anyone else can write a compatible companion. Its test suite runs the real
> server against the web app's own parsers, imported across the workspace, so
> the two halves cannot drift.

---

## 1. Base URL and transport

```
http://127.0.0.1:<port>          default port 8976
```

`http://127.0.0.1` and `http://localhost` are _potentially trustworthy origins_
and are therefore **exempt from Chromium's mixed-content blocking**, even though
kraken-hub itself is served over HTTPS. This is the entire reason the design
works from a static site.

`http://<LAN-IP>` is **not** exempt. The config UI rejects any non-loopback
resolver host, and so does the client — see
[§5, Security posture](#5-security-posture).

## 2. Endpoints

### `GET /health`

```http
200 OK
Content-Type: application/json

{
  "ok": true,
  "name": "kraken-hub-resolver",
  "version": "1.0.0",
  "api": 1,
  "capabilities": ["resolve", "stream", "probe"],
  "maxHeight": 2160
}
```

`api` is the contract revision, not the program version. A client that speaks
`api: 1` treats any other value as "not compatible" and falls back silently.

The client gives this call **1.2 seconds** and memoizes the answer for **60
seconds**, in memory and in `sessionStorage`, so a mount never pays the probe
twice and the other CAM window does not pay it either.

### `GET /resolve`

```
GET /resolve?url=<encoded>&maxHeight=1080&prefer=progressive&audio=0[&token=…]
```

| Parameter   | Meaning                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `url`       | The page URL the user pasted. Percent-encoded.                                                                                |
| `maxHeight` | The tallest rendition worth producing. See [§4](#4-how-the-client-chooses-maxheight).                                         |
| `prefer`    | `progressive` (default) or `any`. Progressive is a single muxed file — the cheapest thing for the client to play and to keep. |
| `audio`     | `0` or `1`. The Kraken display is always muted, so this is `0` unless the user opted audio in.                                |
| `token`     | Optional shared secret; see [§5](#5-security-posture). May also travel as `X-Krakenhub-Token`.                                |

**Success:**

```http
200 OK

{
  "status": "ok",
  "kind": "progressive" | "hls" | "dash" | "file",
  "streamUrl": "http://127.0.0.1:8976/stream/<opaque>.mp4",
  "mime": "video/mp4",
  "width": 1920, "height": 1080, "fps": 30,
  "durationSec": 213.4,
  "title": "…",
  "thumbUrl": "http://127.0.0.1:8976/thumb/<opaque>.jpg",
  "expiresAt": 1788150000
}
```

Only `status`, `kind` and `streamUrl` are required; `mime` defaults to
`video/mp4`. Everything else is advisory — the client uses `title` to name the
stored clip and `height` for telemetry, and works without either.

**Still working:**

```http
202 Accepted

{ "status": "pending", "jobId": "…", "retryAfterMs": 1500 }
```

This is the **normal** answer while yt-dlp is still downloading, and it is not an
error. The client polls `GET /job/<jobId>` at `retryAfterMs` (clamped to
250–5000 ms) until the envelope settles, giving up after **60 seconds** total.

**Failure:**

```http
400  { "status": "error", "code": "unsupported-url", "message": "…" }
404  { "status": "error", "code": "not-found",       "message": "…" }
429  { "status": "error", "code": "rate-limited",    "retryAfterMs": 5000 }
502  { "status": "error", "code": "upstream-failed", "message": "yt-dlp: …" }
```

`code` is a **closed enum**:

```
unsupported-url | not-found | upstream-failed | rate-limited | forbidden | internal
```

A companion must not invent codes. A client that receives an unrecognised one
maps it to `internal` rather than surfacing it, so an unknown string can never
reach a user-facing message.

### `GET /job/<jobId>`

Returns the same envelope as `/resolve`: `ok`, `pending` again, or `error`.

### `GET /stream/<opaque>.mp4`

The media. **Range support is mandatory** (`200` or `206`), because seeking — and
therefore A‑B looping — depends on it.

`<opaque>` is a token the companion minted for a specific resolve, with a TTL.
It is not a URL the caller supplies: the companion must never behave as a general
HTTP proxy.

### `GET /thumb/<opaque>.jpg`

Optional. Advertise it in `capabilities` if you serve it.

## 3. CORS — required on every endpoint

On **every** response, `/stream` and `/thumb` included:

```
Access-Control-Allow-Origin: *            (or echo the configured origin)
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Range, Content-Type, X-Krakenhub-Token
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges
Accept-Ranges: bytes
```

`OPTIONS` must answer `204` with those headers.

A plain `<video src>` on a progressive file would not strictly need CORS. Two
things do: `hls`/`dash` go through MSE, which fetches every segment itself; and —
the important one — kraken-hub **fetches the stream into IndexedDB**, which is
what makes the clip outlive the companion. So the spec mandates CORS uniformly.

## 4. How the client chooses `maxHeight`

```
maxHeight = clamp(ceil(max(displayW, displayH) × dpr × zoom × 1.25), 480, 2160)
```

then snapped **up** onto the delivery ladder `480 / 720 / 1080 / 1440 / 2160`.

For a Kraken Elite at DPR 1 and zoom 1 that computes 800 and asks for **1080** —
never 2160. Transcoding 4K for a 640×640 panel costs the user minutes of CPU and
gigabytes of disk to produce pixels the panel physically cannot show.

## 5. Security posture

Read this part before you install anything.

**Installing a resolver companion means any website you visit can ask your
machine to download a video.** That is the honest framing: it is a machine-local
capability granted to every page in your browser, not a kraken-hub feature. The
mitigations below exist because that is true, not to make it sound smaller.

- **Bind `127.0.0.1` only.** Never `0.0.0.0`. A companion on a LAN address is a
  download service for everyone on the network.
- **The client enforces loopback too.** `isLoopbackBase()` refuses anything that
  is not `127.0.0.1`, `localhost` or `[::1]`, and refuses it before a byte leaves
  the page.
- **Optional shared token,** via `?token=` or `X-Krakenhub-Token`, configured in
  the panel. Part of the frozen contract from day one so that turning it on later
  needs no protocol change. v1 ships with no token by default.
- **Refuse `file://`, `data:` and local filesystem paths** in `url=`. Return
  `403 forbidden`.
- **Never be a general proxy.** `/stream/<opaque>` serves only tokens the
  companion minted, with a TTL.
- **Rate-limit** (about 10 resolves/minute) and cap concurrent extractor
  processes at 2.
- Ship it **opt-in and source-available**, with the port configurable.

## 6. Companion behaviour contract

What [`companion/resolver/`](../companion/resolver/README.md) does — stated here
so an independent implementation can match it:

- **Node ≥ 20 CLI**, Windows/macOS/Linux. CAM is a Windows application, so
  Windows is a first-class target, not a port — and it is the only platform that
  gets a prebuilt artifact: a single standalone `.exe` with the Node runtime
  inside it, so a user needs no toolchain. Elsewhere the CLI is run from a clone.
  (Nothing in this contract depends on how the companion is packaged.)
- Wraps **yt-dlp**, preferring `--yt-dlp <path>`, then a working copy on `PATH`,
  and only then auto-downloading the platform binary **with checksum
  verification**.
- Uses **ffmpeg** to mux when only adaptive formats exist; when ffmpeg is absent,
  serves the best _progressive_ format ≤ `maxHeight` rather than failing.
- Answers **202 + `/job` polling** while a download is in flight — never blocks a
  request for minutes.
- **LRU disk cache**, default 4 GB, in the OS cache directory, with eviction.
- Flags: `--port`, `--cache-dir`, `--token`, plus `--max-cache-gb`,
  `--max-height`, `--yt-dlp`, `--ffmpeg`, `--log-level`. Two further flags are
  packaging, not protocol: `--install-autostart` / `--uninstall-autostart`
  (Windows only) manage a per-user `HKCU` Run entry and exit without listening.
- Maps every failure onto the closed error enum above.

**Status: shipped.** All of it is verified by
`companion/resolver/test/**` (the real HTTP server on an ephemeral port with the
extractor injected, asserted against the web app's own `parseEnvelope` /
`parseHealth` imported across the workspace — including Range, 416, CORS on every
route and error, the token, the URL refusals, rate limiting, and LRU eviction)
and by [`tests/e2e/companion.spec.ts`](../tests/e2e/companion.spec.ts), which
spawns the _compiled_ companion as its own process and proves the two product
claims: a YouTube URL downloads into the IndexedDB clip library with progress and
**keeps playing after the companion process is killed and the page reloaded**,
and killing the companion mid-download degrades to the geometry engine with no
error card. No test in either suite contacts the network.

## 7. Writing your own

The contract is the whole interface. If your program answers `/health`,
`/resolve`, `/job/<id>` and `/stream/<opaque>` as specified above, with the CORS
headers from §3 and Range support, kraken-hub will use it — it has no idea what
is behind it, and no interest.

Reasonable things to put behind it: your own media server, a NAS index, a
transcoder, a rendering pipeline. The resolver is not YouTube-shaped; it is
"give me a plain file for this identifier"-shaped.

The e2e test at
[`tests/e2e/resolver.spec.ts`](../tests/e2e/resolver.spec.ts) is a complete,
readable, ~120-line reference server implementing §2 and §3, including the 202 →
`/job` flow and Range. It is a good place to start. When you want the full
version — job queue, cache, URL policy, verified binary —
[`companion/resolver/src/`](../companion/resolver/src/) is about 1,200 lines with
no runtime dependencies at all.

## 8. What the web app never does

kraken-hub itself never bundles, hosts, proxies or ships extracted media, and it
never contacts a third-party extraction service. Every byte a companion produces
is produced on the user's own machine, at the user's own request, from a URL the
user pasted. The app is fully functional with no companion installed — see
[why-not-extraction.md](why-not-extraction.md) for the measurements behind that
design.
