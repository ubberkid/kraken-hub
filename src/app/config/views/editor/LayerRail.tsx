/**
 * The layer rail — the stack, top to bottom, front to back (§2.2).
 *
 * Ordered the way a person reads a stack rather than the way the array stores
 * one: `look.layers` is bottom-first because that is DOM order and DOM order is
 * z-order (§0.3), and this reverses it, because "the thing in front is at the
 * top of the list" is what every design tool has taught everybody.
 *
 * The base is pinned at the bottom with a `BASE` label and cannot be reordered
 * or removed — there is always exactly one base, and it never moves in the DOM
 * (§0.4). Its row is also the base PICKER: the module chips live inside it, so
 * "what is the background" is one question in one place instead of a chip row
 * floating somewhere else on the screen.
 *
 * Reordering is a drag, with two buttons behind it. The drag is the gesture the
 * spec asks for; the buttons are how it works from a keyboard, and they carry
 * the same op — `reorder`, which clamps to `[1, length-1]` so no gesture can
 * move the base.
 */

import { useRef, useState } from 'react';

import { BASE_LAYER_ID, MAX_LAYERS, type Layer } from '../../../../state/look/types';

import type { AnyKrakenModule } from '../../../../modules/types';
import type { EditorApi } from '../../editor/useEditor';
import type { ReactNode } from 'react';

export interface LayerRailProps {
  editor: EditorApi;
  onAdd: () => void;
  /** Marked in the rail when the budget meter names a heaviest layer. */
  heaviestId: string | null;
  /**
   * The base picker — the module chip row, handed in rather than rebuilt.
   *
   * The chips are the home screen's oldest gesture and several suites press
   * them by id; rendering a second copy here would be two rows of chips that
   * can disagree, which is the exact duplication the strip contract exists to
   * end. So the rail places the row it is given and owns none of its behaviour.
   */
  baseRow: ReactNode;
  /** The primary action and the nav, stacked under the base row in the column. */
  footer?: ReactNode;
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

export function LayerRail({ editor, onAdd, heaviestId, baseRow, footer }: LayerRailProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);

  const overlays = editor.overlays;
  const used = editor.layers.length;
  const full = used >= MAX_LAYERS;
  /*
   * Say the count before it bites — round 10's F4.
   *
   * The cap was a disabled button with a `title` on it, which is exactly the ESC
   * failure `research-esc-ux.md` §127 condemns: the limit is invisible until you
   * reach it, and then it is announced by a tooltip that a touch screen never
   * shows and a keyboard user has to hover to find. So the count appears while
   * there is still room to spend — one layer out, which is the point at which
   * "what shall I add next" becomes a decision — and at the cap the button's
   * silence is replaced by a sentence in the rail that says what the limit is
   * and why it exists.
   */
  const nearing = used >= MAX_LAYERS - 1;

  /** Front-first, which is the order the rail is read in. */
  const rows = [...overlays].reverse();

  const drop = (targetId: string): void => {
    const from = dragging.current;
    dragging.current = null;
    if (from === null || from === targetId) return;
    const toIndex = editor.layers.findIndex((l) => l.id === targetId);
    if (toIndex > 0) editor.move(from, toIndex);
  };

  return (
    <aside
      className="kh-rail"
      data-testid="layer-rail"
      data-full={full ? 'true' : 'false'}
      aria-label="Layers"
    >
      <button
        type="button"
        className="kh-rail__add"
        data-testid="rail-add"
        disabled={full}
        onClick={onAdd}
      >
        + Add a layer
      </button>

      {/*
        The cap, in the rail, in words (F4).

        Two sentences and never both: the count while there is room, and the
        reason once there is not. `role="status"` because the second one appears
        as a consequence of the press that filled the look, and a person who was
        using the keyboard should be told rather than left to wonder why the
        button went quiet.
      */}
      {nearing && (
        <p className="kh-rail__cap" data-testid="rail-cap" role="status">
          {full
            ? `This look is full — ${countWord(MAX_LAYERS)} layers is the most that fits on the wire.`
            : `${String(used)} of ${String(MAX_LAYERS)} layers`}
        </p>
      )}

      <ul className="kh-rail__list">
        {rows.map((layer) => {
          const index = editor.layers.findIndex((l) => l.id === layer.id);
          return (
            <li
              key={layer.id}
              className="kh-rail__row"
              data-testid={`layer-row-${layer.id}`}
              data-selected={editor.isSelected(layer.id) ? 'true' : 'false'}
              data-heaviest={layer.id === heaviestId ? 'true' : 'false'}
              data-locked={layer.locked === true ? 'true' : 'false'}
              /*
                A locked layer does not reorder by drag either (§2.2, M3).

                The z-order buttons stay live, because "locked" is about the
                canvas — a lock protects a layer from being nudged by a stray
                drag on the halo, not from being deliberately restacked in the
                list where its name and its lock are both visible.
              */
              draggable={layer.locked !== true}
              onDragStart={() => {
                dragging.current = layer.id;
              }}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(layer.id);
              }}
            >
              <button
                type="button"
                className="kh-rail__pick"
                aria-pressed={editor.isSelected(layer.id)}
                onClick={(e) => {
                  editor.select(layer.id, e.shiftKey);
                }}
              >
                <Glyph module={editor.modules.find((m) => m.id === layer.kind) ?? null} />
                {renaming === layer.id ? (
                  <input
                    className="kh-rail__rename"
                    ref={focusOnMount}
                    defaultValue={layer.name ?? ''}
                    aria-label="Layer name"
                    data-testid={`layer-rename-${layer.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    onBlur={(e) => {
                      editor.rename(layer.id, e.target.value);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span
                    className="kh-rail__name"
                    onDoubleClick={() => {
                      setRenaming(layer.id);
                    }}
                  >
                    {nameOf(layer, editor.modules)}
                  </span>
                )}
              </button>

              <button
                type="button"
                className="kh-rail__eye"
                aria-label={layer.on ? 'Hide this layer' : 'Show this layer'}
                aria-pressed={layer.on}
                data-testid={`layer-eye-${layer.id}`}
                onClick={() => {
                  editor.setOn(layer.id, !layer.on);
                }}
              >
                <span aria-hidden="true">{layer.on ? '◉' : '○'}</span>
              </button>

              {/*
                The lock (§2.2, M3).

                Beside the eye, because the two are the same kind of statement
                about a layer — one is "is it on the panel", the other is "may
                the canvas touch it" — and a person looking for either looks in
                the same place. `aria-pressed` rather than a checkbox: round 2's
                rule leaves no native checkbox on this surface.
              */}
              <button
                type="button"
                className="kh-rail__lock"
                aria-label={layer.locked === true ? 'Unlock this layer' : 'Lock this layer'}
                aria-pressed={layer.locked === true}
                data-testid={`layer-lock-${layer.id}`}
                onClick={() => {
                  editor.setLocked(layer.id, layer.locked !== true);
                }}
              >
                <LockGlyph locked={layer.locked === true} />
              </button>

              <span className="kh-rail__order">
                <button
                  type="button"
                  className="kh-rail__step"
                  aria-label="Bring forward"
                  data-testid={`layer-up-${layer.id}`}
                  onClick={() => {
                    editor.move(layer.id, index + 1);
                  }}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="kh-rail__step"
                  aria-label="Send backward"
                  data-testid={`layer-down-${layer.id}`}
                  onClick={() => {
                    editor.move(layer.id, index - 1);
                  }}
                >
                  <span aria-hidden="true">↓</span>
                </button>
              </span>

              <button
                type="button"
                className="kh-rail__del"
                aria-label="Remove this layer"
                data-testid={`layer-remove-${layer.id}`}
                onClick={() => {
                  editor.remove(layer.id);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        The base, pinned — and the base PICKER.

        The chips kept their ids on purpose: pressing one switches the
        background, pressing the one that is already the background opens its
        options. That is the gesture the home screen has had since round 1, and
        the rail is where it belongs now that a look has more than one layer.
      */}
      <div className="kh-rail__base" data-testid="layer-row-base">
        <button
          type="button"
          className="kh-rail__lab"
          aria-pressed={editor.isSelected(BASE_LAYER_ID)}
          data-testid="layer-select-base"
          onClick={() => {
            editor.select(BASE_LAYER_ID);
          }}
        >
          BASE
        </button>
        {baseRow}
      </div>

      {footer}
    </aside>
  );
}

/**
 * A padlock, drawn rather than typed.
 *
 * An emoji would be a font's opinion of a padlock — a different colour, a
 * different weight and a different baseline on every platform CAM runs on —
 * next to an eye and two arrows that are all glyphs in the app's own ink. The
 * shackle is up when the layer is unlocked, which is the whole of the state.
 */
function LockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg className="kh-rail__lockart" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path
        className="kh-rail__shackle"
        d={locked ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 8 0'}
        fill="none"
      />
    </svg>
  );
}

/** The module's own glyph, from the registry. Never a table in this file. */
function Glyph({ module }: { module: AnyKrakenModule | null }) {
  if (module === null) return <span className="kh-rail__glyph" aria-hidden="true" />;
  return (
    <svg className="kh-rail__glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d={module.icon} />
    </svg>
  );
}

/**
 * A small count as a word — "eight layers", not "8 layers".
 *
 * The sentence reads better spelled out, and the number is still DERIVED from
 * `MAX_LAYERS` rather than typed into the sentence: raising the cap changes the
 * word, and a cap this table has no word for falls back to the numeral instead
 * of printing the wrong one.
 */
const COUNT_WORDS: readonly string[] = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** A layer's name: the user's, or the kind's. Never an id, never "Layer 3". */
function nameOf(layer: Layer, modules: readonly AnyKrakenModule[]): string {
  if (layer.name !== undefined && layer.name !== '') return layer.name;
  const mod = modules.find((m) => m.id === layer.kind);
  return mod === undefined ? layer.kind : (mod.chipName ?? mod.name);
}
