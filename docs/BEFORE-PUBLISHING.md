# Before publishing

Everything in this repository that cannot be derived at runtime, in one list.

kraken-hub is written to have **no hardcoded origin anywhere in `src/`** — the
app derives its own URL, its storage namespace, its Twitch `parent` and its
YouTube `origin=` from `location` at runtime, so a fork on any host works with no
configuration. See [self-hosting.md](self-hosting.md) for the full derivation
table.

That leaves a short list of places where a human has to type a real name: the
package manifest, the README's badges, the links GitHub itself cannot derive, and
two settings that live in the GitHub UI rather than in the tree. This page is
that list. Work top to bottom, tick every box, and the placeholder slug is gone.

Throughout the repository the placeholder **was**:

| Placeholder                                | Meaning                                         |
| ------------------------------------------ | ----------------------------------------------- |
| `kraken-hub/kraken-hub`                    | `<owner>/<repo>` on GitHub                      |
| `https://kraken-hub.github.io/kraken-hub/` | the deployed Pages URL, with the trailing slash |

**This repository's slug is now real:** `ubberkid/kraken-hub`, deployed at
`https://ubberkid.github.io/kraken-hub/`. Section 1 below is therefore done —
it is kept, ticked, as the map a fork needs.

Find every remaining instance with:

```bash
grep -rn "kraken-hub/kraken-hub\|kraken-hub\.github\.io" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .
```

When that command prints nothing but this file, you are done. (It currently
prints nothing but this file.)

---

## 1. The repository slug — **done**, applied as `ubberkid/kraken-hub`

- [x] **`package.json` → `repository.url`.** This is the load-bearing one: Vite
      turns it into the `__REPO_URL__` define, which is what `docUrl()` in
      `src/buildInfo.ts` uses to link the hardware checklist from inside the
      running app. Get it wrong and those links point at somebody else's fork;
      leave it empty and they render as nothing, which is the deliberate
      fallback. → `git+https://github.com/ubberkid/kraken-hub.git`
- [x] **`companion/resolver/package.json` → `repository.url`.** Same string. It
      also appears in the package the user runs as `npx kraken-hub-resolver`, so
      it is the link an npm page shows.
- [x] **`README.md`** — the three badge URLs, the CI badge's workflow path, and
      both one-click CAM install links (CAM and CAM Beta). The **SET YOUR REPO**
      comment block has been deleted. The "Not published yet" NOTE stays until
      the repository is actually public.
- [x] **`.github/ISSUE_TEMPLATE/config.yml`** — the Discussions link and the
      private-vulnerability-report link. GitHub does not rewrite these on fork.
- [x] **`CHANGELOG.md`** — the `[unreleased]` link-reference definition at the
      bottom (and every version tag comparison link the release adds).
- [x] **`.lycheeignore`** — the placeholder-slug entries are removed, so the
      link checker now actually checks these URLs. The `^\.\./\.\./issues` and
      `^\.\./\.\./discussions` entries are gone too: every issue and discussion
      link in the tree is now absolute, which is what stopped a wrong-depth
      relative link from hiding from CI.
- [x] **`docs/nzxt-submission.md`** — the canonical URL and repo link in the
      submission payload.
- [x] **`docs/troubleshooting.md`** — the "file an issue" link at the bottom.
- [x] **`docs/getting-started.md`** — both CAM install links and the bare Pages
      URL in the manual-setup block.

## 2. GitHub settings (not in the tree)

- [ ] **Settings → Pages → Source = _GitHub Actions_.** Not "Deploy from a
      branch". `.github/workflows/deploy.yml` uses
      `actions/upload-pages-artifact` + `actions/deploy-pages`, which only works
      with the Actions source. The first deploy fails with a confusing
      permissions error if this is left on the branch source.
- [ ] **Settings → Actions → General → Workflow permissions** — the default
      read-only token is correct. `release.yml` requests `contents: write` for
      itself; nothing needs a repository-wide upgrade.
- [ ] **Settings → Security → Private vulnerability reporting: on.**
      `SECURITY.md` and the issue-template config both send people there.
- [ ] **Discussions: on**, with the categories the issue-template config names
      (Q&A, Show and tell, Hardware reports, Ideas). A contact link pointing at
      a disabled tab is a 404.
- [ ] **About → website** = the Pages URL; add repository topics
      (`nzxt`, `kraken`, `lcd`, `cam`, `web-integration`, `typescript`, `vite`).

## 3. Contacts and legal

- [x] **`CODE_OF_CONDUCT.md`** — the `TODO-MAINTAINER-CONTACT@example.invalid`
      placeholder is gone. Reports now go to
      <https://github.com/ubberkid/kraken-hub/issues>, to the maintainer via
      their GitHub profile (@ubberkid), or privately through GitHub's **Report
      content** flow. No email address is published, deliberately. A fork should
      substitute its own routes here — a Code of Conduct with an unreachable
      contact is worse than none.
- [ ] **`LICENSE`** — the copyright line currently reads "kraken-hub
      contributors". Change it only if you want a personal or corporate name
      there; "contributors" is a valid and common choice.

## 4. Hardware

These are the claims the code cannot make on its own.

- [ ] **Run [`hardware-checklist.md`](hardware-checklist.md) end to end** on a
      real Kraken. Every H-id is either measured, or tracked in an open issue
      labelled `hardware`. The automatic rows — **H01, H02, H03, H12, H14, H17,
      H18, H22** — come out of `?kraken=1&diag=1` in one paste; the manual rows
      need a person and a panel. **H19 is _not_ automatic:** the diagnostics
      page lists the sync endpoints but never probes them, which is a documented
      known gap ([README](README.md#known-gaps)) — report it by observation.
- [ ] **Replace `public/preview-640.png` with a real photograph.** The committed
      file is a **simulator capture** — honest, exactly 640×640, and not a
      picture of hardware. NZXT's community list wants the real thing. See
      [nzxt-submission.md](nzxt-submission.md).
- [ ] **Replace `docs/assets/hero.gif` and `docs/assets/hero.png` with real
      hardware footage.** Both are currently the two-dot demo clip on a
      _simulated_ Elite panel — and the GIF is the first thing a visitor sees on
      the README. Shoot the flagship video engine on a real panel, straight-on,
      and keep the GIF small enough to autoplay on a phone.
- [ ] **Regenerate or crop `docs/assets/remote.png`.** The committed capture
      shows a live room code (`D1A9VR5V`) and its derived topic. The code is
      rotatable from the UI and the capture was taken on the offline
      `?transport=fake` bus, so nothing is at risk — but a room code is the only
      secret in the sync design, and publishing one sets a bad example. Rotate
      the code and re-capture, or crop the pairing card out.
- [ ] **Re-run `npm run capture` once the Pages URL is live.**
      `docs/assets/config-ui.png` currently shows `http://127.0.0.1:4179/` as
      the Web Integration URL, which a reader could paste into CAM verbatim.
- [ ] **Fill in the Kraken Plus row** in the README's frame-rate table (H22), or
      leave the `⚠` and the hardware-report link exactly as they are. Do not
      guess it.
- [ ] **Publish the measured FPS numbers** (H09–H12) in
      [`hardware-checklist.md`](hardware-checklist.md) and in the README's frame
      rate note. They are the single most useful thing this project can tell a
      Kraken owner, and right now nobody has them.

## 5. Verify, then tag

- [ ] `npm run check` and `npm run test:e2e` green on a clean clone.
- [ ] `npm run capture` re-run after any UI change, and the PNG diff committed.
- [ ] Push to `main`, wait for `deploy.yml`, and load the Pages URL in an
      ordinary browser. Then load it **with the trailing slash** — that is the
      form every install link emits, and the form CAM will be given.
- [ ] Install into a **clean CAM profile** from the one-click link, raise the
      frame-rate slider, and confirm the demo clip plays with no configuration.
- [ ] Tag `v1.0.0`. `release.yml` builds, extracts that version's section from
      `CHANGELOG.md` and opens the GitHub Release.
- [ ] Delete this file's link from the top of the README. Keep the file: the
      next fork needs it.
