import { useState } from 'react';

import { camInstallUrl } from '../../../config/knownHosts';
import { Chip, Code } from '../../../ui';

import type { ConfigRuntime } from '../runtime';

/**
 * "Add to CAM" — the first five minutes, and then never again.
 *
 * Everything a Kraken needs before it can show anything at all lives here: the
 * frame-rate slider (CAM ships it at 1 FPS and nothing else matters until it is
 * raised) and the exact URL to paste as the Web Integration address, derived
 * from `location` so a fork on any origin gets its own.
 *
 * The old Setup view was the home screen: four numbered panels, permanently, for
 * every user forever. That is the wrong trade — it is the most important screen
 * in the product for about four minutes and clutter for the rest of its life. So
 * this card has two variants and `displaySeen.ts` chooses between them:
 *
 *  - `first-run` — pinned to the top of the home screen, above the halo, while
 *    no display has EVER published anything to this origin;
 *  - `quiet` — a plain panel under `#/about`, where somebody reinstalling CAM
 *    or setting up a second machine goes looking for it.
 *
 * Both render the same instructions. The variant changes the frame and the
 * heading, never the substance: a user who needs the URL must not have to
 * discover that the two places disagree.
 */
export function CamSetupCard({
  runtime,
  variant,
}: {
  runtime: ConfigRuntime;
  variant: 'first-run' | 'quiet';
}) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(runtime.appUrl).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };

  const firstRun = variant === 'first-run';

  return (
    <section
      className={firstRun ? 'kh-setup kh-setup--first' : 'kh-setup'}
      data-testid={firstRun ? 'setup-first-run' : 'setup-about'}
      aria-labelledby="kh-setup-title"
    >
      <h2 id="kh-setup-title" className="kh-setup__title">
        {firstRun ? 'Add kraken-hub to CAM' : 'Add to CAM'}
      </h2>
      <p className="kh-setup__lede">
        {firstRun
          ? 'Your Kraken has not shown up yet. Two steps in NZXT CAM and it will.'
          : 'The two steps that put kraken-hub on a Kraken — here if you are setting up another machine.'}
      </p>

      <ol className="kh-setup__steps">
        <li className="kh-setup__step">
          <span className="kh-setup__num" aria-hidden="true">
            1
          </span>
          <div className="kh-setup__body">
            <b>Turn the frame rate up.</b>
            <p className="kh-setup__hint">
              CAM ships this at 1 frame per second, which makes anything that moves look like a
              slideshow. In CAM: <strong>Lighting → Kraken → Web Integration → Frame Rate</strong>,
              then drag it to maximum.
            </p>
          </div>
        </li>

        <li className="kh-setup__step">
          <span className="kh-setup__num" aria-hidden="true">
            2
          </span>
          <div className="kh-setup__body">
            <b>Point CAM at this page.</b>
            <p className="kh-setup__hint">
              Paste this address into CAM as the Web Integration URL — or let CAM open it for you.
            </p>
            <Code>{runtime.appUrl}</Code>
            <div className="kh-row kh-setup__actions">
              <button
                type="button"
                className="kh-btn kh-btn--primary"
                data-testid="setup-copy-url"
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy the address'}
              </button>
              <a
                className="kh-btn"
                data-testid="setup-open-cam"
                href={camInstallUrl(runtime.appUrl)}
              >
                Open in CAM
              </a>
              <a className="kh-btn" href={camInstallUrl(runtime.appUrl, true)}>
                Open in CAM Beta
              </a>
              <Chip tone={runtime.camDetected ? 'ok' : 'neutral'}>
                {runtime.camDetected ? 'CAM detected' : 'Ordinary browser'}
              </Chip>
            </div>
          </div>
        </li>
      </ol>
    </section>
  );
}
