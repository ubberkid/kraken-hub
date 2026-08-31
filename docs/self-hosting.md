# Self-hosting a fork

kraken-hub is a static site with `base: './'` and **no hardcoded origin anywhere
in `src/`**. Fork it, turn on Pages, and your copy works — no config file to
edit, no origin to register, no build-time environment variables.

That is a design constraint, not a coincidence, and
[Nothing is hardcoded](#nothing-is-hardcoded) below is the exhaustive list of
every place an origin could have leaked in and what it is derived from instead —
including the two deliberate exceptions and the one row that is weaker than the
design doc intended.

---

## Deploy it

### 1. Fork

Use GitHub's **Fork** button, or create an empty repository and push. Either
works; a fork keeps the upstream link, which makes sending a fix back easy.

### 2. Enable Pages, with the Actions source

**Settings → Pages → Build and deployment → Source: _GitHub Actions_.**

This is the one step people get wrong. It must be **GitHub Actions**, not
"Deploy from a branch". `.github/workflows/deploy.yml` publishes with
`actions/upload-pages-artifact` + `actions/deploy-pages`, which only work with
the Actions source; on the branch source the first run fails with a permissions
error that does not say what is actually wrong.

There is no `gh-pages` branch and nothing is committed to one.

### 3. Push to `main`

`deploy.yml` runs on every push to `main` and on manual dispatch. It builds,
re-checks the bundle budgets — a deploy that would blow the display's critical
path budget fails rather than shipping — and publishes `dist/`.

The concurrency group deliberately **does not** cancel an in-flight deploy: the
LCD is a long-lived client, and a half-published `dist` is worse than a slightly
stale one.

Your site lands at `https://<owner>.github.io/<repo>/`.

### 4. Update the repository slug

A handful of links cannot be derived from `location` because they point at
GitHub rather than at the app. They are enumerated, with a `grep` that finds
them all, in **[BEFORE-PUBLISHING.md](BEFORE-PUBLISHING.md)**. The important one
is `package.json` → `repository.url`: Vite turns it into the `__REPO_URL__`
define, which is what makes the in-app links to the hardware checklist point at
_your_ fork. Left empty, those links render as nothing — deliberately, rather
than as a dead link to somebody else's repository.

### 5. Point CAM at it

Your configuration page derives its own install URL from the address bar and
renders it with a copy button and a one-click CAM link. Use that; do not type a
URL by hand, and keep the trailing slash (see
[getting-started.md](getting-started.md#the-manual-way)).

---

## A custom domain

Pages custom domains work normally, with two kraken-hub-specific notes:

- **Add `public/CNAME`**, not just the repository setting. The Actions deploy
  publishes `dist/`, so anything you need served must be in `public/` to be
  copied there. A `CNAME` configured only in Settings is erased by the next
  deploy.
- **Moving origin means starting over.** Browser storage is scoped by origin, so
  moving from `owner.github.io/kraken-hub/` to `kraken.example.com/` gives you a
  fresh, empty configuration — the settings and clips at the old address are
  still there, under the old origin, invisible to the new one. Re-point CAM and
  set it up again, or move first and configure once.

Do not serve kraken-hub over plain `http://` on a public domain. The app refuses
to load `http://` media from an `https://` page (browsers block it as mixed
content), and the reverse — an `http://` site — loses `navigator.storage.persist()`
and makes clip eviction much more likely.

---

## Nothing is hardcoded

Every place an origin, a hostname or a device dimension could have been baked
in, and what it is derived from instead. This is the table a fork can check
itself against; the ESLint invariants I3 and I5 plus `scripts/check-invariants.mjs`
enforce most of it mechanically.

| Site                                                    | Derivation                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset paths                                             | Vite `base: './'` — every emitted URL is relative, so the app works at a repo subpath, at a domain root, and from `file://`-adjacent previews alike.                                                                                                      |
| Deep links                                              | Hash-only routing. No path routing and no 404-rewrite trick, both because Pages would need a workaround and because the Kraken Browser never follows a navigation.                                                                                        |
| The app's own URL (copy button, QR, one-click CAM link) | `canonicalAppUrl()` = `new URL('./', location.href)` — with the trailing slash, always.                                                                                                                                                                   |
| Twitch `parent=`                                        | `location.hostname` at iframe-build time. One page is one hostname, so a fork needs no multi-parent list and no registration.                                                                                                                             |
| YouTube `origin=`                                       | `location.origin`.                                                                                                                                                                                                                                        |
| Storage namespace                                       | A fixed prefix, `kraken-hub:v1:` — **origin-scoped only**, see the caveat below.                                                                                                                                                                          |
| IndexedDB database name                                 | A fixed name, `kraken-hub.v1` — same caveat.                                                                                                                                                                                                              |
| Resolver companion                                      | Holds no origin allowlist at all: it answers `Access-Control-Allow-Origin: *` and defends itself by binding loopback, refusing non-`http(s)` targets and rate limiting instead. That trade-off is argued in [resolver-protocol.md](resolver-protocol.md). |
| Device width, height, shape, FPS                        | `window.nzxt.v1`, re-read on change. `640` is one device out of four — `scripts/check-invariants.mjs` fails the build on an unexplained `640`, `320` or `240` anywhere in `src/`.                                                                         |
| GitHub links inside the app                             | `package.json` → `repository.url`, injected as `__REPO_URL__` at build time, so a fork's in-app links point at the fork.                                                                                                                                  |
| Broker endpoints                                        | `src/sync/endpoints.ts` — the **only** intentional hardcoded hosts in the codebase, user-overridable in the remote's settings, with the lint override documenting why.                                                                                    |
| CAM deep-link host                                      | `src/config/knownHosts.ts` — likewise the only file permitted to name an external host, and likewise annotated.                                                                                                                                           |

The two exceptions are exceptions on purpose: `broker.emqx.io` and
`cam-redirect.nzxt.com` are third-party services whose addresses cannot be
derived from anything. Both live in one file each, both are overridable, and
ESLint's `no-restricted-syntax` rule bans a hostname literal everywhere else.

> [!WARNING]
>
> **Two kraken-hub deployments on one origin share one configuration.**
>
> The storage prefix is the fixed string `kraken-hub:v1:` and the IndexedDB
> database is the fixed name `kraken-hub.v1`. Browser storage is scoped by
> **origin**, not by path — so `owner.github.io/kraken-hub/` and
> `owner.github.io/kraken-hub-fork/` are the same storage bucket, and they will
> read and overwrite each other's settings and clip library.
>
> The design intended to fold a normalized `location.pathname` into the
> namespace, which would have separated them; that was not implemented, and this
> is the honest statement of what shipped. It is recorded in the
> [design corrections](design/design-ossDx.md#corrections-post-m4) and is a
> [known gap](README.md#known-gaps).
>
> It bites in exactly one situation: two kraken-hub deployments under the same
> `<user>.github.io`. A custom domain, a different GitHub account, or simply not
> running two copies avoids it entirely. If you need two, put the second on its
> own origin.

---

## Running it locally

CAM accepts a loopback URL, so a dev server is a perfectly good Web Integration
target while you are working on a module:

```bash
npm ci
npm run dev          # http://localhost:5173/
```

Paste `http://localhost:5173/` into CAM's URL field. The display page is
`http://localhost:5173/?kraken=1`; the simulator flags in
[CONTRIBUTING.md](../CONTRIBUTING.md) let you develop the whole thing without
touching the Kraken at all.

To serve a production build the way Pages will:

```bash
npm run build
npm run preview      # http://localhost:4173/
```

---

## What a fork inherits

- **No telemetry, no analytics, no phone-home.** The display page makes zero
  network requests until you give it a source, and none at all when it is
  playing a local clip or the demo.
- **A public broker is optional and encrypted.** The remote works without one
  (`localStorage` handles the CAM-local case), and when it does use one, the
  payloads are ciphertext the broker cannot read. See
  [remote-control.md](remote-control.md) and [SECURITY.md](../SECURITY.md).
- **The bundle budgets in `budgets.json`.** They fail the build, not just CI, and
  they are the reason the display path stays small enough to boot fast on a
  panel that reloads more often than you would like.
