/**
 * The phone edits the same Look — §8, principle 10.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is not a second editor. Every decision it makes is made by the same pure
 * modules CAM's editor uses — `gesture`, `snap`, `bounds`, `ops`, `history`,
 * `placement`, through the same `useEditor` — and every pixel of chrome around
 * the canvas is the same component: `SelectionStrip` is the strip, `LayerRail`
 * is the rail, `AddSheet` is the add sheet. A phone-shaped copy of any of them
 * would be a second product with a second idea of what a look is, and the
 * strip contract exists precisely to stop that.
 *
 * It is also not a library, a file picker or a settings mirror. **The phone is
 * the remote** — that is the user's own law, and W1 spent a wave enforcing it
 * (`surface.ts`). Editing an arrangement does not move any bytes: a Look is
 * layers, transforms and configs, all of which are already in the synced
 * document, and nothing on this screen can ingest a file, open a database or
 * claim a copy. `RemoteEditor.test.tsx` holds that as a property rather than a
 * promise.
 *
 * ## The canvas is the RING
 *
 * The remote's first job is still play / hold / skip / volume, so the ring
 * stays the ring: this surface mounts the very same `RemoteRing`, live replica
 * and all, at a size a thumb can work with, and draws `EditorOverlay` above it.
 * The overlay is the desktop's overlay — same box, same handles, same guides,
 * same HUD, same commit path — in `touch` mode: 44 px targets, pinch to scale,
 * two fingers to rotate, long press for the context sheet.
 *
 * One thing the phone cannot have is the compositor. `replica.ts` runs ONE
 * module renderer, because pixels never cross the wire and the picture modules
 * live in CAM's IndexedDB; there is no `LayerHost` here to paint a drag onto.
 * So the preview channel paints **ghosts** instead — one box per overlay layer,
 * positioned by `hostStyle()`, the compositor's own function, and moved by one
 * style write per frame exactly as the halo moves a real host (I4). A ghost is
 * drawn as a wireframe and never pretends to be the layer's pixels; what it
 * shows is the arrangement, which is the thing being edited.
 *
 * ## …and it says so
 *
 * The wire body carries `look` (W1c: `SyncStateBody.look`, envelope `v: 2`,
 * per-leaf HLC last-writer-wins), so an edit made here reaches the panel from a
 * paired phone as well as from CAM's own window. That is still a claim about
 * DELIVERY rather than about presence — a room that is joined but offline
 * delivers nothing — so it still goes through `lookReach.ts` into the
 * registered three-tense `CLAIM_ARRANGEMENT`, and the phone never says the
 * Kraken has an arrangement it cannot know the Kraken has.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { getModule } from '../../../../modules/registry';
import { hostStyle, transformCss } from '../../../../render/layerBox';
import { applyLookFile, exportLook, resolveMedia } from '../../../../state/look/file';
import { BASE_LAYER_ID, MAX_LAYERS, type Layer, type LayerId } from '../../../../state/look/types';
import { withModuleConfig, selectLayerConfig } from '../../../../state/selectors';
import { Notice, Segmented } from '../../../../ui';
import { withBaseKind } from '../../../state/switchBase';
import {
  lookMenuLabel,
  loadTemplates,
  MAX_LOOK_NAME,
  UNTITLED_LOOK,
  type LookEntry,
} from '../../editor/looksMenu';
import {
  addLook,
  deleteSaved,
  readLooksDoc,
  readLookName,
  renameSaved,
  subscribeLooks,
  toggleFavourite,
  updateLooksDoc,
  writeLookName,
  type LooksDoc,
} from '../../editor/looksStore';
import { resize as resizeLayer } from '../../editor/ops';
import { useEditor } from '../../editor/useEditor';
import { PanelClaim } from '../../PanelClaim';
import { CLAIM_ARRANGEMENT } from '../../panelClaims';
import { replicaGeometry } from '../../replica';
import { ownsBytes } from '../../surface';
import { AddSheet } from '../editor/AddSheet';
import { EditorOverlay } from '../editor/EditorCanvas';
import { InspectorSheet } from '../editor/InspectorSheet';
import { LayerContextSheet } from '../editor/LayerContextSheet';
import { LayerRail } from '../editor/LayerRail';
import { loadGallery } from '../editor/looks/gallery';
import { SelectionStrip } from '../editor/SelectionStrip';
import { RemoteRing } from '../RemoteRing';

import { arrangementPresence } from './lookReach';

import type { AppState } from '../../../../state/schema';
import type { PanelPresence } from '../../panelPresence';
import type { ConfigRuntime } from '../../runtime';
import type { RemoteRingProps } from '../RemoteRing';

/**
 * The editing ring's diameter, in CSS px.
 *
 * 300 on a 390 px phone: the canvas takes the width it can while leaving the
 * strip, the buttons and the claim on the same screen, and 44 px handles on a
 * 300 px circle are handles rather than a covering. The remote's own ring stays
 * 132 — this is the one number editing changes.
 */
export const EDIT_RING_PX = 300;

/** What the strip's deeper controls are, and where they live. */
export type StripEscape = 'source' | 'loop' | 'quality' | 'more';

export interface RemoteEditorProps {
  runtime: ConfigRuntime;
  /**
   * Whether an edit made here reaches the panel — `lookReach.ts`'s `delivers`.
   *
   * The room is joined AND the transport is up. Supplied by the caller because
   * the transport's state is the caller's to know; this component adds the one
   * other path (`ownsBytes`, shared storage) at the point of use.
   */
  delivers: boolean;
  state: AppState;
  /** What this window knows about the panel — the ordinary spine's answer. */
  presence: PanelPresence;
  /** Everything the ring needs. The SAME ring, at a size a thumb can use. */
  ring: Omit<RemoteRingProps, 'sizePx'>;
  /** Leave editing, and say what the person was reaching for on the way out. */
  onDone: (wanted?: StripEscape) => void;
}

export function RemoteEditor({
  runtime,
  delivers,
  state,
  presence,
  ring,
  onDone,
}: RemoteEditorProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ghostsRef = useRef<HTMLDivElement | null>(null);

  const [railOpen, setRailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [looksOpen, setLooksOpen] = useState(false);
  const [context, setContext] = useState<Layer | null>(null);
  const [templates, setTemplates] = useState<readonly LookEntry[]>([]);

  /**
   * The inspector — the same sheet CAM opens, on the phone (round 13).
   *
   * `reveal` is the desktop's own mechanism verbatim: a section plus a nonce,
   * so a SECOND press of Preset scrolls again after the reader has scrolled
   * away. `null` means "open where the sheet always opens".
   */
  const [inspectOpen, setInspectOpen] = useState(false);
  const [reveal, setReveal] = useState<{ section: 'options'; nonce: number } | null>(null);

  /**
   * Looks, on the phone — templates, this device's own saved Looks, the
   * gallery.
   *
   * All three are DOCUMENTS. A template is a chunk that ships with the app, a
   * gallery entry is a JSON file fetched from this build's own `looks/` folder,
   * and a saved Look is a row in `kraken-hub:v1:looks` on this phone. None of
   * them is a picture or a clip, which is why the phone may have all three and
   * still may not have import, export or the media library.
   */
  const [looksTab, setLooksTab] = useState<'templates' | 'yours' | 'gallery'>('templates');
  const [looksDoc, setLooksDoc] = useState<LooksDoc>(readLooksDoc);
  const [gallery, setGallery] = useState<readonly LookEntry[] | null>(null);
  const [galleryMissing, setGalleryMissing] = useState(false);
  const [savingAs, setSavingAs] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveRefused, setSaveRefused] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  /*
   * The Look's name, from the store that owns it.
   *
   * Read rather than written: naming a Look is a CAM gesture (the name lives in
   * this browser's own storage, not on the wire), and a phone that renamed
   * something only it can see would be inventing a fact about the Kraken's
   * library. The menu shows what the name is and applies templates, which are
   * both real from here.
   */
  const [lookName, setLookName] = useState<string | null>(() => readLookName());
  useEffect(
    () =>
      subscribeLooks(() => {
        setLookName(readLookName());
        setLooksDoc(readLooksDoc());
      }),
    [],
  );

  /*
    The gallery, the first time somebody looks at it.

    A network round trip is not worth spending on a sheet opened to apply a
    template, and `loadGallery` fetching JSON out of this build's own `looks/`
    folder is not the user's bytes moving anywhere — it is the app reading its
    own files, exactly as `loadTemplates` does one line up.
  */
  useEffect(() => {
    if (!looksOpen || looksTab !== 'gallery' || gallery !== null || galleryMissing) return;
    void loadGallery().then((result) => {
      if (result.ok) setGallery(result.entries);
      else setGalleryMissing(true);
    });
  }, [looksOpen, looksTab, gallery, galleryMissing]);

  /**
   * The panel this canvas stands in for — the REPORTED one, never a guess.
   *
   * The same rule the ring itself follows (round 6's C4): every module lays
   * itself out against `geometry()`, and every gesture converts screen pixels
   * through `panel.radiusPx`, so a canvas over a panel nobody has described
   * would place layers by arithmetic on a made-up number. `RemoteView` only
   * offers the Edit affordance once a display has reported its geometry, and
   * this derives the same `Geometry` the replica inside the ring is using.
   */
  const panel = useMemo(
    () => replicaGeometry(ring.display, state.render),
    [ring.display, state.render],
  );

  const editor = useEditor({
    runtime,
    panel: { shape: panel.shape },
    render: { safeRadiusPct: state.render.safeRadiusPct },
  });

  const k = EDIT_RING_PX / (panel.width > 0 ? panel.width : EDIT_RING_PX);

  /**
   * The preview channel, ghost edition — one style write, no React (I4).
   *
   * `transformCss` is the compositor's, so a drag on the phone and a drag on
   * the halo produce the same string from the same transform.
   */
  const preview = (id: LayerId, t: Parameters<typeof transformCss>[0]): void => {
    const ghost = ghostsRef.current?.querySelector<HTMLElement>(`[data-layer="${id}"]`);
    ghost?.style.setProperty('transform', transformCss(t, panel));
  };

  // -- the strip, wired exactly as the desktop wires it ----------------------

  const stripLayer = editor.selected ?? editor.layers[0] ?? null;
  const stripModule = stripLayer === null ? null : getModule(stripLayer.kind);
  const stripIsBase = stripLayer !== null && stripLayer.id === BASE_LAYER_ID;
  const stripConfig =
    stripLayer === null || stripModule === null
      ? null
      : stripModule.validate(selectLayerConfig(state, stripLayer));

  /** A config write lands in the layer's ONE home, decided by position (§4.1). */
  const writeStripConfig = (next: unknown): void => {
    if (stripLayer === null || stripModule === null) return;
    if (stripIsBase) {
      runtime.store.commit((sn) =>
        withModuleConfig(sn, stripModule.id, stripModule.configVersion, next),
      );
      return;
    }
    editor.writeConfig(stripLayer.id, stripModule.configVersion, next);
  };

  /**
   * The strip's deeper controls, and where each of them actually LANDS.
   *
   * This used to be one line — `onDone(wanted)` — with everything that was not
   * a source mapped to `'more'`, and `'more'` was nothing at all. So on the
   * effect module, which is the default background, three of its four strip
   * controls (**Effect**, **Preset**, **Colours**) closed the editor and did
   * not open anything: the catalogue, the preset chips and the colour wells
   * were unreachable on a phone at any number of presses. The user found it the
   * only way it could be found — by making the browser window bigger until the
   * desktop editor appeared.
   *
   * Yesterday's rule was about BYTES, not about looks. A preset is a number in
   * the synced document; a colour is a hex string. So the kind's own panel
   * comes here, inside the same `InspectorSheet` CAM opens, and the two escapes
   * that genuinely have a truer control twenty pixels below the canvas — the
   * source field and the A/B scrubber and the quality ladder — still leave, and
   * `RemoteView` now scrolls the person onto the one they asked for instead of
   * dropping the intent on the floor.
   */
  const closeInspector = (): void => {
    setInspectOpen(false);
    setReveal(null);
  };

  const openInspector = (): void => {
    setReveal((prev) => ({ section: 'options', nonce: (prev?.nonce ?? 0) + 1 }));
    setInspectOpen(true);
  };

  const escape = (wanted: StripEscape): void => {
    if (wanted === 'more') {
      // `More` asks for the sheet rather than for anything in it, so it opens
      // where the sheet always opens: Layout, at the top.
      setReveal(null);
      setInspectOpen(true);
      return;
    }
    onDone(wanted);
  };

  const applyEntry = (entry: LookEntry): void => {
    const patch = applyLookFile(runtime.store.getSnapshot(), resolveMedia(entry.file));
    // The bank first, then the look: `commitLook` is the one call that both
    // commits and pushes an undo entry, so applying a template is one step.
    runtime.store.commit((s) => ({ ...s, modules: { ...s.modules, ...patch.modules } }));
    editor.commitLook(patch.look);
    writeLookName(entry.name === '' ? null : entry.name);
    setLooksOpen(false);
  };

  const openLooks = (): void => {
    setLooksOpen((open) => !open);
    if (templates.length === 0) {
      void loadTemplates().then(setTemplates, () => {
        // A template table that will not load is not a reason to lose the
        // menu: the name and the current Look are still there to read.
        setTemplates([]);
      });
    }
  };

  /**
   * Save a copy — a DOCUMENT operation, which is why the phone may have it.
   *
   * `exportLook` with an empty media index: a Look is layers, transforms and
   * configs, and the pictures it points at are named rather than carried. So
   * keeping one costs no bytes and moves none — it is a row in this device's
   * own namespaced `kraken-hub:v1:looks`, and the sheet says exactly that
   * rather than implying the Kraken or the PC now has it.
   */
  const saveCopy = (as: string): void => {
    const trimmed = as.trim();
    if (trimmed === '') return;
    const file = exportLook(runtime.store.getSnapshot(), { name: trimmed }, []);
    const result = addLook(readLooksDoc(), file, Date.now());
    if (!result.ok) {
      setSaveRefused(true);
      return;
    }
    setLooksDoc(updateLooksDoc(() => result.doc));
    writeLookName(trimmed);
    setSaveRefused(false);
    setSavingAs(false);
    setLooksTab('yours');
  };

  /*
    Escape closes the inspector, not the editor.

    A phone has a hardware keyboard more often than the desktop assumption
    allows — a folio, a Bluetooth board — and the sheet is a modal-ish surface
    over the canvas, so the key that dismisses a sheet everywhere else in this
    app dismisses this one.
  */
  useEffect(() => {
    if (!inspectOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setInspectOpen(false);
      setReveal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [inspectOpen]);

  const full = editor.layers.length >= MAX_LAYERS;

  return (
    <section className="kh-redit" data-testid="remote-editor" aria-label="Edit this look">
      <header className="kh-redit__head">
        <button
          type="button"
          className="kh-redit__looks"
          data-testid="remote-looks-button"
          aria-expanded={looksOpen}
          aria-controls="remote-looks-menu"
          onClick={openLooks}
        >
          {lookMenuLabel(lookName)} <span aria-hidden="true">▾</span>
        </button>
        <span className="kh-redit__acts">
          <button
            type="button"
            className="kh-tbtn"
            data-testid="remote-undo"
            aria-label="Undo"
            disabled={!editor.canUndo}
            onClick={editor.undo}
          >
            <span aria-hidden="true">↶</span>
          </button>
          <button
            type="button"
            className="kh-tbtn"
            data-testid="remote-redo"
            aria-label="Redo"
            disabled={!editor.canRedo}
            onClick={editor.redo}
          >
            <span aria-hidden="true">↷</span>
          </button>
          <button
            type="button"
            className="kh-btn kh-btn--primary"
            data-testid="remote-edit-done"
            onClick={() => {
              onDone();
            }}
          >
            Done
          </button>
        </span>
      </header>

      {looksOpen && (
        <div
          className="kh-looks"
          id="remote-looks-menu"
          data-testid="remote-looks-menu"
          role="menu"
        >
          <div className="kh-redit__lookstabs">
            <Segmented
              id="remote-looks-tab"
              ariaLabel="Which Looks"
              wrap
              value={looksTab}
              options={[
                { value: 'templates', label: 'Templates' },
                { value: 'yours', label: 'Your Looks' },
                { value: 'gallery', label: 'Gallery' },
              ]}
              onChange={(next) => {
                setLooksTab(next as 'templates' | 'yours' | 'gallery');
              }}
            />
          </div>

          {looksTab === 'templates' && (
            <>
              <p className="kh-looks__head">Start from</p>
              {templates.map((entry) => (
                <button
                  key={`${entry.source}-${entry.id}`}
                  type="button"
                  className="kh-looks__item"
                  role="menuitem"
                  data-testid={`remote-look-${entry.id}`}
                  onClick={() => {
                    applyEntry(entry);
                  }}
                >
                  <b>{entry.name}</b>
                  <small>{entry.summary}</small>
                </button>
              ))}
            </>
          )}

          {looksTab === 'gallery' && (
            <>
              <p className="kh-looks__head">From the project</p>
              {galleryMissing && (
                <p className="kh-hint" data-testid="remote-gallery-missing">
                  This build does not ship a gallery folder.
                </p>
              )}
              {!galleryMissing && gallery === null && (
                <p className="kh-hint">Reading the gallery…</p>
              )}
              {(gallery ?? []).map((entry) => (
                <button
                  key={`${entry.source}-${entry.id}`}
                  type="button"
                  className="kh-looks__item"
                  role="menuitem"
                  data-testid={`remote-gallery-${entry.id}`}
                  onClick={() => {
                    applyEntry(entry);
                  }}
                >
                  <b>{entry.name === '' ? UNTITLED_LOOK : entry.name}</b>
                  <small>{entry.summary}</small>
                </button>
              ))}
              {/*
                Apply, and nothing else. Downloading a gallery Look as a FILE is
                the one thing on this tab that would put bytes in the wrong
                browser, so it is not here — `ownsBytes()` decides that, and it
                is false on a phone by construction.
              */}
              <p className="kh-hint">These are files in the project’s own repository.</p>
            </>
          )}

          {looksTab === 'yours' && (
            <>
              <p className="kh-looks__head">Saved on this phone</p>
              {looksDoc.looks.length === 0 && (
                <p className="kh-hint" data-testid="remote-looks-empty">
                  You have not kept a Look here yet.
                </p>
              )}
              {looksDoc.looks.map((row) => (
                <div
                  className="kh-redit__lookrow"
                  key={row.id}
                  data-testid={`remote-saved-${row.id}`}
                >
                  {renaming === row.id ? (
                    <input
                      className="kh-redit__name"
                      defaultValue={row.file.name}
                      maxLength={MAX_LOOK_NAME}
                      aria-label="Look name"
                      data-testid={`remote-rename-${row.id}`}
                      ref={(el) => el?.focus()}
                      onBlur={(e) => {
                        setLooksDoc(
                          updateLooksDoc((d) => renameSaved(d, row.id, e.target.value, Date.now())),
                        );
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="kh-looks__item kh-redit__lookapply"
                      data-testid={`remote-apply-${row.id}`}
                      onClick={() => {
                        applyEntry({
                          id: row.id,
                          source: 'saved',
                          name: row.file.name,
                          summary: row.file.description ?? '',
                          file: row.file,
                        });
                      }}
                    >
                      <b>{row.file.name === '' ? UNTITLED_LOOK : row.file.name}</b>
                      <small>{row.file.description ?? ''}</small>
                    </button>
                  )}
                  <div className="kh-redit__lookacts">
                    <button
                      type="button"
                      className="kh-tbtn"
                      aria-label={row.favourite ? 'Remove from favourites' : 'Add to favourites'}
                      aria-pressed={row.favourite}
                      data-testid={`remote-fav-${row.id}`}
                      onClick={() => {
                        setLooksDoc(updateLooksDoc((d) => toggleFavourite(d, row.id, Date.now())));
                      }}
                    >
                      <span aria-hidden="true">{row.favourite ? '★' : '☆'}</span>
                    </button>
                    <button
                      type="button"
                      className="kh-tbtn"
                      aria-label="Rename"
                      data-testid={`remote-rename-btn-${row.id}`}
                      onClick={() => {
                        setRenaming(row.id);
                      }}
                    >
                      <span aria-hidden="true">✎</span>
                    </button>
                    <button
                      type="button"
                      className="kh-tbtn"
                      aria-label={confirming === row.id ? 'Delete for good' : 'Delete'}
                      data-testid={`remote-del-${row.id}`}
                      onClick={() => {
                        if (confirming !== row.id) {
                          setConfirming(row.id);
                          return;
                        }
                        setLooksDoc(updateLooksDoc((d) => deleteSaved(d, row.id)));
                        setConfirming(null);
                      }}
                    >
                      <span aria-hidden="true">{confirming === row.id ? '⌫!' : '⌫'}</span>
                    </button>
                  </div>
                </div>
              ))}

              {saveRefused && (
                <p className="kh-hint" data-testid="remote-looks-full">
                  This phone is holding as many Looks as it can. Delete one first.
                </p>
              )}

              {!savingAs && (
                <button
                  type="button"
                  className="kh-btn"
                  data-testid="remote-looks-save"
                  onClick={() => {
                    setSaveName(lookName ?? '');
                    setSavingAs(true);
                  }}
                >
                  Save a copy…
                </button>
              )}

              {savingAs && (
                <form
                  className="kh-redit__saveas"
                  data-testid="remote-save-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveCopy(saveName);
                  }}
                >
                  <label className="kh-redit__saveas-lab" htmlFor="kh-remote-save-name">
                    Save this Look as
                  </label>
                  <input
                    id="kh-remote-save-name"
                    className="kh-redit__name"
                    data-testid="remote-save-name"
                    value={saveName}
                    maxLength={MAX_LOOK_NAME}
                    placeholder="Name this Look"
                    ref={(el) => el?.focus()}
                    onChange={(event) => {
                      setSaveName(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setSavingAs(false);
                    }}
                  />
                  <button
                    type="submit"
                    className="kh-btn kh-btn--primary"
                    data-testid="remote-save-confirm"
                    disabled={saveName.trim() === ''}
                  >
                    Save
                  </button>
                </form>
              )}

              {/*
                Where they live, said plainly.

                A Look kept here is kept HERE — this phone's own namespaced
                storage — and does not appear on the PC, because the phone does
                not own that library. The same owning-window rule decides the
                carousel: the rotation turns in the window that owns the saved
                Looks, so this one reports it rather than driving it.
              */}
              <p className="kh-hint" data-testid="remote-looks-where">
                Saved on this phone. They stay in this browser, and they are not files — sending a
                Look to somebody is a job for the PC.
              </p>
              <p className="kh-hint" data-testid="remote-carousel-status">
                {state.carousel === undefined
                  ? 'Carousel: off.'
                  : `Carousel: ${String(state.carousel.lookIds.length)} Looks, every ${String(
                      state.carousel.intervalSec,
                    )}s — it turns on the PC, not here.`}
              </p>
            </>
          )}
        </div>
      )}

      {/*
        The ring, unchanged, with the editor's layer over it.

        `RemoteRing` is the remote's own component at its own job: a live
        replica of whatever the panel is showing. Editing does not replace it,
        pause it or fake it — it draws on top.
      */}
      <div
        className="kh-redit__stage"
        ref={stageRef}
        style={{ width: `${String(EDIT_RING_PX)}px`, height: `${String(EDIT_RING_PX)}px` }}
      >
        <RemoteRing {...ring} sizePx={EDIT_RING_PX} />

        {/*
          The ghosts — the arrangement, in the compositor's own coordinates.

          Panel-sized and scaled by the same `k` the gestures divide by, so a
          box drawn here and a box drawn by `EditorOverlay` land on the same
          pixel. `hostStyle` is the display's function: the ghost's left, top,
          width, height and transform are the ones the real host would get.
        */}
        <div
          className="kh-redit__ghosts"
          ref={ghostsRef}
          aria-hidden="true"
          style={{
            width: `${String(panel.width)}px`,
            height: `${String(panel.height)}px`,
            transform: `scale(${String(k)})`,
          }}
        >
          {editor.overlays
            .filter((l) => l.on)
            .map((layer) => (
              <div
                key={layer.id}
                className="kh-redit__ghost"
                data-layer={layer.id}
                data-selected={editor.isSelected(layer.id) ? 'true' : 'false'}
                style={hostStyle(layer, panel)}
              />
            ))}
        </div>

        <EditorOverlay
          editor={editor}
          panel={panel}
          render={state.render}
          k={k}
          rectOf={() => stageRef.current?.getBoundingClientRect() ?? null}
          preview={preview}
          /*
            No frame clock on the phone.

            The spring settle exists to run a transform to rest on the display's
            own clock; there is no `LayerHost` here to spring, and inventing a
            rAF loop on a battery for a wireframe would be the opposite of what
            `replica.ts` spent a wave establishing. `null` means "commit now",
            which the overlay already handles as its no-clock case.
          */
          clockOf={() => null}
          coarsePointer
          touch
          onContext={setContext}
        />
      </div>

      {/*
        The claim, and the only sentence on this surface about the panel.

        Presence alone would say "there is a Kraken"; what a person wants to
        know after moving a layer is whether the Kraken HAS it, and those are
        two questions with two answers. `delivers` is the second one, and since
        W1c it is true on a paired phone as well as on CAM — the wire carries
        `look` now, so an arrangement made here travels like any other change.
      */}
      <PanelClaim
        claim={CLAIM_ARRANGEMENT}
        presence={arrangementPresence({ presence, delivers: delivers || ownsBytes(runtime) })}
        as="small"
        className="kh-redit__claim"
        testId="remote-edit-claim"
      />

      <div className="kh-ops" data-testid="remote-strip" data-strip-kind={stripLayer?.kind ?? ''}>
        {stripLayer !== null && stripModule?.editor !== undefined && (
          <SelectionStrip
            layer={stripLayer}
            /*
              The strip is not passed in: `SelectionStrip` calls the kind's own
              `editor.loadStrip()` on first selection — one small chunk out of
              the module-editors bundle — and reserves the row's height until it
              lands, so no caller has to have the declaration in hand.
            */
            config={stripConfig}
            onConfig={writeStripConfig}
            onTransform={(patch) => {
              editor.transform(stripLayer.id, patch);
            }}
            onResize={(factor) => {
              editor.commitLook(resizeLayer(state.look, stripLayer.id, factor, editor.registry));
            }}
            onAction={(action) => {
              /*
                Source, loop and quality have a real control on the page under
                this one; everything else — effect, preset, colours, the icon
                picker — is the kind's own panel, and the inspector is where
                that lives on both surfaces now. Nothing merely closes.
              */
              /*
                …and only for the layer those controls are ABOUT — round 13's
                finding 4.

                The paste row, the scrubber and the quality ladder all speak for
                `state.activeModuleId`, which is the BASE. Press Source on an
                image overlay above a video base and the editor closed and put
                the caret in a field labelled "Paste a video link", whose submit
                writes the base's link: the wrong word over the wrong write. An
                overlay carries its own config (§4.1), so its controls are in
                its own panel, which is where every other strip action already
                goes.
              */
              const forTheBase = action === 'loop' || action === 'source' || action === 'quality';
              if (forTheBase && stripIsBase) {
                onDone(action);
                return;
              }
              openInspector();
            }}
            onMore={(wanted) => {
              // Same rule as the desktop: a kind that named its one door gets
              // opened at what the door is named after.
              if (wanted === 'options') openInspector();
              else escape('more');
            }}
          />
        )}
      </div>

      {/*
        The inspector, as a phone sheet — the SAME component, not a phone copy.

        Layout's five numbers, the kind's own `ConfigPanel` through the same
        lazy loader CAM uses, Visibility and Advanced. It scrolls inside itself
        (`kh-sheet__body`, plus the `kh-redit__sheet` height cap) so the page
        underneath does not grow, which is what `REMOTE_EDIT_STAGES`'s page-fit
        sweep measures.
      */}
      {inspectOpen && stripLayer !== null && (
        <div className="kh-redit__sheet kh-redit__sheet--inspect" data-testid="remote-inspect">
          <InspectorSheet
            editor={editor}
            layer={stripLayer}
            module={stripModule}
            config={stripConfig}
            panel={{ width: panel.width, height: panel.height }}
            reveal={reveal}
            /*
              The kind's panel, minus the half that acts on somebody else's disk
              — round 13's finding 3. This is the same `InspectorSheet` CAM
              opens, so the video panel arrived here whole: "On this PC", the
              Local downloader's port and token, "Get the downloader" and its
              "Download for Windows" panel, all on a phone that owns no bytes
              and can neither run the program nor see the disk. `ownsBytes` is
              false here by construction (`camDetected` false, role `remote`),
              and the panel answers to it.
            */
            ownsBytes={ownsBytes(runtime)}
            onConfig={writeStripConfig}
            onClose={closeInspector}
          />
          <button
            type="button"
            className="kh-btn kh-btn--primary kh-redit__inspect-done"
            data-testid="remote-inspect-done"
            onClick={closeInspector}
          >
            Done
          </button>
        </div>
      )}

      <div className="kh-redit__bar">
        <button
          type="button"
          className="kh-btn"
          data-testid="remote-rail-button"
          aria-expanded={railOpen}
          aria-controls="remote-rail-sheet"
          onClick={() => {
            setRailOpen((open) => !open);
          }}
        >
          Layers
        </button>
        <button
          type="button"
          className="kh-btn"
          data-testid="remote-add-layer"
          disabled={full}
          title={full ? 'This look is full.' : ''}
          onClick={() => {
            setAddOpen(true);
          }}
        >
          + Add a layer
        </button>
      </div>

      {/*
        The rail, as a sheet (§8). The SAME rail: one list, one set of ids, one
        set of ops. Its base row is empty here on purpose — what the background
        is is the remote's own module picker, twenty pixels below this editor,
        and a second copy of that row is exactly the duplication the rail's
        `baseRow` seam exists to prevent.
      */}
      {railOpen && (
        <div className="kh-sheet kh-redit__sheet" id="remote-rail-sheet">
          <LayerRail
            editor={editor}
            heaviestId={null}
            baseRow={null}
            onAdd={() => {
              setAddOpen(true);
            }}
          />
        </div>
      )}

      {addOpen && (
        <AddSheet
          modules={editor.modules}
          canAdd={!full}
          onAdd={(kind, cfg) => {
            editor.add(kind, cfg);
            setAddOpen(false);
          }}
          /*
            The phone's rail has no base row (see above), so the sheet's
            Background tile writes the base through the ONE op that may — the
            same `setBase` the chip row calls one screen over — and nothing else
            about this surface changes.
          */
          onBase={(kind, cfg) => {
            runtime.store.commit((s) => {
              const based = withBaseKind(s, kind);
              const mod = editor.modules.find((m) => m.id === kind);
              return cfg === undefined || mod === undefined
                ? based
                : withModuleConfig(based, kind, mod.configVersion, cfg);
            });
            setAddOpen(false);
          }}
          onClose={() => {
            setAddOpen(false);
          }}
        />
      )}

      {/*
        Long press → the four things a right-click does (§8). Duplicate, front,
        back, delete — every one of them an existing op, none of them new
        behaviour, and all four one thumb-width tall.
      */}
      {context !== null && (
        <LayerContextSheet
          editor={editor}
          layer={context}
          className="kh-redit__sheet"
          testId="remote-context"
          onClose={() => {
            setContext(null);
          }}
        />
      )}

      {editor.refusal !== null && (
        <div className="kh-redit__notice" data-testid="remote-editor-refusal">
          <Notice tone="warn">{editor.refusal}</Notice>
        </div>
      )}
    </section>
  );
}
