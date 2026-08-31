import { useEffect, useState } from 'react';

import { RESOLVER_WINDOWS_ASSET, releaseAssetUrl } from '../../../buildInfo';
import { Button, Code, Notice, Row } from '../../../ui';

import { pingResolverConnected } from './resolverPing';

import type { ResolverConfig } from '../types';

/**
 * "Get the downloader" — the guided connect panel.
 *
 * The companion is optional and always will be: a YouTube link plays through
 * the geometry engine with nothing installed, and §6.4 forbids ever calling its
 * absence an error. But *optional* was being read as *hidden*. The only place
 * the downloader was mentioned lived three disclosures deep in the video
 * settings, so the ad-free local copy — the best thing this product does — was
 * effectively unshipped for anyone who did not read the README.
 *
 * This panel is the fix, and it is deliberately three things and no more:
 *
 *  - **One button.** NZXT CAM is a Windows application, so the PC with a Kraken
 *    attached is a Windows PC. Everyone else is a developer and gets the npm
 *    line. Offering four builds to a user who owns one platform is a menu, not
 *    an answer.
 *  - **The SmartScreen warning, in advance.** An unsigned open-source binary
 *    trips Windows' reputation check, and a user who meets that dialog without
 *    warning concludes the app is malware and stops. Saying it first turns an
 *    alarm into an expected step.
 *  - **Live detection, then it just happens.** While this panel is open the
 *    companion is probed every two seconds — the 60 s health memo is dropped
 *    each time, because the whole point is to catch the instant the answer
 *    changes. On the first healthy answer the panel says so and pings the
 *    display window, which re-resolves the source it already has: the link the
 *    user pasted before installing anything downloads and plays with no further
 *    click and nothing to paste again.
 */

/** Fast enough to feel automatic, slow enough to be free (§6.4's probe is 1.2 s). */
const PROBE_INTERVAL_MS = 2000;

/**
 * The developer path, and the ONLY other one that exists.
 *
 * Deliberately not `npx kraken-hub-resolver`: the companion is not published to
 * npm, so that line is a command that 404s — the shortest possible way to lose
 * the trust of the person who was willing to open a terminal for you. A clone
 * and two scripts is longer and true.
 */
const DEV_COMMAND = 'npm install && npm run build:companion && node companion/resolver/dist/cli.js';

export function ResolverConnectPanel({
  resolver,
  onClose,
}: {
  resolver: ResolverConfig;
  onClose?: () => void;
}) {
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const downloadUrl = releaseAssetUrl(RESOLVER_WINDOWS_ASSET);

  useEffect(() => {
    if (connected) return undefined;
    const alive = { current: true };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A call, not a field read: the panel can unmount inside either await, and a
    // plain `if (!alive.current)` is narrowed to "already checked" by the second
    // one — which is how a probe loop outlives the component it belongs to.
    const gone = (): boolean => !alive.current;

    const probe = async (): Promise<void> => {
      const client = await import('./resolverClient');
      if (gone()) return;
      // The memo is the enemy here: it exists so an ordinary mount does not pay
      // for a probe it already paid for, and this panel is the one place that
      // genuinely needs the answer to be able to change.
      client.invalidateHealth();
      const health = await client.checkHealth(resolver);
      if (gone()) return;
      if (health.healthy) {
        setConnected(true);
        // Tell the display window, which is where the video actually is.
        pingResolverConnected();
        return;
      }
      timer = setTimeout(() => {
        void probe();
      }, PROBE_INTERVAL_MS);
    };

    void probe();
    return () => {
      alive.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [resolver, connected]);

  return (
    <section className="kh-connect" data-testid="resolver-connect" aria-live="polite">
      {connected ? (
        <>
          <h3 className="kh-connect__title" data-testid="resolver-connected">
            Connected ✓
          </h3>
          <Notice tone="ok">
            The downloader is running. Your Kraken is fetching the link you pasted right now — it
            will switch to the local copy on its own, and keep playing it after you close the
            downloader again.
          </Notice>
        </>
      ) : (
        <>
          <h3 className="kh-connect__title">Get the downloader</h3>
          <p className="kh-connect__lede">
            A small open-source program that runs beside CAM on this PC. It turns a link into a
            plain video file, kraken-hub keeps that file, and your Kraken plays it forever —
            ad-free, no player chrome, full quality, and with the downloader switched off again.
          </p>

          <Row>
            {downloadUrl === null ? (
              <Code>{DEV_COMMAND}</Code>
            ) : (
              <a
                className="kh-btn kh-btn--primary"
                data-testid="resolver-download-win"
                href={downloadUrl}
              >
                Download for Windows
              </a>
            )}
          </Row>

          <ol className="kh-connect__steps">
            <li>Download it.</li>
            <li>
              Double-click to run. Windows may show a SmartScreen warning —{' '}
              <b>More info → Run anyway</b>. The app is open source and unsigned, which is what
              SmartScreen is reacting to.
            </li>
            <li>This panel connects automatically.</li>
          </ol>

          <p className="kh-connect__alt">
            Other platforms &amp; developers, from a clone: <Code inline>{DEV_COMMAND}</Code>{' '}
            <Button
              testId="resolver-copy-npx"
              onClick={() => {
                void navigator.clipboard.writeText(DEV_COMMAND).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    setCopied(false);
                  },
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </p>

          <p className="kh-hint">
            Waiting for the downloader… this panel is checking every couple of seconds, so there is
            nothing to press when it starts. To have it start with your PC, run it once with{' '}
            <Code inline>--install-autostart</Code>.
          </p>
        </>
      )}

      {onClose !== undefined && (
        <Row>
          <Button testId="resolver-connect-close" onClick={onClose}>
            Done
          </Button>
        </Row>
      )}
    </section>
  );
}
