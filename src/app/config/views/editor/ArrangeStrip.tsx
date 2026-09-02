/**
 * The strip a MULTI selection gets — align and distribute (§2.1, F7).
 *
 * `⌘A`, a marquee and a shift-tap all produced a selection with nothing to do
 * with it: the rail marked its rows, the canvas drew nothing, and the strip went
 * on showing the background's controls. A selection of several layers is a
 * different subject from a selection of one, so it gets a different row — the
 * six alignments, a reference to align them TO, and distribute — and it appears
 * only when there are at least two, because aligning one layer to itself is not
 * an operation.
 *
 * Nothing here computes anything. `arrange.ts` turns a press into the list of
 * transform patches, and `editor.transformMany` commits the lot as one history
 * entry, so one press is one undo.
 */

import { Segmented } from '../../../../ui';

import type { AlignEdge, AlignRef } from '../../editor/arrange';

export interface ArrangeStripProps {
  /** How many layers the row is speaking for — shown, so it is not a guess. */
  count: number;
  reference: AlignRef;
  onReference: (next: AlignRef) => void;
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: 'x' | 'y') => void;
  /** Distribute needs a "between", so it needs three. */
  canDistribute: boolean;
}

const ALIGNMENTS: readonly { edge: AlignEdge; label: string; glyph: string }[] = [
  { edge: 'left', label: 'Align left', glyph: '⇤' },
  { edge: 'centre', label: 'Align centre', glyph: '⇹' },
  { edge: 'right', label: 'Align right', glyph: '⇥' },
  { edge: 'top', label: 'Align top', glyph: '⤒' },
  { edge: 'middle', label: 'Align middle', glyph: '⇳' },
  { edge: 'bottom', label: 'Align bottom', glyph: '⤓' },
];

export function ArrangeStrip({
  count,
  reference,
  onReference,
  onAlign,
  onDistribute,
  canDistribute,
}: ArrangeStripProps) {
  return (
    <>
      <span className="kh-op" data-testid="ops-selection-count">
        <span className="kh-op__lab">
          <b className="kh-tnum">{count}</b> selected
        </span>
      </span>

      <span className="kh-op" data-testid="ops-align">
        <span className="kh-op__lab">Align</span>
        <span className="kh-op__pair">
          {ALIGNMENTS.map(({ edge, label, glyph }) => (
            <button
              key={edge}
              type="button"
              className="kh-op__step"
              aria-label={label}
              title={label}
              data-testid={`ops-align-${edge}`}
              onClick={() => {
                onAlign(edge);
              }}
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          ))}
        </span>
      </span>

      {/*
        "To what" is half of what align means, and it was the half the old
        single-selection strip never had to ask: to the CANVAS puts the group
        against the panel's edge, to the SELECTION lines the members up with
        each other and leaves the group where it is.
      */}
      <span className="kh-op" data-testid="ops-align-ref">
        <span className="kh-op__lab">To</span>
        <Segmented
          id="ops-align-ref"
          ariaLabel="Align to"
          value={reference}
          options={[
            { value: 'canvas', label: 'Canvas' },
            { value: 'selection', label: 'Selection' },
          ]}
          onChange={(next) => {
            onReference(next === 'selection' ? 'selection' : 'canvas');
          }}
        />
      </span>

      <span className="kh-op" data-testid="ops-distribute">
        <span className="kh-op__lab">Distribute</span>
        <span className="kh-op__pair">
          <button
            type="button"
            className="kh-op__step"
            aria-label="Distribute horizontally"
            title={canDistribute ? 'Distribute horizontally' : 'Needs three or more layers.'}
            data-testid="ops-distribute-x"
            disabled={!canDistribute}
            onClick={() => {
              onDistribute('x');
            }}
          >
            <span aria-hidden="true">⇹</span>
          </button>
          <button
            type="button"
            className="kh-op__step"
            aria-label="Distribute vertically"
            title={canDistribute ? 'Distribute vertically' : 'Needs three or more layers.'}
            data-testid="ops-distribute-y"
            disabled={!canDistribute}
            onClick={() => {
              onDistribute('y');
            }}
          >
            <span aria-hidden="true">⇳</span>
          </button>
        </span>
      </span>
    </>
  );
}
