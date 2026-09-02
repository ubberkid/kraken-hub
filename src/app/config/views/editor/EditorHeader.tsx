/**
 * The editor's header: the Look's name, undo/redo, the budget meter (§2).
 *
 * Three things and a height cap. Everything else a header could hold is
 * somewhere better — the nav is one line lower, the module chips are in the
 * rail's base row, and there are no tabs at all, which is the point of the whole
 * design: the home screen never grows another one.
 *
 * ## The Looks menu opens a sheet, and holds nothing itself
 *
 * W5 shipped a dropdown with a derived template list inside it, because the
 * template table was being written the same afternoon. The table exists now, and
 * so do live previews, files, the gallery and the carousel — none of which fit
 * in a 280 px menu. So the menu is two items: rename the live Look, and open the
 * Looks sheet, which is where §4 actually lives.
 *
 * The header still owns the name, because the name is what the button says.
 */

import { useState } from 'react';

import { Meter } from '../../../../ui';
import { lookMenuLabel, MAX_LOOK_NAME } from '../../editor/looksMenu';

import type { BudgetReading } from '../../editor/budget';
import type { ReactNode } from 'react';

export interface EditorHeaderProps {
  name: string | null;
  onRename: (next: string) => void;
  /** Open the Looks sheet — templates, Your Looks, the gallery, files, rotation. */
  onOpenLooks: () => void;
  budget: BudgetReading;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** The nav row, rendered inside the header so it never crosses the fold. */
  children?: ReactNode;
}

/**
 * Focus an input the moment it appears, without `autoFocus`.
 *
 * The a11y rule that bans the attribute is about a page that steals focus on
 * LOAD. This input does not exist until a person presses Rename, and landing
 * the caret is the entire content of that press — so the behaviour is right and
 * the attribute is simply the wrong way to ask for it.
 */
function focusOnMount(el: HTMLInputElement | null): void {
  el?.focus();
}

export function EditorHeader({
  name,
  onRename,
  onOpenLooks,
  budget,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  children,
}: EditorHeaderProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <header className="kh-ed__top" data-testid="editor-header">
      {editing ? (
        <input
          className="kh-ed__name"
          ref={focusOnMount}
          defaultValue={name ?? ''}
          maxLength={MAX_LOOK_NAME}
          aria-label="Look name"
          data-testid="look-name-input"
          onBlur={(e) => {
            onRename(e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="kh-ed__look"
          data-testid="looks-menu"
          aria-expanded={open}
          aria-controls="kh-looks-menu"
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {lookMenuLabel(name)} <span aria-hidden="true">▾</span>
        </button>
      )}

      <span className="kh-ed__hist">
        <button
          type="button"
          className="kh-iconbtn"
          data-testid="undo"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <span aria-hidden="true">↶</span>
        </button>
        <button
          type="button"
          className="kh-iconbtn"
          data-testid="redo"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <span aria-hidden="true">↷</span>
        </button>
      </span>

      {/*
        The meter, and the sentence that says which of its two voices is
        speaking. `data-estimated` is what the suite reads, so a wording change
        is not a test change — the same trick `PanelClaim`'s `data-presence`
        plays one screen over.

        ## Round 10's F6 — the meter said nothing, twice over

        Measured with four layers on the look: the track was 0 px wide (fixed in
        `ui.css` — it is `flex: 1` in a box with no width to share) and the
        number beside it was a bare em-dash, because the only figure this
        component printed was the MEASURED frame rate and there was no display on
        the other end to publish one.

        A dash is the app declining to say a thing it knows. It has the estimate
        — `budgetReading` computes it from what every module declares it costs —
        and the estimate is what the bar is already drawn from, so the figure is
        that same estimate as a percentage, `data-estimated` says which voice it
        is in, and the attribution ("The video layer is the heaviest thing in
        this look") rides along as the tooltip. Two voices, both of them
        speaking; no third state that renders punctuation.

        ## Round 10's F3 and F10 — the bar, and the words beside it

        The bar filled to 100 % on one video base and said *calm*; it was still
        100 % with eight layers on top of it, because `fill` was
        `min(1, cost.total)` and one video base IS 1.0 by definition. It reads
        against the governor's own headroom marks now (`budget.ts`), and the
        bar's COLOUR is keyed off `data-verdict` in `ui.css` — so "calm at
        100 %" is no longer a state this component can render.

        And the label: it wanted 275 px in the 182 the header can spare, so
        every sentence ended in an ellipsis where the honesty was.
        `budget.label` is the same claim in two or three words, out of the same
        registry; the full sentence is the `title`, where there is room for it.
      */}
      <span
        className="kh-ed__budget"
        data-testid="budget-meter"
        data-estimated={budget.estimated ? 'true' : 'false'}
        data-verdict={budget.verdict}
        data-fill={String(Math.round(budget.fill * 100))}
        title={budget.detail === null ? budget.headline : `${budget.headline} ${budget.detail}`}
      >
        <Meter pct={budget.fill * 100} label={budget.label} />
        <b className="kh-tnum" data-testid="budget-figure">
          {budget.fps === null
            ? `${String(Math.round(budget.fill * 100))}%`
            : `${String(budget.fps)} fps`}
        </b>
      </span>

      {children}

      {open && (
        <div className="kh-looks" id="kh-looks-menu" data-testid="looks-panel" role="menu">
          <button
            type="button"
            className="kh-looks__item"
            role="menuitem"
            data-testid="looks-rename"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            Rename this look
          </button>
          <button
            type="button"
            className="kh-looks__item"
            role="menuitem"
            data-testid="looks-browse"
            onClick={() => {
              setOpen(false);
              onOpenLooks();
            }}
          >
            <b>Looks…</b>
            <small>Templates, the ones you saved, the gallery, and files.</small>
          </button>
        </div>
      )}
    </header>
  );
}
