# kraken-hub documentation

Everything written down, grouped by what you are trying to do.

The project README is [one level up](../README.md).

---

## Using it

| Document                                 | What it covers                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md) | Zero to video on the panel. The frame-rate slider, the exact CAM click path, the trailing slash, pairing a phone. |
| [providers.md](providers.md)             | Every source, what works, what does not, and why. The honest capability matrix.                                   |
| [local-clips.md](local-clips.md)         | Download-first ingestion, manual upload, quota and persistence, the square-crop ffmpeg one-liner.                 |
| [remote-control.md](remote-control.md)   | Pairing, transports, failover, and the privacy and threat model of a public broker.                               |
| [troubleshooting.md](troubleshooting.md) | Symptom → mechanism → fix, with an H-id wherever the fix rests on something unmeasured.                           |
| [self-hosting.md](self-hosting.md)       | Forking: Pages with the Actions source, custom domains, and the exhaustive no-hardcoded-origin table.             |

## Building on it

| Document                                                          | What it covers                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [modules.md](modules.md)                                          | Writing a module, start to finish — the contract, the renderer, chunking, testing. Validated by building Clock from it. |
| [resolver-protocol.md](resolver-protocol.md)                      | The frozen v1 companion wire contract and its security posture.                                                         |
| [`companion/resolver/README.md`](../companion/resolver/README.md) | Running the companion: install, flags, what installing it means, troubleshooting.                                       |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md)                           | Dev setup, `npm run check`, the simulator flags, the eight platform invariants and the lint rule enforcing each.        |
| [`SECURITY.md`](../SECURITY.md)                                   | Threat model, above all the public-broker one.                                                                          |

## Evidence

The parts of this project that are research rather than code.

| Document                                                 | What it covers                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [why-not-extraction.md](why-not-extraction.md)           | The measurements that killed YouTube stream extraction from a static origin, with curl repros.                                                                                                                                 |
| [hardware-checklist.md](hardware-checklist.md)           | H01–H23: what is still unmeasured on real hardware, and exactly how to measure each one.                                                                                                                                       |
| [design/](design/)                                       | The three implementation-ready design documents, kept as authored, each with a corrections section where shipped reality diverges.                                                                                             |
| [design/research/](design/research/)                     | The source research: the NZXT platform contract, YouTube playback, providers and sync.                                                                                                                                         |
| [design/halo-prototype.html](design/halo-prototype.html) | **“Halo” — the approved configuration/remote UI direction, 2026-08-31.** The interactive prototype is the spec: its tokens, layout, copy and interaction states are what `src/ui` and the configuration surfaces are built to. |

## Maintaining it

| Document                                     | What it covers                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [BEFORE-PUBLISHING.md](BEFORE-PUBLISHING.md) | Every placeholder needing a real GitHub slug, plus the settings that live in the GitHub UI. |
| [nzxt-submission.md](nzxt-submission.md)     | Getting listed: eligibility, the 640×640 image, the PR, and what to expect.                 |

`npm run licenses` writes `docs/third-party-licenses.md` from the production
dependency tree. It is generated rather than committed, and it needs
`license-checker-rseidelsohn` available on the `PATH`.

---

## Known gaps

Things the design intended, or a reader would reasonably expect, that are not
there. Listed here so nobody has to discover them by being surprised.

- **No one-click "reset all kraken-hub data".** Individual clips can be deleted
  from the clip library, and the storage inspector shows every key, but there is
  no single control that wipes state, clips and room code together.
  ([getting-started.md](getting-started.md#removing-everything))
- **The storage namespace is not path-scoped.** It is the fixed origin-scoped
  prefix `kraken-hub:v1:`, so two kraken-hub deployments under one
  `<user>.github.io` share one configuration. The design specified a
  path-normalized namespace; that did not ship.
  ([self-hosting.md](self-hosting.md#nothing-is-hardcoded))
- **The diagnostics page lists the sync endpoints but never probes them.** H19 —
  whether CAM's webview can reach `broker.emqx.io` or `ntfy.sh` at all — needs a
  deliberate opt-in probe that has not been built. Live status for a _paired_
  room is on the Remote page and is real.
- **No service worker.** Deliberately deferred: the display page runs for weeks
  at a time and service-worker update semantics are a poor fit for that. Local
  clips already play offline without one.
- **Everything in [hardware-checklist.md](hardware-checklist.md) still marked
  unmeasured.** Most of this project has been validated in a simulator against
  documented behaviour. The H-ids are the list of claims that deserve a real
  panel behind them, and a hardware report is the highest-value contribution
  anyone can make.

## Documentation conventions

- Sentence-case headings. No marketing adjectives.
- Every factual claim about the platform carries a source, and every claim that
  has **not** been verified on real hardware carries the marker
  `⚠ not verified on hardware` or an explicit H-id link — never a confident
  sentence with nothing behind it.
- Screenshots are generated, not hand-cropped: `npm run capture` rebuilds every
  image in [assets/](assets/) from the built app. Re-run it after a UI change
  and commit the diff.
- Internal links are checked in CI by [lychee](../.github/workflows/link-check.yml),
  weekly and on every pull request that touches documentation.
