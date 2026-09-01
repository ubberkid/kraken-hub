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
 *  - `first-run` — a **slim band** under the halo on the home screen, while no
 *    display has EVER published anything to this origin;
 *  - `quiet` — a plain, full panel under `#/about`, where somebody reinstalling
 *    CAM or setting up a second machine goes looking for it.
 *
 * ## Why first-run is a band rather than the same card
 *
 * The design audit measured the old first-run screen at CAM's real window size
 * (866×537) and found the card filled **the entire viewport**: the halo, the
 * paste field, the chips — the whole product — were below the fold, behind a
 * full page of prose and four competing buttons (F7). A user's first sight of
 * kraken-hub was an instruction manual.
 *
 * So the band is one line of text and **one** primary action (Open in CAM). The
 * address, the Beta channel and the CAM-detection readout are all real and all
 * still here, on a secondary line behind a reveal, which is where a thing that
 * is occasionally essential and usually noise belongs. The halo is never
 * displaced: the band renders below it.
 *
 * The words differ between the variants; the substance never does — a user who
 * needs the URL must not have to discover that the two places disagree.
 */
export function CamSetupCard({
  runtime,
  variant,
}: {
  runtime: ConfigRuntime;
  variant: 'first-run' | 'quiet';
}) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

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

  /*
   * "Ordinary browser" is dead (F8's jargon inventory): it named the *category*
   * a user's browser falls into rather than telling them anything. What the chip
   * is actually reporting is whether CAM is the thing showing this page, so it
   * says that, in both directions.
   */
  const camChip = (
    <Chip tone={runtime.camDetected ? 'ok' : 'neutral'}>
      {runtime.camDetected ? 'Open inside CAM' : 'Not open inside CAM'}
    </Chip>
  );

  if (variant === 'first-run') {
    return (
      <section className="kh-band" data-testid="setup-first-run" aria-labelledby="kh-setup-title">
        <div className="kh-band__line">
          <p className="kh-band__text">
            <b id="kh-setup-title">Your Kraken has not shown up yet.</b> In CAM, turn{' '}
            <b>Web Integration → Frame Rate</b> up, then point CAM at this page.
          </p>
          <a
            className="kh-btn kh-btn--primary"
            data-testid="setup-open-cam"
            href={camInstallUrl(runtime.appUrl)}
          >
            Open in CAM
          </a>
          <button
            type="button"
            className="kh-band__more"
            data-testid="setup-reveal-address"
            aria-expanded={revealed}
            aria-controls="kh-band-more"
            onClick={() => {
              setRevealed((open) => !open);
            }}
          >
            {revealed ? 'Hide the address' : 'Show the address'}
          </button>
        </div>

        {revealed && (
          <div className="kh-band__reveal" id="kh-band-more">
            <Code>{runtime.appUrl}</Code>
            <div className="kh-row">
              <button type="button" className="kh-btn" data-testid="setup-copy-url" onClick={copy}>
                {copied ? 'Copied' : 'Copy the address'}
              </button>
              <a className="kh-btn" href={camInstallUrl(runtime.appUrl, true)}>
                Open in CAM Beta
              </a>
              {camChip}
            </div>
            <p className="kh-band__hint">
              Paste it into CAM as the Web Integration URL if the button above did not open CAM.
            </p>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="kh-setup" data-testid="setup-about" aria-labelledby="kh-setup-title">
      <h2 id="kh-setup-title" className="kh-setup__title">
        Add to CAM
      </h2>
      <p className="kh-setup__lede">
        The two steps that put kraken-hub on a Kraken — here if you are setting up another machine.
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
              <a
                className="kh-btn kh-btn--primary"
                data-testid="setup-open-cam"
                href={camInstallUrl(runtime.appUrl)}
              >
                Open in CAM
              </a>
              <button type="button" className="kh-btn" data-testid="setup-copy-url" onClick={copy}>
                {copied ? 'Copied' : 'Copy the address'}
              </button>
              <a className="kh-btn" href={camInstallUrl(runtime.appUrl, true)}>
                Open in CAM Beta
              </a>
              {camChip}
            </div>
          </div>
        </li>
      </ol>
    </section>
  );
}
