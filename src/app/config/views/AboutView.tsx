import { Code, Panel } from '../../../ui';

import type { ConfigRuntime } from '../runtime';

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
    </>
  );
}
