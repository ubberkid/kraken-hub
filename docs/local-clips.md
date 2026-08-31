# Local clips — the download-first flow

The best-looking video on a Kraken LCD is a file that lives on your own machine.
No CORS, no player chrome, no ads, real pause, silent A‑B loop seams, and it
keeps playing with the network switched off.

So that is the **default** in kraken-hub, and it does not involve a file picker:

> **Paste a URL. kraken-hub downloads it into its own clip library and plays the
> local copy from then on.**

You paste it into the row under the halo on the home screen, and the app narrates
what it did in three cards: **YouTube video detected** (whatever it actually
recognised), **Saving to your Kraken** with a live percentage, and **On screen
now**. The point of writing it out is that this used to happen silently — the
single biggest thing kraken-hub does for picture quality was invisible.

Manual upload still exists, and it is documented below, but it is the fallback —
not the headline.

---

## How the download-first flow actually works

When you set a source URL, the display page (yes, the display — see
[Why the _display_ does the downloading](#why-the-display-does-the-downloading))
works through this list:

1. **Is it already a clip?** A `kraken-hub-clip:<id>` URL plays straight from
   IndexedDB.
2. **Have we downloaded this URL before?** If yes, play the stored copy. This
   check happens _before any network call_, which is what makes a cold boot with
   the network down still work.
3. **Is the resolver companion running?** If so — and the policy allows it —
   ask it for a plain file, then download _that_. See
   [resolver-protocol.md](resolver-protocol.md).
4. **Otherwise, can we fetch the bytes ourselves?** If the source is a single
   progressive file (not a manifest — see
   [HLS and DASH are never auto-downloaded](#hls-and-dash-are-never-auto-downloaded))
   and the server sends `Access-Control-Allow-Origin`, kraken-hub fetches it with
   a progress card on the panel and stores it.
5. **If not, stream it.** A CORS refusal is _not an error_: `fetch` cannot read
   plenty of files that `<video src>` plays perfectly well. kraken-hub silently
   falls back to streaming, records `download-cors-blocked` in the diagnostics
   log, and you see your video either way.

`downloadMode` controls steps 3–4:

| Setting              | Behaviour                                                            |
| -------------------- | -------------------------------------------------------------------- |
| **`auto`** (default) | Download and keep whenever the bytes are reachable _and are a file_. |
| `stream-only`        | Never store anything; always play from the remote URL.               |

### HLS and DASH are never auto-downloaded

"Reachable" means _a single progressive file_. An `.m3u8` or `.mpd` URL is a
**manifest**, not a video: fetching one and putting it in IndexedDB stores a
text playlist that points at hundreds of segments on a server you are about to
stop talking to. It would look like a successful download and then play nothing.

So `auto` covers exactly two shapes — a direct progressive file (`.mp4`,
`.webm`, …) and a `v.redd.it` rendition, which is a plain `DASH_<h>.mp4` file
despite the name. Everything else **streams**, with no warning and no error
card: HLS and DASH play perfectly well over the network, they just do not become
clips.

If you want a local copy of an HLS or DASH stream, that is what the
[resolver companion](resolver-protocol.md) is for. It runs `yt-dlp` on your own
machine, muxes the segments into one file, and serves that file back over
`127.0.0.1` — at which point the download-first flow above treats it like any
other progressive file and keeps it. The companion is the download path for
manifests, and for YouTube, for the same reason: something has to turn many
segments into one file, and a static web page cannot.

### Why the _display_ does the downloading

CAM opens two browser windows on the same origin: a visible **Configuration
Browser** and a hidden **Kraken Browser** that is streamed to the LCD. They share
one storage partition, which is what makes `localStorage` and IndexedDB work as
the config → display channel.

Your ordinary Chrome, and your phone, are **different browsers with entirely
separate storage partitions**. A blob written from the phone remote lands in
storage the Kraken Browser can never read.

So the display page downloads and stores the clip itself, headlessly, even when
the URL was set from your phone — with a low-entropy progress readout on the
panel while it works. There is no static-hosting workaround for this; it is how
browser storage is partitioned.

---

## Manual upload (the fallback)

**In CAM → Lighting → your Kraken → Configure**, then **Library** in the row
under the halo (`#/library`). Either drop files on the panel or use the picker.
Each file is:

1. **Checked for a container Chromium can play.** `.mkv`, `.mka`, `.avi`,
   `.flv`, `.wmv`, `.rmvb` are rejected — Chromium has no Matroska or AVI demuxer
   in `<video>`, and no library fixes that. See
   [the remux one-liner](#preparing-a-clip-the-one-liner) below.
2. **Feature-detected for codecs.** HEVC and AV1 are _warned_ about rather than
   rejected: HEVC in Chromium depends on GPU support with no software fallback,
   so the same file can play on one machine and fail on another.
3. **Probed** for duration and dimensions with an offscreen `<video>` (8 s
   timeout, with an "add anyway" escape).
4. **Thumbnailed** — a 320×320 cover-cropped WebP taken at 10 % in.
5. **Quota-checked** before a byte is kept.
6. **Stored** — bytes and metadata written in a single transaction, so a
   metadata row can never exist without its bytes.

**Upload must happen in CAM's Configuration Browser.** From the phone remote the
upload control is hidden entirely and replaced with an explanation, because a
clip added there would land in unreadable storage. The remote _can_ still select
clips that already exist: the display publishes its clip index (name, duration,
resolution, size — no thumbnails, they would blow the payload budget), and
picking one sets `kraken-hub-clip:<id>` as the source.

If the remote picks a clip this display does not have, the LCD shows a
`clip-missing` card and republishes its index.

---

## Preparing a clip: the one-liner

You are feeding a **640×640 round** screen. A 1920×1080 clip wastes about
two-thirds of its pixels and roughly three times the bitrate to show you the same
picture. Square-crop it first:

```bash
ffmpeg -i input.mp4 \
  -vf "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080,fps=30" \
  -c:v libx264 -profile:v high -crf 21 -pix_fmt yuv420p \
  -movflags +faststart -an output.mp4
```

Every flag there is load-bearing:

- `crop='min(iw,ih)':'min(iw,ih)'` takes the largest centred square, whatever the
  input aspect.
- `scale=1080:1080` is 1.69× the panel — enough supersampling to stay sharp under
  CAM's frame compression, without paying for pixels nobody sees.
- `fps=30` because the panel's ceiling is 40 and its _achieved_ rate is lower;
  60 fps source costs decode budget for frames that are dropped.
- `-pix_fmt yuv420p` is the format every Chromium build can decode.
- `+faststart` puts the `moov` atom at the front, which matters if you later host
  the same file and play it as a direct URL.
- **`-an` drops the audio.** The LCD is always muted. Audio is pure overhead.

To remux a `.mkv` without re-encoding (fast, lossless — the container is the
problem, not the video):

```bash
ffmpeg -i input.mkv -c copy output.mp4
```

## Content that survives compression

The Elite's capture pipeline **compresses every frame**, so achieved FPS varies
with what is on screen. This is not a resolution problem and raising the
resolution does not help. What helps:

- Flat colour areas and a limited palette.
- A mostly static frame with a small moving region.
- No film grain, no dithering, no rapid full-frame cuts.

A 30 fps 1080×1080 clip of a slow loop will hold a noticeably higher effective
frame rate than a 60 fps action scene at the same bitrate.

---

## Size, quota and persistence

**Recommended:** ≤ 200 MB per clip, ≤ 2 GB for the whole library.

kraken-hub reads `navigator.storage.estimate()` and refuses an add that would
push usage past 90 % of the quota, naming both numbers in megabytes. The Library
panel shows a usage bar.

On the first successful add — inside the user gesture, which is the only time the
browser will grant it — kraken-hub calls `navigator.storage.persist()` and shows
the result as a badge:

| Badge                   | Meaning                                           |
| ----------------------- | ------------------------------------------------- |
| **Persistent** (green)  | The browser has promised not to evict your clips. |
| **Best-effort** (amber) | Chromium may evict clips under disk pressure.     |

If persistence was not granted, kraken-hub asks again on each subsequent add.

**Blob URLs are reference-counted.** An adapter acquires one on mount and
releases it on teardown — _after_ the element has let go of the `src`, because
revoking while it is still referenced aborts the decode with a
`MEDIA_ELEMENT_ERROR` that looks exactly like a corrupt file. Everything is
released on `pagehide`. This matters more than it sounds: the Kraken Browser
document stays open for weeks, and one leaked object URL pins an entire video
blob in memory for that whole time.

---

## Where the data lives

| What                        | Where                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| Clip metadata and bytes     | IndexedDB database **`kraken-hub.v1`**, stores `clips` / `clipBlobs` |
| Clip index (for the remote) | `localStorage` key `kraken-hub:v1:video:clipIndex`                   |
| Download progress mirror    | `localStorage` key `kraken-hub:v1:video:downloads`                   |
| Diagnostics ring buffer     | `localStorage` key `kraken-hub:v1:video:log`                         |

Clip ids are random (`crypto.randomUUID()`), never derived from the filename.

Everything is namespaced `kraken-hub:v1:` because `<user>.github.io` is a single
origin shared across every repository that user publishes — an unnamespaced key
would collide with somebody's unrelated project.

There is **no service worker** in v1. A page that stays open for weeks plus
service-worker update semantics is a combination worth deferring, so the demo
clip is a bundled asset and offline playback comes from IndexedDB instead.
