import { Button } from '../../../ui';

/**
 * "Are you sure?" — asked once, in one shape, by every destructive act.
 *
 * ## Why it is a component and not a paragraph in `RemoteLibrary`
 *
 * It was a paragraph in `RemoteLibrary`, and round 6's minors are the bill.
 * The remote asked before deleting because "did I just delete the wrong thing
 * on a screen I cannot see" is a real question from a sofa; CAM's own shelf
 * deleted on the press, on the theory that the row and the finger are in the
 * same room. That reasoning was true of the *shelf* and false of the *act*: a
 * clip deleted in CAM is gone from the one database the LCD can read, there is
 * no undo anywhere in the product, and the tile that was under the cursor is
 * the one thing the user cannot see once the grid reflows. It was also the
 * only unconfirmed destructive action left in the app after the phone's batch
 * delete got its sheet — one act, two answers, decided by which file you were
 * looking at.
 *
 * So the sheet is a component both shelves mount. Adding a third destructive
 * act and giving it a bespoke dialog is possible; giving it *no* dialog now
 * requires deciding not to import this, which is the kind of decision that
 * shows up in a diff.
 *
 * `role="alertdialog"` and the same `.kh-confirm` classes both shelves already
 * shared, so this is a move rather than a redesign — the phone's sheet is
 * pixel-identical to the one it had.
 */
export function ConfirmSheet({
  question,
  confirmLabel,
  confirmTitle,
  keepTitle,
  testId,
  onConfirm,
  onCancel,
}: {
  /** The whole question, named subject included — never "Are you sure?". */
  question: string;
  confirmLabel: string;
  confirmTitle: string;
  keepTitle: string;
  /** Distinct per surface, so a suite can address the sheet it means. */
  testId: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="kh-confirm" data-testid={testId} role="alertdialog">
      <p className="kh-confirm__q">{question}</p>
      <div className="kh-confirm__row">
        {/*
          Keep is FIRST and unemphasised; Delete is primary but last.

          The safe answer is the one a thumb reaches without aiming, and the
          destructive one is the one that has to be chosen.
        */}
        <Button testId={`${testId}-no`} title={keepTitle} onClick={onCancel}>
          Keep
        </Button>
        <Button primary testId={`${testId}-yes`} title={confirmTitle} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
