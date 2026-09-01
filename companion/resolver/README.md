# kraken-hub-resolver

The optional companion for [kraken-hub](../../README.md). It runs on your own PC,
turns a page URL into a plain video file on `127.0.0.1`, and lets the app
download that file into its own clip library — so a YouTube link ends up as a
local clip that plays ad-free, chrome-free, at full quality, **with the companion
switched off**.

It is the reference implementation of the frozen v1 wire contract in
[`docs/resolver-protocol.md`](../../docs/resolver-protocol.md). Anything that
answers those four endpoints works just as well; kraken-hub has no idea what is
behind them.

---

## Run it

### Windows — the standalone exe

**[kraken-hub-resolver-win-x64.exe](https://github.com/ubberkid/kraken-hub/releases/latest/download/kraken-hub-resolver-win-x64.exe)** — download, double-click, done.

That is the whole install. It is a single file with the Node runtime baked into
it, so nothing else has to be present on the machine. It binds
`http://127.0.0.1:8976`, and the app finds it by itself: kraken-hub health-checks
the port once, silently, and starts routing YouTube links through it. Nothing to
paste, nothing to configure.

Windows SmartScreen will warn about an unrecognised app the first time, because
the build is not code-signed — **More info → Run anyway**. The exe is built and
smoke-tested in public CI ([`.github/workflows/companion-release.yml`](../../.github/workflows/companion-release.yml));
if you would rather not trust a binary, build your own with `npm run build:sea`.

Closing the window stops the companion. To start it at logon instead:

```
kraken-hub-resolver-win-x64.exe --install-autostart
kraken-hub-resolver-win-x64.exe --uninstall-autostart
```

That writes (and removes) one `REG_SZ` value under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, pointing at the exe you ran
it from. `HKCU` is your own hive, so it never asks for administrator rights, and
it is the same key you can inspect in `regedit` yourself. Autostart is Windows
only — CAM is a Windows product, and on macOS or Linux the flag prints a note and
does nothing.

### macOS, Linux, or from a clone

There is no prebuilt binary for other platforms and **no `npx` install**: the
package is not published to npm today. That may change later; until it does, run
it from a clone:

```bash
npm install
npm run build:companion
node companion/resolver/dist/cli.js
```

Or build the same kind of standalone binary for your own platform:

```bash
npm run build:sea --workspace kraken-hub-resolver   # → companion/resolver/build/sea/
npm run smoke:sea --workspace kraken-hub-resolver   # starts it and drives the v1 protocol
```

**Requirements (from a clone):** Node ≥ 20. The exe needs nothing at all. `yt-dlp` is found in this order: an explicit
`--yt-dlp <path>`, then a working `yt-dlp` on your `PATH` (probed with
`--version`), then a previously auto-downloaded copy, then a checksum-verified
download (see below).

`ffmpeg` is found the same way: `--ffmpeg <path>`, then a working `ffmpeg` on
`PATH`, then a cached copy, and **on Windows** a checksum-verified download from
the [yt-dlp FFmpeg-Builds][ffbuilds] release. On macOS and Linux there is no
auto-download: a package manager (`brew install ffmpeg`, or your distro's) is
both the expected route and the better one, because a system package keeps
getting security updates and a blob in a cache directory does not.

**ffmpeg is not required, and a missing one never fails a resolve.** It is worth
having anyway. YouTube publishes no combined video+audio format for most uploads
— separate video-only and audio-only streams and nothing else — so joining them
is the only way past whatever single file happens to exist. With ffmpeg you get
the best rendition ≤ `maxHeight`, with sound. Without it you get the best single
file, which is usually a silent video-only stream at full resolution, and
occasionally a low-resolution one. The companion reports the height it actually
got, so the app can show you which you have.

[ffbuilds]: https://github.com/yt-dlp/FFmpeg-Builds

## Flags

| Flag                 | Default               | What it does                                                    |
| -------------------- | --------------------- | --------------------------------------------------------------- |
| `--port <n>`         | `8976`                | Port on `127.0.0.1`. `0` asks the kernel for a free one.        |
| `--cache-dir <path>` | OS cache directory    | Where downloaded clips live.                                    |
| `--max-cache-gb <n>` | `4`                   | Eviction ceiling. Least-recently-**read** clips go first.       |
| `--token <secret>`   | none                  | Require `?token=` / `X-Krakenhub-Token` on every request.       |
| `--max-height <n>`   | `2160`                | The tallest rendition this companion will ever produce.         |
| `--yt-dlp <path>`    | `PATH`, else download | Use a specific yt-dlp. Otherwise `PATH` wins over the download. |
| `--ffmpeg <path>`    | `PATH`, else download | Use a specific ffmpeg for muxing. Windows auto-downloads one.   |
| `--log-level <l>`    | `info`                | `silent` \| `error` \| `warn` \| `info` \| `debug`.             |

Plus two Windows-only actions that do not start the server:
`--install-autostart` and `--uninstall-autostart` (see above).

The default cache directory is `~/Library/Caches/kraken-hub-resolver` on macOS,
`%LOCALAPPDATA%\kraken-hub-resolver\Cache` on Windows and
`$XDG_CACHE_HOME/kraken-hub-resolver` (or `~/.cache/…`) on Linux.

`--token` can also be given as `KRAKEN_HUB_RESOLVER_TOKEN`, which keeps the
secret out of the process list.

## What installing this means — read this part

**Any website you visit can ask a running companion to download a video.** That
is the honest framing. It is a machine-local capability you have granted to every
page in your browser, not a kraken-hub feature, and the mitigations below exist
because that is true — not to make it sound smaller.

- **It binds `127.0.0.1` only.** Never `0.0.0.0`, and there is no flag to change
  that. A companion on a LAN address is a download service for everyone on the
  network.
- **It refuses to look at your machine or your network.** `file:`, `data:`,
  `blob:`, `javascript:` and `ftp:` targets are `403`, and so is any `https://`
  URL pointing at loopback, `10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`,
  `100.64–127.x` or a `.local` name. Only public `https:` pages are accepted.
- **It is never a general proxy.** `/stream/<opaque>` serves only ids this
  process minted — 16 random bytes per resolve, with a TTL. There is no way to
  hand it a URL and have it fetch that URL for you.
- **It is rate-limited** to 10 resolves a minute per caller and never runs more
  than 2 extractor processes at once.
- **Every binary it installs is checksum-verified.** Your own `PATH` install is
  preferred and used as-is; only when there is none does the companion download
  the platform asset from the official GitHub release _together with_ that release's
  checksum manifest, and refuses to install a byte that does not match. That is
  yt-dlp's `SHA2-256SUMS`, and — on Windows only — FFmpeg-Builds'
  `checksums.sha256`. The ffmpeg archive gets a second check on the way out: each
  file's CRC and declared length are verified as it is unpacked, so a partially
  extracted executable is an error rather than a broken exe. Auto-download is
  skipped entirely when `CI` or `KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1` is set — the
  test suite has never contacted the network and never will.
- **`--token` closes it off completely** if you want it closed. When set, every
  endpoint demands the token, and the minted `streamUrl` carries it so the app
  keeps working unchanged.

If none of that is a trade you want to make, do not install it. kraken-hub is
fully functional without a companion — YouTube falls back to the geometry engine
and everything else streams, with no error and nothing to dismiss.

## Endpoints

```
GET  /health                 200 { ok, name, version, api, capabilities, maxHeight }
GET  /resolve?url=&maxHeight=&prefer=&audio=[&token=]
                             200 { status:'ok', kind, streamUrl, mime, … }
                             202 { status:'pending', jobId, retryAfterMs }
                             4xx { status:'error', code, message?, retryAfterMs? }
GET  /job/<jobId>            the same envelope as /resolve
GET  /stream/<opaque>.mp4    200 / 206, Range required, CORS
GET  /thumb/<opaque>.jpg     200 / 404, CORS
OPTIONS *                    204
```

`code` is a closed enum — `unsupported-url | not-found | upstream-failed |
rate-limited | forbidden | internal` — and this companion never invents another.
The full contract, including the mandated CORS header set, is
[`docs/resolver-protocol.md`](../../docs/resolver-protocol.md).

## Troubleshooting

**The app says no companion was detected.**
Check it is actually listening: `curl http://127.0.0.1:8976/health`. If that
works but the app disagrees, the port in the app's video settings does not match
`--port`. The app checks once and memoizes the answer for 60 seconds, so give it
a moment or reload the display.

**`yt-dlp is not installed and auto-download is disabled`.**
There is no `yt-dlp` on your `PATH` and you are running with `CI` or
`KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1` in the environment. Install yt-dlp — putting
it on `PATH` is enough — or point at it: `--yt-dlp /path/to/yt-dlp`.

**`Requested format is not available`, or "that source offers no format this
companion can use".**
Update the companion first — versions before this fix asked yt-dlp for a format
that carries video _and_ audio in one file, and YouTube has stopped publishing
one for most uploads, so the request matched nothing and failed outright. The
current ladder always falls back to a single-file format instead. If you still
see it after updating, the source genuinely has no video stream yt-dlp can read
(a live stream that has not started, a members-only upload, or a page that is not
a video at all). Installing ffmpeg is the fix worth doing either way: it is what
lets the companion join separate video and audio streams instead of settling for
whatever single file exists.

**The video has no sound.**
There is no ffmpeg on this machine, so the companion took the best _single_
format — and on YouTube that is usually a video-only stream. Put `ffmpeg` on your
`PATH` (`brew install ffmpeg`, `apt install ffmpeg`, `winget install ffmpeg`) or
pass `--ffmpeg <path>`; on Windows the companion will fetch one for itself if you
do neither. Note that the Kraken panel has no speaker, so this only matters if
you are asking for audio (`audio=1`) on purpose.

**Everything resolves, but the video is only 720p.**
That is deliberate. The app asks for the smallest rung of the delivery ladder
that covers its panel — a 640×640 Kraken Elite asks for 1080, never 2160.
Transcoding 4K for that panel costs minutes of CPU to produce pixels it cannot
show.

**`upstream-failed` on a site that works in the browser.**
Usually an out-of-date extractor. If it came from `PATH`, update it there
(`yt-dlp -U`, or your package manager). Otherwise delete the cached binary
(`<cache-dir>/bin/yt-dlp*`) and restart to fetch the current release, or pass a
`--yt-dlp` you keep updated yourself.

**`could not install ffmpeg … continuing without it, at reduced quality`.**
A warning, not an error — the resolve went through. GitHub was unreachable, or
the download did not match its published digest, so the companion refused it and
fell back to single-file formats. Retry later, or install ffmpeg yourself and put
it on `PATH`. To force a fresh attempt, delete `<cache-dir>/bin/ffmpeg*`.

**Downloads stop after a while.**
The cache is capped (`--max-cache-gb`, 4 GB by default) and evicts the
least-recently-read clip. Clips the app has already copied into its own IndexedDB
library are unaffected — that copy is what makes them permanent.

## Development

```bash
npm run check --workspace kraken-hub-resolver   # typecheck + lint + tests + build
```

The tests run the real HTTP server on an ephemeral port with the extractor
injected as a stub, and assert every response against the **web app's own**
parsers, imported across the workspace. There is no network access anywhere in
the suite.

MIT, like the rest of kraken-hub.
