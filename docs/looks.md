# Looks

A **Look** is one saved arrangement on the panel: what is showing, in what
order, at what size. The Kraken shows one Look at a time.

A Look is made of **layers**. The bottom one — the **base** — fills the panel: a
video, an effect, a picture, a clock face. Everything above it is an **overlay**
sitting in its own box: a temperature strip along the bottom, a line of text, a
ring. Up to eight layers in all.

Looks are files. A Look is a few kilobytes of JSON, it travels in an email or a
pull request, and it never carries a single byte of video.

**Contents**

1. [The Looks menu](#the-looks-menu)
2. [Templates](#templates)
3. [Saving a Look](#saving-a-look)
4. [The file](#the-file)
5. [Importing, and what happens to the pictures](#importing-and-what-happens-to-the-pictures)
6. [The Gallery](#the-gallery)
7. [The carousel](#the-carousel)
8. [Sharing yours](#sharing-yours)
9. [What is not here yet](#what-is-not-here-yet)

---

## The Looks menu

The Look's name sits at the top left of the editor, with a **▾** beside it.
Pressing it offers two things: rename the Look you are on, and **Looks…**, which
opens the sheet where everything below lives — **Templates**, **Your Looks**,
the **Gallery** and the **Carousel**, behind one row of buttons.

The sheet stands in the **rail's column**, on the right, exactly where the add
sheet and the inspector stand. It never covers the halo, and that is the point:
the halo is the one thing on the screen that shows what a Look looks like, and
it cross-fades to whatever card you press while the sheet is still open. The
cards scroll inside the sheet's own body — the page itself does not grow by so
much as a pixel when you open it.

Every card in that sheet is the Look **running**. Not a screenshot: the same
compositor that draws the panel, with the same layers and the same live
readings, shrunk to a thumbnail. Two things keep a grid of those from costing
more than it is worth, and both are deliberate:

- **Six at a time.** A card starts when it scrolls into view and stops when it
  leaves; six may be live at once and the rest draw a still frame. What you are
  looking at is alive; what you are not, is not.
- **The effect LAYER is always a still frame — the rest of the card is not.**
  Effects are drawn by the graphics card, one context each, and a browser allows
  a page only a handful; a grid that opened one per card would take the context
  away from the canvas you are editing on. So the effect paints the same still
  it shows before it has loaded — your own colours, as a ramp — and everything
  else in the Look composites over that ramp exactly as it does on the panel.
  The clock in _Nebula clock_ is a real clock, telling the real time, over a
  still nebula.

Applying a Look from any of the groups is **one press and one undo step**. The
canvas cross-fades over 350 ms, the header takes the new Look's name, and
**Ctrl/Cmd-Z** puts back exactly what was there — arrangement and settings
together, because a Look is both.

If the Look references a picture or a clip this machine does not have, the rest
of it is applied anyway and you get a card naming the file that is missing. The
Look you asked for, with an honest hole in it.

## Templates

**Templates** are the Looks that ship with the app. Ten of them, and each is a
real Look file rather than a special case — the app applies a template through
exactly the code path a Look you drag in takes.

The first three also appear **on the home screen the first time you open the
app**, under the "Add to CAM" band, so that the first thing you can do is press
one and watch the panel change rather than work through an installation errand
first. They are the same cards, running the same previews, and pressing one is
the same single undo step. Once a Kraken has published anything to this browser
they are gone from there and live only in the sheet.

| Template                | What it is                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| **Single**              | One reading, as large as the panel will draw it, inside a thin arc.      |
| **Dual**                | Two readings on one ring, as mirrored half-arcs.                         |
| **Triple**              | Three concentric rings around a small centre reading.                    |
| **Overlay**             | A strip of three compact meters along the bottom of a moving background. |
| **Lava lamp + temps**   | A lava lamp that warms with the loop, with the temperatures over it.     |
| **Nebula clock**        | A slow nebula behind the time.                                           |
| **Minimal clock**       | The time, and nothing else.                                              |
| **Sunset loop + clock** | A looping clip with the time over it.                                    |
| **Photo + date**        | A picture with the date and time along the bottom.                       |
| **Focus**               | One word inside a ring, on a gradient that barely moves.                 |

Two of them — _Sunset loop + clock_ and _Photo + date_ — ship with **no source**.
The repository contains no video and no photograph, and a template pointing at
somebody's server is a template that breaks when the link rots. The arrangement
is the gift; you pick the clip.

## Saving a Look

**Save as…** asks what to call it — a field in the sheet's own footer, not a
browser dialog — and keeps the arrangement you are working on under that name.
If the Look already has a name the field opens with it, so re-saving is a press
and **Enter**; an empty name is refused rather than filled in for you, because
two Looks both called "Untitled look" are two Looks you cannot tell apart.

It appears under **Your Looks**, where you can rename it, duplicate it, mark it
a favourite (favourites sort to the front), drag it into the order you want,
export it as a file, or delete it — deleting asks twice, and nothing else does.

Two honest limits:

- **Fifty.** That is as many as the shelf holds at once. Past that, the answer
  is a folder of exported files, which has no limit at all, and the app says so
  rather than quietly dropping the oldest one.
- **They live in this browser profile**, not in the document your Kraken reads.
  A shelf of fifty complete arrangements would be a hundred kilobytes on an
  8 kB sync envelope describing panels nobody is looking at. So they do not
  follow you to another machine — export one, and it is a file that does.

## The file

The extension is `.krakenlook`, and the file is named after the Look: exporting
one called _Slow tide_ hands your browser `Slow tide.krakenlook`. Anything a file
system would object to is dropped from the name rather than the whole name being
replaced, and a Look with no name at all gets `look.krakenlook`. Importing goes
the other way — the file's own name becomes the name at the top of the editor —
so a Look somebody sends you arrives called what they called it.

It is plain JSON, sorted keys, two spaces, so it reads and diffs like source:

```jsonc
{
  "format": "kraken-hub-look",
  "version": 7,
  "name": "Slow tide",
  "author": "your-github-handle",
  "description": "One line.",
  "createdAt": "2026-09-02T00:00:00.000Z",
  "look": { "layers": [/* bottom first; layers[0] is the base */] },
  "configs": {/* the base layer's settings */},
  "media": [/* every picture and clip, by reference */],
}
```

Two things are worth knowing about it.

**`configs` exists because the base is different.** Every overlay carries its own
settings inside `look`. The base does not: it wears the settings kept per kind,
so that switching the base from a clock to a video and back leaves the clock
exactly as you left it. A file that carried only `look` would therefore be a
Look with its main setting missing, which is why `configs` is there.

**`media` is a table of references, never bytes.** A picture appears as a content
hash (if the library that exported it knew one) or as the URL it came from — and
the setting that pointed at it is emptied on the way out, because
`kraken-hub-clip:<id>` names a row in one machine's storage and means nothing on
anybody else's.

A `.krakenlook` is capped at **64 kB**. In practice they are one or two.

The carousel is deliberately **not** in the file: a Look file describes one
arrangement, and a rotation is a property of the machine showing them. It lives
in the app's own state instead, as a list of ids and an interval — and it did
not move the state schema version, which is unusual enough that
`src/state/schema.ts` carries the argument in full. The short version: every
past additive field protected a value an older build would have destroyed, and
this one is a pointer into a store an older build never touches. Dropping it
stops a rotation and loses nothing.

> A bundle — a `.krakenlook.zip` with the referenced media inside it — is
> designed and not yet built. It is chosen explicitly when it arrives, so nobody
> ever hands somebody a 10 MB file by surprise.

## Importing, and what happens to the pictures

Import never throws a file away for a field it did not understand. It:

1. **validates** the arrangement, repairing anything out of range and recording
   what it repaired;
2. **migrates** a file written by an older build, using the same schema history
   the app's own saved state goes through — not a second copy of it;
3. **resolves** each entry in `media`, three ways:
   - **already in your library** — the local copy is used, so it plays with the
     network unplugged;
   - **a URL anybody can fetch** — kept as the source;
   - **neither** — the layer is kept, its source is left empty, and you get a
     card naming the file that is missing.

That last case is the honest one. The Look you imported is the Look you get,
with a visible hole in it and a sentence about what would fill it — rather than
a blank layer, a silent failure, or a refusal to open the file at all.

The only files that are refused outright are: not JSON, not an object, not this
format, larger than the cap, or written by a **newer** build than yours. A
newer file is refused rather than guessed at, and your copy is untouched.

## The Gallery

The **Gallery** is a curated set of Looks that live in this repository, under
[`public/looks/`](../public/looks). The app renders each one live — the card is the Look, not
a picture of it — and applying one is non-destructive like any other.

There is no server behind it, no account, and nothing is tracked. It is a folder
of files and a JSON index, reviewed like any other change. The app reads them
with an ordinary `fetch` for a file next to the page, so a fork on its own
domain reads its own gallery with no configuration.

The folder lives under `public/`, which is the one directory the build copies
next to the page, so a build carries the catalogue and the ten files at
`<base>/looks/…` — the same document-relative path the app asks for.

> A deployment that ships the app without the `looks/` folder gets a card saying
> exactly that, and pointing at the repository. It is a 404 on the catalogue,
> read as "not in this build" rather than as an error. The ten curated Looks are
> also the **Templates**, which are inside the app and always there.

## The carousel

A Look can take turns with others. Pick **two or more** of Your Looks in the
Carousel group and how long each one gets — from 30 seconds to an hour — and the
app puts the next one on the panel when its time is up, cross-fading like any
other switch.

The line under the picks says where you are: **Off — pick two.** before you have
started, **1 picked — pick one more** after the first, and **2 Looks · every
30 s** once the rotation is actually turning. The interval can be set before the
rotation exists; it is applied the moment the second Look is picked.

One thing about it is worth stating plainly, because it is a real limit rather
than a bug:

> **The rotation turns while the configuration window is open.** The set is a
> list of ids in this browser's own saved-Looks store, so the only window that
> can turn "the next one" into an actual Look is the one holding that store. The
> Kraken renders whatever it was last given; close the window and it keeps
> showing that Look rather than going blank or reverting.

The alternative — putting the whole set of Looks into the document so the panel
could rotate them itself — was considered and rejected: five arrangements on an
8 kB envelope is five times the wire budget for four panels nobody is currently
looking at.

A rotation is **not an edit**: the tick does not go on the undo stack, so
pressing undo after a night of rotating walks back through your work rather than
through the clock.

## Sharing yours

Export your Look, then open a pull request adding **one file and one line**.
[`public/looks/README.md`](../public/looks/README.md) has the exact steps and what review looks
for: MIT, no media nobody else can fetch, a one-line description in the
product's words, inside the size cap.

If you would rather not open a pull request yourself, the
**Share a Look** issue template will take the file and someone will land it.

## What is not here yet

- **Bundles** (`.krakenlook.zip`) — a Look with its media inside it, chosen
  explicitly so nobody is ever handed a 10 MB file by surprise.
- **A carousel that runs with the window closed.** See above: it needs the panel
  itself to be able to resolve a saved Look, which means a home for saved Looks
  that is not one browser's storage.
