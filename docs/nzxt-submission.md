# NZXT submission runbook (maintainers)

How to get kraken-hub onto NZXT's list of Web Integrations, what they require,
and what to expect afterwards. This is a maintainer runbook, not user
documentation — nothing here is needed to _use_ kraken-hub.

---

## Eligibility

NZXT accepts only **statically hosted** integrations. An integration that
requires a server of its own is relegated to the community list at best, and
OAuth flows are refused outright.

kraken-hub qualifies:

| Requirement           | kraken-hub                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statically hosted     | GitHub Pages, `base: './'`, no build-time origin, no server-side anything.                                                                         |
| HTTPS                 | Pages, or any custom domain with a certificate.                                                                                                    |
| No required backend   | The display makes zero network requests until given a source, and none at all for a local clip or the demo.                                        |
| No OAuth / no account | None anywhere. The remote pairs with a locally generated code.                                                                                     |
| The companion?        | **Strictly optional**, runs on the user's own machine, and is never required for any feature to work. Nothing about the hosted site depends on it. |

The companion is the one point worth pre-empting in the submission text, because
a reviewer skimming the repository will see a Node server in it. Say plainly that
it is a separate, optional, user-run program and that the integration is fully
functional without it.

## Required assets

### The 640×640 image

NZXT's submissions page requires **a 640×640 px example image** of the
integration.

`public/preview-640.png` is committed and is exactly 640×640 — `npm run capture`
asserts the dimensions rather than assuming them, and fails the run if a capture
comes out any other size.

> [!IMPORTANT]
>
> **The committed file is a simulator capture — replace it with a hardware photo
> before submission.**
>
> It is a screenshot of the display page running in kraken-hub's own hardware
> simulator: correct in every pixel, and not a picture of a Kraken. A submission
> image should show the integration on the panel it targets. Take a straight-on
> photograph of the Elite playing a clip, crop it square, resample to 640×640,
> and replace the file. Keep the capture script's output as the fallback if no
> photograph is available — but do not describe it as a photo.
>
> This is tracked in [BEFORE-PUBLISHING.md](BEFORE-PUBLISHING.md#4-hardware).

### The rest of the payload

| Field         | Value                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Name          | kraken-hub                                                                                                                                 |
| One-liner     | Real video, real modules, real control on your Kraken LCD — chrome-free playback from almost any URL.                                      |
| Description   | One paragraph. Lead with the geometry engine and the download-first clip library; say the companion is optional; mention the four modules. |
| Author        | The maintainer, or "kraken-hub contributors".                                                                                              |
| Canonical URL | `https://ubberkid.github.io/kraken-hub/` — **with the trailing slash**                                                                     |
| Install link  | `https://cam-redirect.nzxt.com/action/load-web-integration?url=<url-encoded canonical URL>`                                                |
| Repository    | `https://github.com/ubberkid/kraken-hub`                                                                                                   |
| Image         | `public/preview-640.png` (640×640; see above)                                                                                              |

## Pre-submission checklist

Everything here is a thing a reviewer can trivially catch.

- [ ] Renders correctly at **240×240 square, 320×320 circle and 640×640 circle** —
      check all four presets in **Preview**, not just the Elite.
- [ ] Renders correctly at **`targetFps === 1`**. This is the factory default and
      it is what a reviewer will see first. `?kraken=1&sim=elite&fps=1`.
- [ ] **No console errors on a cold load**, in either browser mode. The e2e suite
      asserts this, but check by hand on the deployed URL too.
- [ ] **No network request is needed for the first paint.** Demo mode is bundled;
      pull the network cable and confirm.
- [ ] **The trailing-slash URL** is the one submitted, and it loads.
- [ ] **The one-click install link works from a clean CAM profile.**
- [ ] **No NZXT trademark misuse.** kraken-hub is not affiliated with NZXT; the
      README's disclaimer says so and must stay.
- [ ] The hardware checklist has been run and the FPS numbers published — a
      submission that publishes measured achieved-FPS figures is more useful to
      NZXT's users than one that does not.

## Where to submit

Two routes; do both.

1. **The community list.** Open a pull request against
   [`NZXTCorp/web-integrations-examples`](https://github.com/NZXTCorp/web-integrations-examples),
   adding a row to the README's **Community Web Integrations** section with the
   name, one-liner, repository link and install link. This is the route every
   listed community project took.
2. **The official submissions flow** at
   [developer.nzxt.com/docs/submissions](https://developer.nzxt.com/docs/submissions/),
   which is how an integration gets considered for the in-CAM list rather than
   the community README.

Track it as an issue labelled `launch`.

## Expectation setting

**Do not block a release on a response.** The official documentation repository
is effectively unmaintained: the newest documentation commits are from 2024, the
types package was last pushed in September 2024, and community issues asking
whether the repository is still maintained and tracking response times were filed
and closed without answers.

Ship, announce, and treat acceptance as a bonus. The install link works whether
or not anyone at NZXT ever reads the pull request.
