import { Suspense, lazy } from 'react';

import { Code, Panel } from '../../../ui';

import { CamSetupCard } from './CamSetupCard';
import { ConnectionSection } from './ConnectionSection';

import type { ConfigRuntime } from '../runtime';

/** Diagnostics probe a lot of APIs; keep them off this page's first paint. */
const DiagView = lazy(async () => {
  const m = await import('../../../diag/DiagView');
  return { default: m.DiagView };
});

/**
 * One page behind the footer's version line — About *and* Diagnostics.
 *
 * The design audit counted four destinations split across two rows in two type
 * styles: `Remote · Library · Diagnostics` in the home screen's quiet row, and
 * `About` down in the footer (F7, F8). Two of those four are the same errand.
 * Nobody opens "About" to read a licence; they open it because something is
 * wrong, or because they are setting up a second machine — which is exactly why
 * they would open "Diagnostics" too.
 *
 * So the disclosure row is now precisely `Remote · Library`, and everything
 * else — what this build is, how to add it to CAM, how the room connects, and
 * every probe and H-id — is one page reached by clicking the version string a
 * bug report needs anyway.
 *
 * Order is the order somebody needs it in: what this is, how to install it, how
 * it connects, and then the measurements. `#/diag` still resolves here (a hash
 * rewrite in `ConfigApp`, never a navigation — invariant I1/I2), so every doc
 * link and bookmark in the wild still lands on the content it named.
 */
export function AboutView({ runtime }: { runtime: ConfigRuntime }) {
  return (
    <>
      <Panel title="kraken-hub" hint="An open-source module hub for NZXT Kraken LCDs.">
        <p className="kh-hint">
          MIT licensed, statically hosted, no backend and no account. CAM opens this page twice —
          once visibly as the configuration browser, and once hidden with <code>?kraken=1</code> for
          the LCD itself. The two share one origin, which is how settings reach the display.
        </p>
      </Panel>
      <Panel title="This installation">
        <Code>{runtime.appUrl}</Code>
      </Panel>

      {/*
        "Add to CAM" lives here for good once a display has ever connected — the
        home screen shows a slim first-run band until then (see `displaySeen.ts`).
        Somebody reinstalling CAM or setting up a second machine looks here;
        nobody with a working cooler should be shown step one again.
      */}
      <CamSetupCard runtime={runtime} variant="quiet" />

      <ConnectionSection runtime={runtime} />

      <Suspense fallback={<p className="kh-hint">Running probes…</p>}>
        <DiagView runtime={runtime} />
      </Suspense>
    </>
  );
}
