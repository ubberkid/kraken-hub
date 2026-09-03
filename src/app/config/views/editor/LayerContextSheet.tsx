/**
 * Long press → the four things a right-click does (§8).
 *
 * It was written inside `RemoteEditor` because the phone was the only surface
 * with a long press. It is not any more: `touch` is a POINTER fact rather than
 * a width fact, so a tablet or a landscape phone running the desktop editor
 * gets the same gesture, and a second copy of this list on that surface would
 * be a second set of ops one wave from disagreeing with these.
 *
 * Duplicate, front, back, delete — every one of them an existing op, none of
 * them new behaviour, and all four one thumb-width tall.
 */

import type { Layer } from '../../../../state/look/types';
import type { EditorApi } from '../../editor/useEditor';

export interface LayerContextSheetProps {
  editor: EditorApi;
  /** The layer the press landed on. */
  layer: Layer;
  onClose: () => void;
  /** Extra classes for the surface hosting it — the phone's sheet, or the rail. */
  className?: string;
  /** What the sweeps call it. The phone kept its own name from round 12. */
  testId?: string;
}

export function LayerContextSheet({
  editor,
  layer,
  onClose,
  className,
  testId = 'layer-context',
}: LayerContextSheetProps) {
  const act = (run: () => void): (() => void) => {
    return () => {
      run();
      onClose();
    };
  };
  return (
    <div
      className={`kh-sheet ${className ?? ''}`.trim()}
      data-testid={testId}
      role="group"
      aria-label="Layer actions"
    >
      <p className="kh-looks__head">{layer.name ?? layer.kind}</p>
      <button
        type="button"
        className="kh-looks__item"
        data-testid="remote-context-duplicate"
        onClick={act(() => {
          editor.duplicate(layer.id);
        })}
      >
        Duplicate
      </button>
      <button
        type="button"
        className="kh-looks__item"
        data-testid="remote-context-front"
        onClick={act(() => {
          editor.move(layer.id, editor.layers.length - 1);
        })}
      >
        Bring to front
      </button>
      <button
        type="button"
        className="kh-looks__item"
        data-testid="remote-context-back"
        onClick={act(() => {
          editor.move(layer.id, 1);
        })}
      >
        Send to back
      </button>
      <button
        type="button"
        className="kh-looks__item"
        data-testid="remote-context-remove"
        onClick={act(() => {
          editor.remove(layer.id);
        })}
      >
        Remove
      </button>
      <button
        type="button"
        className="kh-looks__item"
        data-testid="remote-context-close"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}
