# Security policy

kraken-hub is a static web app. It has no backend, no accounts, and no server
that stores your data. That removes most of the usual attack surface and
concentrates what is left into a few specific places, described below.

## Supported versions

Only the currently deployed `main` branch. Deployment is continuous and there
are no back-ported releases; tags are documentation of state, not supported
branches. If you are running a fork, you are responsible for merging fixes.

## Reporting a vulnerability

Use **GitHub Private Vulnerability Reporting** on this repository
(Security → Report a vulnerability). Please do not open a public issue for a
security problem.

- Target acknowledgement: **72 hours**
- Coordinated disclosure window: **90 days**

Please include what you were able to do, the URL or input that triggered it, and
the browser/CAM version if relevant.

## Threat model

### Public brokers are public

Remote control is optional. When it is on, kraken-hub talks to a **public** MQTT
broker or ntfy topic. Those are world-readable and world-writable by design.

- The 8-character room code is a **capability, not a username**. Anyone who has
  it can change what your LCD displays and can read the media URLs you set.
- Mitigation: the code itself never transits the network. The topic is derived
  as `SHA-256(roomCode)`, and payloads are AES-GCM encrypted with a key
  HKDF-derived from the same code. A broker operator sees ciphertext of an
  unknown length and nothing else.
- Rotate the code (config UI → Remote) if you have shared a screenshot of it, or
  if a paired phone is lost.

### What is never transmitted

- **Local file bytes.** Uploaded clips live in IndexedDB on the machine running
  CAM, and are never uploaded anywhere.
- **CAM monitoring data.** Telemetry from the stats module to a paired remote is
  **off by default**.

### Untrusted input

The XSS surface is the URLs you paste.

- All external input is schema-validated before use.
- `http://` URLs are upgraded to `https://` for known-good hosts, and rejected
  otherwise — mixed content otherwise fails silently inside the webview.
- `javascript:` and non-image `data:` URLs are rejected.
- No `dangerouslySetInnerHTML`, no `eval`, no CDN scripts.

A Content-Security-Policy is delivered as a `<meta http-equiv>` in `index.html`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; media-src 'self' blob: https:;
connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*;
frame-src https:; object-src 'none'; base-uri 'none'
```

Embedded third-party players (YouTube, Twitch, Vimeo, Streamable) run in
cross-origin iframes and cannot read kraken-hub's storage or DOM.

### Resolver companion

The optional localhost resolver is **not required** for any v1 feature. A
conforming companion must bind `127.0.0.1` only, enforce a default-deny `Origin`
allowlist populated by explicit user pairing, require a bearer token the user
copies in once, expose no shell passthrough, and serve no path outside a
user-chosen media directory. `docs/resolver-protocol.md` is normative; a
companion that skips these is out of spec, and kraken-hub is not responsible for
one.

### Storage isolation

Every storage key is namespaced (`kraken-hub:v1:` plus a path-derived
namespace), because many forks share the single `github.io` origin. Resetting
kraken-hub data never touches another app's keys on that origin.

## Out of scope

- A compromised host machine (anything with local access can read IndexedDB).
- NZXT CAM itself, and the Chromium build it embeds.
- The security and privacy practices of third-party embed providers.
- Denial of service against public brokers we do not operate.
