# Local clips — the download-first flow

The best-looking video on a Kraken LCD is a file that lives on your own machine.
No CORS, no player chrome, no ads, real pause, silent A‑B loop seams, and it
keeps playing with the network switched off.

So that is the **default** in kraken-hub, and it does not involve a file picker:

> **Paste a URL. kraken-hub downloads it into its own clip library and plays the
> local copy from then on.**

You paste it into the row under the halo on the home screen, and the app narrates
what it did in three cards: **YouTube video detected** (whatever it actually
recognised), **Keeping a copy** with a live percentage, and **On screen
now**. The point of writing it out is that this used to happen silently — the
single biggest thing kraken-hub does for picture quality was invisible.

Manual upload still exists, and it is documented below, but it is the fallback —
not the headline.

---

## The Library page

**In CAM → Lighting → your Kraken → your kraken-hub card → Configure**, then **Library** in the row
under the halo (`#/library`). Every sub-page carries a **‹ Your Kraken** link in
its top-left corner, which is how you get back — CAM's Configuration Browser has
no back button of its own.

The page is **one grid of what you have**: clips and pictures together, each tile
badged with its kind and carrying the real stored metadata (duration, the
dimensions the file actually is, its size on disk). The tile that is currently on
the panel is marked **On screen**. Hovering or focusing a tile reveals **Pin** and
**Delete**; clicking the tile itself puts it on the panel. A compact usage bar
sits under the grid.

**A download in progress is a tile in that same grid**, with its percentage drawn
over the space its thumbnail is about to occupy and a **Cancel** next to it. When
it finishes it becomes an ordinary tile _in the same slot_ — there is no separate
"downloading" section for it to move out of. If the copy could not be kept, the
tile says so in plain words and offers **Retry** and **Dismiss**; the video is
playing either way (see [step 5 below](#how-the-download-first-flow-actually-works)).

### Adding things: **Add**

One button, top right, opens one add surface:

- **Paste a link** into the single input and press **Add**. It travels exactly the
  route a link pasted on the home screen does — the same validation (including
  the `http:` → `https:` upgrade) and the same `downloadMode` — so your Kraken
  fetches it and the progress appears on its tile.
- **Drop a file anywhere on the panel**, or press **Browse…** for a picker. The
  file is ingested by this window, because the bytes are already here.

That is the whole of it. There is no separate "paste a URL" section and no
separate "add a file by hand" section any more: they were two boxes to aim at for
one intention.

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

In the UI it is the **On this PC** row in the video and image options — tap the
chip that is already active to open them.

| Setting              | Shown as        | Behaviour                                                            |
| -------------------- | --------------- | -------------------------------------------------------------------- |
| **`auto`** (default) | **Keep a copy** | Download and keep whenever the bytes are reachable _and are a file_. |
| `stream-only`        | **Stream only** | Never store anything; always play from the remote URL.               |

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

On Windows that is one file to download and double-click —
[kraken-hub-resolver-win-x64.exe](https://github.com/ubberkid/kraken-hub/releases/latest/download/kraken-hub-resolver-win-x64.exe),
with no Node and no installer; [getting-started.md](getting-started.md#step-5--optional-ad-free-full-quality-youtube)
has the SmartScreen and autostart notes. On macOS and Linux you run it from a
clone (`npm install && npm run build:companion && node companion/resolver/dist/cli.js`).
There is no `npx` install: the package is not on npm today.

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

**Library → Add → Browse…**, or drop the files onto the add panel. Each file is:

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

**Adding a clip must happen in CAM's Configuration Browser.** The phone remote
has no upload control and no clip picker at all: a clip added from the phone
would land in storage the LCD cannot read, and round 2's audit deleted the
picker along with the rest of the remote's duplicate copy of the app. The
remote's job is to drive what is already on the panel. A source the display
cannot find still gets a `clip-missing` card on the LCD, which is the same
message the local-clip validator produces.

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
page shows a usage bar under the grid.

On the first successful add — inside the user gesture, which is the only time the
browser will grant it — kraken-hub calls `navigator.storage.persist()` and shows
the result as a badge:

| Chip                                                                  | Meaning                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| **Kept for good**                                                     | The browser has promised not to evict your clips. |
| **May be cleared if the disk fills up — pin the ones you care about** | Chromium may evict clips under disk pressure.     |

The warning chip is drawn only when it is actionable — once something is
actually stored, or once the quota is genuinely under pressure. On an empty
library there is nothing to pin and nothing to lose.

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
