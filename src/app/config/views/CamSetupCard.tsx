import { useState } from 'react';

import {
  CAM_FRAME_RATE_INSTRUCTION,
  CAM_FRAME_RATE_LEAD,
  CAM_FRAME_RATE_TAIL,
  CAM_PATH_FRAME_RATE,
} from '../../../config/camPaths';
import { camInstallUrl } from '../../../config/knownHosts';
import { Chip, Code } from '../../../ui';
import { PanelClaim } from '../PanelClaim';
import { CLAIM_NO_KRAKEN_HERE } from '../panelClaims';

import type { PanelPresence } from '../panelPresence';
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
/**
 * The two variants are two prop shapes, not one shape with optional halves.
 *
 * `first-run` renders a claim about the panel, so it REQUIRES a
 * {@link PanelPresence}; `quiet` renders an address and a button, and asking
 * `AboutView` to derive a presence it does not otherwise need would be exactly
 * the ceremonial plumbing that teaches people to pass a plausible default. A
 * union makes the requirement local to the variant that has one.
 */
type CamSetupCardProps =
  | {
      runtime: ConfigRuntime;
      variant: 'first-run';
      /**
       * What this window may say about the panel — round 7's core.
       *
       * The band's headline is a sentence about the LCD, so it is a
       * `PanelClaim`, and a claim cannot be rendered without one of these. In
       * practice the band only mounts where nothing has ever been seen, which
       * is precisely why the argument is required rather than assumed: the
       * assumption is what the last six rounds were made of.
       */
      presence: PanelPresence;
      /**
       * The band, while something else on the page has the floor (round 3, F2).
       *
       * Two objects cannot both have 537 px. When the options panel opens, the
       * halo shrinks to a thumb and the band drops to the half of its sentence
       * that is news — *your Kraken has not shown up yet* — keeping its one
       * action. The instruction it drops is the same instruction the button
       * carries out, and it comes back the moment the panel closes.
       */
      dense?: boolean;
    }
  | { runtime: ConfigRuntime; variant: 'quiet' };

export function CamSetupCard(props: CamSetupCardProps) {
  const { runtime } = props;
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

  if (props.variant === 'first-run') {
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
            <PanelClaim
              claim={CLAIM_NO_KRAKEN_HERE}
              presence={props.presence}
              as="b"
              className="kh-band__claim"
              id="kh-setup-title"
              testId="setup-headline"
            />
            {props.dense !== true && (
              <>
                {' '}
                {/*
                  The instruction is ONE element, so a narrow window can make it
                  one LINE — round 12's setup-card compression.

                  At a 760 px window this sentence wrapped the card to 122 px,
                  and the card's height comes straight out of the canvas row: the
                  halo was 196 px on the first screen anybody ever sees. Under
                  ~800 px of editor grid `ui.css` clamps this span to a single
                  ellipsised line and the `title` carries the whole sentence, so
                  nothing is lost and the card fits in 88 px.

                  The `title` is built from `CAM_FRAME_RATE_INSTRUCTION` rather
                  than retyped, because the tooltip and the line under it saying
                  the menu route two different ways is the exact failure
                  `camPaths.ts` exists to prevent.
                */}
                <span
                  className="kh-band__say"
                  title={`Point CAM at this page, then ${CAM_FRAME_RATE_INSTRUCTION}.`}
                >
                  Point CAM at this page, then {CAM_FRAME_RATE_LEAD} <b>{CAM_PATH_FRAME_RATE}</b>{' '}
                  {CAM_FRAME_RATE_TAIL}.
                </span>
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
              {/*
                A link, not a button — the product decision behind this round.

                The band and this card each offered TWO one-click installs of
                the same integration, side by side, in the same weight, and the
                second one is for a channel almost nobody is on. Two equal
                buttons is a question ("which?"), and the honest answer is "the
                first one, unless you already know otherwise" — which is exactly
                what a primary button and a plain text link say without asking.
                Still reachable, still one press, and still here where somebody
                who IS on Beta will look for it.
              */}
              <a
                className="kh-band__more"
                data-testid="setup-cam-beta"
                href={camInstallUrl(runtime.appUrl, true)}
              >
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
            {/* A link, not a button — see the band's note above. */}
            <a
              className="kh-band__more"
              data-testid="setup-cam-beta"
              href={camInstallUrl(runtime.appUrl, true)}
            >
              Open in CAM Beta
            </a>
            {camChip}
          </div>
        </div>
      )}
    </section>
  );
}
