/**
 * The element a {@link PanelClaimSpec} is drawn as.
 *
 * Split from `panelClaims.ts` only because Fast Refresh requires a `.tsx`
 * module to export components and nothing else (`react-refresh/only-export-components`)
 * — the same split `ui/fitOptions.ts` makes beside `ui/Framing.tsx`. There are
 * no sentences in this file: it renders whatever `panelClaimText` returns for
 * the presence it was handed, which is the entire contract.
 */

import { panelClaimText, type PanelClaimSpec } from './panelClaims';

import type { PanelPresence } from './panelPresence';
import type { ReactElement } from 'react';

/** The elements a claim is ever rendered as. A claim is a sentence, not a box. */
export type PanelClaimTag = 'span' | 'b' | 'small' | 'p';

/**
 * A claim, rendered.
 *
 * The `presence` prop is required and has no default: a call site that has not
 * worked out what this window knows cannot compile. `data-presence` is on the
 * element for the same reason the ladder's last card already carried one — the
 * e2e suite asserts on the state that produced the sentence rather than on the
 * sentence, so a wording change is not a test change.
 */
export function PanelClaim({
  claim: spec,
  presence,
  as = 'span',
  id,
  className,
  testId,
}: {
  claim: PanelClaimSpec;
  presence: PanelPresence;
  as?: PanelClaimTag;
  /** For `aria-labelledby`, where the claim IS the region's name. */
  id?: string;
  className?: string;
  testId?: string;
}): ReactElement {
  const Tag = as;
  return (
    <Tag id={id} className={className} data-testid={testId} data-presence={presence}>
      {panelClaimText(spec, presence)}
    </Tag>
  );
}
