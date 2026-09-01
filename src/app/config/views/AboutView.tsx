import { useEffect, useState } from 'react';

import { buildInfo } from '../../../buildInfo';
import { Panel } from '../../../ui';
import { useSync } from '../useSync';

import { CamSetupCard } from './CamSetupCard';
import { ConnectionSection } from './ConnectionSection';
import { ReportSection } from './ReportSection';

import type { ConfigRuntime } from '../runtime';

/**
 * One page behind the footer's version line.
 *
 * ## Round 1 merged it; round 2 made it readable
 *
 * The design audit counted four destinations split across two rows in two type
 * styles, two of which were the same errand: nobody opens "About" to read a
 * licence, they open it because something is wrong or because they are setting
 * up a second machine — which is exactly why they would open "Diagnostics" too.
 * So they became one page.
 *
 * Then round 2 put a ruler on the result and got **2,225 px, 498 words and 14
 * controls** — four screens of CAM's window, headed by internal
 * hardware-checklist ids, listing `?kraken=1` query strings, file paths, a
 * `SHA-256(code)` note, a codec matrix and a bulleted inventory of transports.
 * Every fact on it was true. Almost none of it was for a reader: it was the
 * contents of a JSON report, printed.
 *
 * So the page is three calm sections, in the order somebody needs them:
 *
 *  1. **About** — what this is, in one sentence, and the one card that puts it
 *     on a Kraken. This installation's address appears exactly once, inside
 *     that card, next to the button that uses it.
 *  2. **Connection** — the room, in plain labels. Plumbing one door down.
 *  3. **Report** — what a report is, one button that copies it, and every probe
 *     behind "Show the technical detail".
 *
 * `#/diag` still resolves here (a hash rewrite in `ConfigApp`, never a
 * navigation — invariant I1/I2), so every doc link and bookmark in the wild
 * still lands on the content it named.
 *
 * ## Why the sync handle lives here
 *
 * Both Connection and Report need the paired room — one to describe it, one to
 * pull a report across it — and `useSync` starts a real transport. Two calls
 * would open two connections to the same topic, so this page owns the one
 * handle and hands it down.
 */

/** The Connection drawer's "heard 3s ago" ticks off this; 1 Hz is plenty. */
const CLOCK_MS = 1000;

export function AboutView({ runtime }: { runtime: ConfigRuntime }) {
  const sync = useSync(runtime);
  const info = buildInfo();

  /** Sampled OUTSIDE render: `Date.now()` during render is not idempotent. */
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <Panel title="About">
        <p className="kh-hint">
          Video, pictures, a clock or your PC&rsquo;s readings on a Kraken LCD. Open source, no
          account, nothing of ours in between.
        </p>
        {/*
          "Add to CAM" lives here for good once a display has ever connected —
          the home screen shows a slim first-run band until then (see
          `displaySeen.ts`). Somebody reinstalling CAM or setting up a second
          machine looks here; nobody with a working cooler should be shown step
          one again.
        */}
        <CamSetupCard runtime={runtime} variant="quiet" />
        <p className="kh-hint kh-about__build" data-testid="about-build">
          Version {info.version} · {info.gitSha} · MIT licensed
        </p>
      </Panel>

      <ConnectionSection runtime={runtime} sync={sync} now={now} />

      <ReportSection runtime={runtime} sync={sync} />
    </>
  );
}
