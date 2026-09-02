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
import { applyLookFile, resolveMedia } from '../../../../state/look/file';
import { BASE_LAYER_ID, MAX_LAYERS, type Layer, type LayerId } from '../../../../state/look/types';
import { withModuleConfig, selectLayerConfig } from '../../../../state/selectors';
import { Notice } from '../../../../ui';
import { withBaseKind } from '../../../state/switchBase';
import { lookMenuLabel, loadTemplates, type LookEntry } from '../../editor/looksMenu';
import { readLookName, subscribeLooks } from '../../editor/looksStore';
import { resize as resizeLayer } from '../../editor/ops';
import { useEditor } from '../../editor/useEditor';
import { PanelClaim } from '../../PanelClaim';
import { CLAIM_ARRANGEMENT } from '../../panelClaims';
import { replicaGeometry } from '../../replica';
import { ownsBytes } from '../../surface';
import { AddSheet } from '../editor/AddSheet';
import { EditorOverlay } from '../editor/EditorCanvas';
import { LayerRail } from '../editor/LayerRail';
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
      }),
    [],
  );

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
   * The controls that are not on this screen, and are not duplicated onto it.
   *
   * A source, an A-B loop and a stream quality all have a real control on the
   * remote itself, twenty pixels below this canvas; colours, presets and the
   * effect catalog need the module's own panel, which is CAM's. Either way the
   * answer is the same and it is not "a second copy here": Done, and the person
   * is standing in front of the control they were reaching for.
   */
  const escape = (wanted: StripEscape): void => {
    onDone(wanted);
  };

  const applyEntry = (entry: LookEntry): void => {
    const patch = applyLookFile(runtime.store.getSnapshot(), resolveMedia(entry.file));
    // The bank first, then the look: `commitLook` is the one call that both
    // commits and pushes an undo entry, so applying a template is one step.
    runtime.store.commit((s) => ({ ...s, modules: { ...s.modules, ...patch.modules } }));
    editor.commitLook(patch.look);
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
              escape(
                action === 'loop' || action === 'source' || action === 'quality' ? action : 'more',
              );
            }}
            onMore={() => {
              escape('more');
            }}
          />
        )}
      </div>

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
        <div className="kh-sheet kh-redit__sheet" data-testid="remote-context">
          <p className="kh-looks__head">{context.name ?? context.kind}</p>
          <button
            type="button"
            className="kh-looks__item"
            data-testid="remote-context-duplicate"
            onClick={() => {
              editor.duplicate(context.id);
              setContext(null);
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="kh-looks__item"
            data-testid="remote-context-front"
            onClick={() => {
              editor.move(context.id, editor.layers.length - 1);
              setContext(null);
            }}
          >
            Bring to front
          </button>
          <button
            type="button"
            className="kh-looks__item"
            data-testid="remote-context-back"
            onClick={() => {
              editor.move(context.id, 1);
              setContext(null);
            }}
          >
            Send to back
          </button>
          <button
            type="button"
            className="kh-looks__item"
            data-testid="remote-context-remove"
            onClick={() => {
              editor.remove(context.id);
              setContext(null);
            }}
          >
            Remove
          </button>
          <button
            type="button"
            className="kh-looks__item"
            data-testid="remote-context-close"
            onClick={() => {
              setContext(null);
            }}
          >
            Close
          </button>
        </div>
      )}

      {editor.refusal !== null && (
        <div className="kh-redit__notice" data-testid="remote-editor-refusal">
          <Notice tone="warn">{editor.refusal}</Notice>
        </div>
      )}
    </section>
  );
}
