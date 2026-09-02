# The Look gallery

Every file in this directory is a **Look** — one saved arrangement of layers,
ready to apply to a Kraken. The app reads them here and renders each one live in
the Gallery, so what you see on the card is the Look itself and not a
screenshot somebody took once.

There is no backend, no account and no tracking behind any of this. A Look
arrives the way everything else in this repository arrives: as a pull request.

The directory sits under `public/` because that is the one directory the build
copies next to the page. The app fetches `looks/index.json` **relative to the
document**, never from an origin written down, so a fork on its own domain reads
its own gallery with no configuration — and it only reads anything at all if the
files are served beside `index.html`. Moving them anywhere else turns the
Gallery into its honest "not in this build" card.

## What is in here

| File              | What it is                                                           |
| ----------------- | -------------------------------------------------------------------- |
| `<id>.krakenlook` | One Look. JSON, sorted keys, two-space indent, one trailing newline. |
| `index.json`      | The catalogue: `id`, `name`, `author`, `description`, `file`.        |

Both are checked by `src/state/look/templates.test.ts`. A `.krakenlook` with no
row in `index.json` fails, and so does a row with no file — so the catalogue
cannot quietly drift away from the data.

The Looks shipped by the project are the app's **Templates**; they are generated
from `src/state/look/templates.ts` and the same test asserts the two are
byte-identical. Do not hand-edit a `tpl-*.krakenlook`: change the template and
the file follows.

## Submitting a Look

1. **Design it in the app** and export it. You get a `<name>.krakenlook`.
2. **Add the file here** — `public/looks/` — with a lowercase, hyphenated name,
   `slow-tide.krakenlook`.
3. **Add one row to `public/looks/index.json`**, keeping the array in file order:

   ```json
   {
     "id": "slow-tide",
     "name": "Slow tide",
     "author": "your-github-handle",
     "description": "A gradient that barely moves, with the liquid temperature on it.",
     "file": "slow-tide.krakenlook"
   }
   ```

4. **Open a pull request.** One Look per pull request, please — it keeps the
   review about the Look.

## What review looks for

- **Licence.** Contributions are MIT, like the rest of the repository. By
  opening the pull request you are licensing the Look under it.
- **No media anybody has to trust.** A Look references pictures and clips; it
  never carries their bytes. A reference is fine when it is a **public URL** that
  anybody can fetch. A reference to something only your machine holds is fine
  too — it imports as a placeholder with an honest card, which is the designed
  behaviour — but a Look built entirely around media nobody else can get is a
  Look nobody else can see, so say so in the description.
- **Words.** The description is one line, in the product's vocabulary: Look,
  Layer, Effect, Preset. Never "element", "shader", or an internal id.
- **Size.** A Look file is kilobytes. The importer refuses anything over
  **64 kB**, and a hand-written file that large is carrying something it should
  not be.
- **It parses clean.** `npm test` runs every file in this directory through the
  importer and requires it to come back with no repairs needed.

## Anatomy of a `.krakenlook`

```jsonc
{
  "format": "kraken-hub-look", // always this
  "version": 7, // the state schema it was written at; older files are migrated
  "name": "Slow tide",
  "author": "your-github-handle",
  "description": "One line.",
  "createdAt": "2026-09-02T00:00:00.000Z",
  "look": { "layers": [/* bottom first; layers[0] is the base */] },
  "configs": {/* the base layer's settings, by kind */},
  "media": [/* every picture or clip, by content hash or source URL */],
}
```

The full explanation — what a Layer is, why the base is different, how media is
resolved on import — is in [`docs/looks.md`](../../docs/looks.md).
