/**
 * `hls.js/light` — the build kraken-hub actually loads.
 *
 * hls.js publishes two bundles. The full one carries subtitle/CEA-608 rendering,
 * EME/DRM and alternate-audio switching; the light one drops all three. On a
 * **muted 640×640 LCD** every one of those is dead weight — and the difference
 * is 177 kB gzip versus 113 kB, on a device whose Chromium has to parse and
 * compile it while a game is running. So the adapter imports `hls.js/light`.
 *
 * The package's `exports` map has no `types` condition for the `./light`
 * subpath, so this file re-points it at the full build's declarations. The two
 * bundles share one public API; light simply throws where a dropped feature is
 * requested, and kraken-hub requests none of them.
 */
declare module 'hls.js/light' {
  import Hls from 'hls.js';
  export * from 'hls.js';
  export default Hls;
}
