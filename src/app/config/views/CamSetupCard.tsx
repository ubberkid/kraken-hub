import { useState } from 'react';

import {
  CAM_FRAME_RATE_LEAD,
  CAM_FRAME_RATE_TAIL,
  CAM_PATH_FRAME_RATE,
} from '../../../config/camPaths';
import { camInstallUrl } from '../../../config/knownHosts';
import { Chip, Code } from '../../../ui';

import type { ConfigRuntime } from '../runtime';

/**
 * "Add to CAM" — the first five minutes, and then never again.
 *
 * Everything a Kraken needs before it can show anything at all lives here: the
 * frame-rate slider (CAM ships it at 1 FPS and nothing else matters until it is
 * raised) and the exact URL to paste as the integration address, derived from
 * `location` so a fork on any origin gets its own. Both menu paths come from
 * `src/config/camPaths.ts`, which is the only place in the product that spells
 * them (round 2, R6).
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
  dense = false,
}: {
  runtime: ConfigRuntime;
  variant: 'first-run' | 'quiet';
  /**
   * The band, while something else on the page has the floor (round 3, F2).
   *
   * Two objects cannot both have 537 px. When the options panel opens, the halo
   * shrinks to a thumb and the band drops to the half of its sentence that is
   * news — *your Kraken has not shown up yet* — keeping its one action. The
   * instruction it drops is the same instruction the button carries out, and it
   * comes back the moment the panel closes. `first-run` only; the quiet variant
   * lives on a page of its own where nothing is competing with it.
   */
  dense?: boolean;
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
          {/*
            One grammar for the frame-rate instruction (round 3, minors).

            This line used to read "then turn CAM → Lighting → your Kraken → Web
            Integration → Frame Rate up" — a garden path that puts a five-step
            menu route between a verb and its particle, so a reader arrives at
            "up" having lost what it attaches to. The quiet variant below and
            the display's own banner both already said it the other way round;
            `camPaths.ts` owns the grammar now and everybody says it once.
          */}
          <p className="kh-band__text">
            {/* A resting state describes what IS, without apologising for it. */}
            <b id="kh-setup-title">No Kraken is showing this page.</b>
            {!dense && (
              <>
                {' '}
                Point CAM at this page, then {CAM_FRAME_RATE_LEAD} <b>{CAM_PATH_FRAME_RATE}</b>{' '}
                {CAM_FRAME_RATE_TAIL}.
              </>
            )}
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
              Paste this into CAM as the integration URL if the button above did not open CAM.
            </p>
          </div>
        )}
      </section>
    );
  }

  /*
   * The quiet variant, after round 2's R3.
   *
   * It used to be two numbered steps, four paragraphs and four side-by-side
   * buttons — 380 px of instruction on a page that was already 2,225 px tall.
   * A numbered list is for a procedure somebody follows once while looking at
   * two windows; this is a card somebody lands on when they are setting up a
   * second machine, and what they need is the address and one button. The
   * frame-rate step is a clause in the same sentence rather than a step of its
   * own, because it is one drag of one slider.
   *
   * The address appears here and NOWHERE else on the page: `AboutView` no
   * longer prints a "This installation" panel above this card saying the same
   * URL a second time.
   */
  return (
    <section className="kh-setup" data-testid="setup-about" aria-labelledby="kh-setup-title">
      <h2 id="kh-setup-title" className="kh-setup__title">
        Add to CAM
      </h2>
      <p className="kh-setup__lede">
        Point CAM at this address, then {CAM_FRAME_RATE_LEAD} <strong>{CAM_PATH_FRAME_RATE}</strong>{' '}
        {CAM_FRAME_RATE_TAIL}.
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
        <button
          type="button"
          className="kh-band__more"
          data-testid="setup-reveal-address"
          aria-expanded={revealed}
          aria-controls="kh-setup-more"
          onClick={() => {
            setRevealed((open) => !open);
          }}
        >
          {revealed ? 'Fewer ways' : 'Other ways'}
        </button>
      </div>
      {revealed && (
        <div className="kh-band__reveal" id="kh-setup-more">
          <div className="kh-row">
            <button type="button" className="kh-btn" data-testid="setup-copy-url" onClick={copy}>
              {copied ? 'Copied' : 'Copy the address'}
            </button>
            <a className="kh-btn" href={camInstallUrl(runtime.appUrl, true)}>
              Open in CAM Beta
            </a>
            {camChip}
          </div>
        </div>
      )}
    </section>
  );
}
