/**
 * "Add a layer" — the one creation gesture (§3).
 *
 * Four groups, because ESC's taxonomy is right: **Content**, **Data**, **Time**,
 * **Audio**. What is different is that every tile is a real kind from the
 * registry with the module's own glyph, name and one-line summary — so a module
 * added later appears here with no edit to this file, which is exactly what the
 * old four-chip row could not do.
 *
 * The Audio group is present and GREYED, with the reason written on it: those
 * layers consume a companion this build does not ship yet. Hiding them would be
 * tidier and would also be the app pretending the gap is not there; naming the
 * condition is the same rule the presence spine applies to every other claim.
 *
 * Choosing a tile adds the layer with smart placement, selects it, and shows its
 * strip — three things, one press, and the sheet closes because the answer to
 * "add a layer" is a layer, not another sheet.
 */

import { IMAGE_DEFAULTS } from '../../../../modules/image/schema';
import {
  SOLID_BASE_CFG,
  SOLID_BASE_KIND,
  baseCapableKinds,
  hasSolidBase,
} from '../../editor/basePicker';

import type { AnyKrakenModule } from '../../../../modules/types';

/** The four groups, in ESC's order because it is the order people expect. */
export type AddGroup = 'content' | 'data' | 'time' | 'audio';

const GROUP_LABEL: Readonly<Record<AddGroup, string>> = {
  content: 'Content',
  data: 'Data',
  time: 'Time',
  audio: 'Audio',
};

/**
 * A sticker is an IMAGE with the defaults a transparent PNG wants (§10).
 *
 * `fit: 'contain'` because a logo cropped to fill its box is not a logo any
 * more, and no background at all because the image module's own default is
 * `#000000` — which turns every transparent PNG into a black square, which is
 * exactly the disappointment this tile exists to remove.
 *
 * It is DATA in this sheet and nothing else: no new kind, no new field, no
 * branch in the renderer. `useEditor.add` seeds the new layer's config with it.
 */
const STICKER_CFG = {
  ...IMAGE_DEFAULTS,
  background: 'transparent',
  render: { ...IMAGE_DEFAULTS.render, fit: 'contain' as const },
};

/**
 * Which group an OVERLAY kind belongs in.
 *
 * A small table rather than a manifest field, and deliberately: the grouping is
 * a property of the SHEET's information design, not of the module, and a fork's
 * module that this build has never heard of lands in Content, which is the
 * honest default for "a thing you put on the panel".
 *
 * What this table must NOT decide is whether a kind is an overlay at all. Round
 * 10's M7: `effect` was listed here under Content and appeared there and only
 * there, so the app filed a full-panel BACKGROUND — `roles: ['base', 'overlay']`
 * in its own manifest — as a piece of content you lay on top of one, while the
 * Background row offered a single tile ("Solid colour") and no way to reach
 * Video, Effect, Picture, Clock or Stats as the thing behind everything. The
 * base/overlay split comes off `layer.roles` now, which is where the module
 * states it; this table only sorts what is already known to be an overlay.
 */
const GROUP_OF: Readonly<Record<string, AddGroup>> = {
  text: 'content',
  shape: 'content',
  image: 'content',
  effect: 'content',
  icon: 'content',
  stats: 'data',
  clock: 'time',
  date: 'time',
};

/**
 * The audio layers, named but not yet buildable.
 *
 * They are not registry entries — nothing would render them — so they are the
 * one hard-coded list in this file, and every one of them is disabled with the
 * same sentence. `design-editor-ux.md` §10 lists them as parity items; this is
 * the app saying so out loud rather than quietly omitting them.
 */
const AUDIO_TILES: readonly { id: string; name: string; summary: string }[] = [
  /*
   * "Now playing" is what §10 calls the first of these, and it is not what the
   * tile can be called here: it is a present-progressive claim about a panel,
   * and `vocabulary.test.ts` requires every one of those to go through the
   * presence spine. A tile for a layer that cannot yet be added has nothing to
   * be tensed against, so the name is the THING rather than the state — which
   * is also the shorter and clearer label.
   */
  { id: 'now-playing', name: 'Track', summary: 'Title and artist, from the audio companion.' },
  { id: 'album-art', name: 'Album art', summary: 'Cover art, from the audio companion.' },
  { id: 'visualizer', name: 'Visualizer', summary: 'Bars or a ring that move with the sound.' },
];

export const AUDIO_UNAVAILABLE = 'Needs the audio companion.';

export interface AddSheetProps {
  modules: readonly AnyKrakenModule[];
  /** `false` when the look is full — every tile says so rather than lying. */
  canAdd: boolean;
  /** Add an overlay, optionally seeded with a config this tile stands for. */
  onAdd: (kind: string, cfg?: unknown) => void;
  /** Replace the BASE — the one row in this sheet that is not an overlay. */
  onBase: (kind: string, cfg?: unknown) => void;
  onClose: () => void;
}

export function AddSheet({ modules, canAdd, onAdd, onBase, onClose }: AddSheetProps) {
  const overlayKinds = modules.filter((m) => (m.layer?.roles ?? []).includes('overlay'));
  /*
   * The Background row, derived — M7.
   *
   * `layer.roles` is the module's own statement about where it may sit, and it
   * is the only thing that decides this row: `video`, `effect`, `image`,
   * `shape`, `clock` and `stats` declare `'base'`; `text`, `icon` and `date`
   * declare only `'overlay'` and therefore cannot appear here, whatever a table
   * in this file might have said. A kind added to the registry next month lands
   * in the right row with no edit.
   *
   * The filter itself moved to `editor/basePicker.ts` in round 11 — the rail's
   * chip row is the same question asked on another surface, and it used to
   * answer it differently (M-a).
   */
  const baseKinds = baseCapableKinds(modules);
  const hasImage = modules.some((m) => m.id === 'image');
  const hasShape = hasSolidBase(modules);

  const groups: { group: AddGroup; tiles: AnyKrakenModule[] }[] = (
    ['content', 'data', 'time'] as const
  ).map((group) => ({
    group,
    tiles: overlayKinds.filter((m) => (GROUP_OF[m.id] ?? 'content') === group),
  }));

  return (
    <section className="kh-sheet" data-testid="add-sheet" aria-label="Add a layer">
      <header className="kh-sheet__head">
        <h2>Add a layer</h2>
        <button
          type="button"
          className="kh-iconbtn"
          data-testid="add-sheet-close"
          aria-label="Close"
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="kh-sheet__body">
        {groups.map(({ group, tiles }) =>
          tiles.length === 0 ? null : (
            <section key={group} className="kh-sheet__group">
              <h3>{GROUP_LABEL[group]}</h3>
              <div className="kh-tiles">
                {tiles.map((mod) => (
                  <button
                    key={mod.id}
                    type="button"
                    className="kh-tile"
                    data-testid={`add-tile-${mod.id}`}
                    disabled={!canAdd}
                    title={canAdd ? '' : 'This look is full.'}
                    onClick={() => {
                      onAdd(mod.id);
                    }}
                  >
                    <svg className="kh-tile__art" viewBox="0 0 24 24" aria-hidden="true">
                      <path d={mod.icon} />
                    </svg>
                    <b>{mod.chipName ?? mod.name}</b>
                    <small>{mod.summary}</small>
                  </button>
                ))}

                {/*
                  Sticker — a picture that behaves like a sticker (§10).

                  It is the image kind, which is already overlay-capable, with
                  the two settings a transparent PNG needs pre-answered. Shipping
                  it as a tile rather than as a kind is the whole point: there is
                  nothing here the renderer, the wire or the validator has to
                  learn, and a user who wants the other behaviour just changes
                  Fit back.
                */}
                {group === 'content' && hasImage && (
                  <button
                    type="button"
                    className="kh-tile"
                    data-testid="add-tile-sticker"
                    disabled={!canAdd}
                    title={canAdd ? '' : 'This look is full.'}
                    onClick={() => {
                      onAdd('image', STICKER_CFG);
                    }}
                  >
                    <svg className="kh-tile__art" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 4h11l5 5v11H4z M15 4v5h5" />
                    </svg>
                    <b>Sticker</b>
                    <small>A transparent picture, laid over what is behind it.</small>
                  </button>
                )}
              </div>
            </section>
          ),
        )}

        {/*
          The one row here that replaces the BACKGROUND rather than adding to it.

          §10 lists "Solid base" as a parity item, and the shape kind already is
          one — what was missing was the config that makes a translucent overlay
          band into a flat ground. `SOLID_BASE_CFG` is that config, exported from
          the module beside the defaults it differs from, so this sheet and the
          look templates cannot disagree about what "solid" means.
        */}
        {(baseKinds.length > 0 || hasShape) && (
          <section className="kh-sheet__group" data-testid="add-group-base">
            <h3>
              Background <small className="kh-sheet__why">Replaces what is behind.</small>
            </h3>
            <div className="kh-tiles">
              {baseKinds.map((mod) => (
                <button
                  key={mod.id}
                  type="button"
                  className="kh-tile"
                  data-testid={`add-base-${mod.id}`}
                  onClick={() => {
                    onBase(mod.id);
                  }}
                >
                  <svg className="kh-tile__art" viewBox="0 0 24 24" aria-hidden="true">
                    <path d={mod.icon} />
                  </svg>
                  <b>{mod.chipName ?? mod.name}</b>
                  <small>{mod.summary}</small>
                </button>
              ))}

              {hasShape && (
                <button
                  type="button"
                  className="kh-tile"
                  data-testid="add-tile-solid"
                  onClick={() => {
                    onBase(SOLID_BASE_KIND, SOLID_BASE_CFG);
                  }}
                >
                  <svg className="kh-tile__art" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" />
                  </svg>
                  <b>Solid colour</b>
                  <small>A flat ground, edge to edge.</small>
                </button>
              )}
            </div>
          </section>
        )}

        <section className="kh-sheet__group" data-testid="add-group-audio">
          <h3>
            {GROUP_LABEL.audio} <small className="kh-sheet__why">{AUDIO_UNAVAILABLE}</small>
          </h3>
          <div className="kh-tiles">
            {AUDIO_TILES.map((tile) => (
              <button
                key={tile.id}
                type="button"
                className="kh-tile kh-tile--off"
                data-testid={`add-tile-${tile.id}`}
                disabled
                title={AUDIO_UNAVAILABLE}
              >
                <span className="kh-tile__art" aria-hidden="true" />
                <b>{tile.name}</b>
                <small>{tile.summary}</small>
              </button>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
