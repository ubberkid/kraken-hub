/**
 * Three Looks to start from, on the one screen that has nothing on it yet —
 * §4, and round 11's M-h.
 *
 * ## The finding
 *
 * A cold profile — no display has ever published to this origin — showed the
 * Add-to-CAM band and nothing else. The editor behind it was a video base with
 * no source: an empty stage, a rail with one row in it, and a first screen
 * whose only offer is a five-minute installation errand. §4 asks for template
 * cards on first run precisely so that the first thing a person can do is press
 * something and see the panel change, and the band had none: the templates were
 * reachable only through the Looks menu, which is two presses into a header
 * whose purpose is not obvious on the screen where nothing has happened yet.
 *
 * ## Why three, and why these three
 *
 * Three is what fits beside the band at CAM's 866x537 without displacing the
 * halo, which is the rule the band itself was cut down to obey. They are the
 * FIRST three of `LOOK_TEMPLATES` rather than a second table here: the template
 * list is ordered, `looksMenu.ts` owns it, and a hand-picked trio in this file
 * would be a fourth place that has an opinion about which Looks are good.
 *
 * ## Why the same card as the sheet
 *
 * `LookPreview` — one renderer, one budget, one set of module code. A card that
 * was a picture of a Look here and a live Look one press away would be the
 * screenshot problem §4 rejects, on the screen where a person is deciding
 * whether this app does anything at all.
 *
 * The chunk is the same `loadTemplates()` chunk the sheet fetches, and it is
 * fetched HERE only on a first run — a window that has seen a display never
 * mounts this component at all.
 */

import { useEffect, useMemo, useState } from 'react';

import { applyLookFile, resolveMedia, type MediaIndex } from '../../../../../state/look/file';
import { loadTemplates, type LookEntry } from '../../../editor/looksMenu';

import { crossFadeLookSwitch } from './crossFade';
import { LookPreview } from './LookPreview';
import { readMediaIndex } from './mediaIndex';
import { createPreviewBudget } from './previewPolicy';

import type { Geometry } from '../../../../../platform/geometry';
import type { AppState } from '../../../../../state/schema';
import type { MonitorSnapshot } from '../../../../../sync/monitorSnapshot';
import type { EditorApi } from '../../../editor/useEditor';

/** How many cards the band has room for beside the halo at 866x537. */
export const FIRST_RUN_TEMPLATE_COUNT = 3;

export interface FirstRunTemplatesProps {
  editor: EditorApi;
  state: AppState;
  /** The panel each card is standing in for, at its own pixel size. */
  panel: Geometry;
  monitor: MonitorSnapshot | null;
  monitorAt: number;
  /** The live Look's name follows the template that was pressed, as in the sheet. */
  onRename: (next: string) => void;
}

export function FirstRunTemplates({
  editor,
  state,
  panel,
  monitor,
  monitorAt,
  onRename,
}: FirstRunTemplatesProps) {
  const [templates, setTemplates] = useState<LookEntry[] | null>(null);

  /*
   * Its own budget, not the sheet's.
   *
   * The sheet is not mounted while this band is — they are two states of the
   * same column — so sharing an allocator would mean threading one through the
   * home screen for a pair of components that never coexist. Three cards is
   * well inside `MAX_LIVE_PREVIEWS` either way.
   */
  const budget = useMemo(() => createPreviewBudget(), []);

  useEffect(() => {
    let live = true;
    void loadTemplates().then((entries) => {
      if (live) setTemplates(entries.slice(0, FIRST_RUN_TEMPLATE_COUNT));
    });
    return () => {
      live = false;
    };
  }, []);

  /*
   * Nothing at all until the chunk lands.
   *
   * Not a row of three grey rectangles: this band sits under the one sentence a
   * first-run screen has to get read, and a placeholder that resolves into
   * something else a beat later moves that sentence. The chunk is a few kB from
   * the same origin.
   */
  if (templates === null || templates.length === 0) return null;

  return (
    <section
      className="kh-firstlooks"
      data-testid="first-run-templates"
      aria-label="Looks to start from"
    >
      {/*
        Two words, because the band's own column is 68 px wide.

        The cards stand in the canvas column's left gutter (`ui.css`), which is
        the width the halo does not use; a sentence there wrapped to three
        lines and pushed the third card into the floating strip. The label that
        has to fit is two words; the sentence is the `aria-label` above, where
        length costs nothing.
      */}
      <h2 className="kh-firstlooks__title">Start from</h2>
      <div className="kh-looks-grid kh-firstlooks__grid" data-testid="first-run-templates-grid">
        {templates.map((entry) => (
          <div className="kh-looks-item" key={entry.id}>
            <button
              type="button"
              className="kh-looks-item__apply"
              data-testid={`first-run-look-${entry.id}`}
              onClick={() => {
                /*
                 * The media index is read HERE, on the press — never on mount.
                 *
                 * `readMediaIndex()` opens `kraken-hub.v1` and, on a profile
                 * written before the merge, drives the pictures→media copy. The
                 * boot path is not allowed to do that (looks.spec.ts asserts it
                 * with an `indexedDB.open` counter, and `one-media-library`
                 * asserts the copy has NOT happened before the Library is
                 * opened) — and this band mounts on exactly the profile that
                 * has never opened anything. On a press it is a user gesture
                 * with a Look at the end of it, which is the same bargain the
                 * Looks sheet makes.
                 *
                 * After that it is the SAME apply the sheet makes — one undo
                 * entry, the name follows the Look, and the base cross-fades
                 * rather than cuts (§7's third transition).
                 */
                void readMediaIndex().then((media: MediaIndex) => {
                  const resolved = resolveMedia(entry.file, media);
                  crossFadeLookSwitch();
                  editor.applyLook(applyLookFile(state, resolved));
                  onRename(entry.file.name);
                });
              }}
            >
              <LookPreview
                previewId={`firstrun-${entry.id}`}
                file={entry.file}
                panel={panel}
                render={state.render}
                monitor={monitor}
                monitorAt={monitorAt}
                budget={budget}
              />
              <b>{entry.name}</b>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
