/**
 * The editor's own state: selection, history, and the ops bound to the store.
 *
 * Everything that DECIDES anything lives in the pure modules beside this file
 * (`ops`, `gesture`, `snap`, `bounds`, `history`, `placement`). This hook is the
 * wiring: it holds what React has to hold — which layers are selected, whether
 * a sheet is open — and turns a call like `add('clock')` into one op, one
 * commit and one history entry.
 *
 * Two rules it exists to keep:
 *
 *  - **One gesture, one entry.** The caller pushes to history exactly once per
 *    completed action, never per frame; `commit()` here is the only place that
 *    does both a store write and a `history.push`.
 *  - **Selection is React state and nothing else.** It is never persisted, never
 *    synced and never in the document — two CAM browsers editing the same
 *    Kraken have their own selections, and a selection that rode the wire would
 *    make one window's click move the other window's handles.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { listModules } from '../../../modules/registry';
import { placementOfKind } from '../../../modules/stack';
import {
  BASE_LAYER_ID,
  type Layer,
  type LayerId,
  type Look,
  type Transform,
} from '../../../state/look/types';
import { withBaseKind } from '../../state/switchBase';

import { fadeLayerIn, fadeLayerOut } from './layerFade';
import { createStoreLookHistory } from './lookHistoryStore';
import {
  addLayer,
  duplicateLayer,
  removeLayer,
  renameLayer,
  reorder,
  setConfig,
  setLocked,
  setTransformOf,
  toggleLayer,
  transformMany,
  type OpRefusal,
  type OpResult,
  type TransformPatch,
} from './ops';
import { placeNewLayer } from './placement';
import { loadStripFor } from './strip';

import type { EditorRegistry } from './registryPort';
import type { SnapPanel, SnapRender } from './snap';
import type { AnyKrakenModule } from '../../../modules/types';
import type { LookPatch } from '../../../state/look/file';
import type { ConfigRuntime } from '../runtime';

/**
 * Why a locked layer's controls are inert — round 10's M5.
 *
 * Exported because it is now said in two places for one reason: as the refusal
 * a REJECTED gesture produces, and as the standing explanation beside the
 * greyed-out transform controls on the selection strip, where a person who has
 * not yet pressed anything is looking at five disabled inputs with no clue why.
 * One sentence, one constant; a rule stated two ways is two rules.
 */
export const LOCKED_REASON = 'That layer is locked. Unlock it in the list to move it.';

/** The words a refusal turns into. One sentence each, no jargon, no ids. */
const REFUSAL_TEXT: Readonly<Record<OpRefusal, string>> = {
  'max-layers': 'This look is full. Remove a layer to make room for another.',
  'max-instances': 'You can only have one of those in a look.',
  role: 'That one can only be the background.',
  'too-big': 'This look is as big as it can get. Try removing a layer.',
  'unknown-kind': 'This build does not have that layer.',
  locked: LOCKED_REASON,
};

export interface EditorApi {
  look: Look;
  layers: readonly Layer[];
  /** Bottom-first, like the array. The rail draws it reversed (front on top). */
  overlays: readonly Layer[];
  selection: readonly LayerId[];
  selected: Layer | null;
  registry: EditorRegistry;
  modules: readonly AnyKrakenModule[];

  select: (id: LayerId | null, additive?: boolean) => void;
  selectMany: (ids: readonly LayerId[]) => void;
  isSelected: (id: LayerId) => boolean;

  /**
   * Add an overlay of `kind`.
   *
   * `seed` is a config the CALLER wants this instance to start with — the add
   * sheet's Sticker tile is an image kind with transparent-PNG defaults, and a
   * tile that produced a plain image and then asked the user to go and set two
   * fields would not be a tile worth having. Omitted, the layer starts from the
   * bank (`registry.defaultConfigOf`), exactly as before.
   */
  add: (kind: string, seed?: unknown) => void;
  remove: (id: LayerId) => void;
  duplicate: (id: LayerId) => void;
  rename: (id: LayerId, name: string) => void;
  setOn: (id: LayerId, on: boolean) => void;
  move: (id: LayerId, toIndex: number) => void;
  /** Lock or unlock a layer (§2.2). A locked layer refuses every transform. */
  setLocked: (id: LayerId, locked: boolean) => void;
  isLocked: (id: LayerId) => boolean;
  transform: (id: LayerId, patch: Partial<Transform>) => void;
  /** A group gesture — many layers, one history entry (§2.1). */
  transformMany: (patches: readonly TransformPatch[]) => void;
  writeConfig: (id: LayerId, version: number, cfg: unknown) => void;
  /** Commit a whole look — what a finished gesture hands over. One entry. */
  commitLook: (look: Look) => void;
  /**
   * Apply a whole Look FILE — the arrangement and the settings it wears.
   *
   * `commitLook` is not enough for this and the difference is the base layer: an
   * overlay carries its own config inside `look`, and the base wears
   * `modules[kind].cfg`, so applying somebody's Look means writing the
   * arrangement AND the bank. Doing that in two commits would be two synced
   * snapshots, and a peer that saw only the first would render the new
   * arrangement with the old settings in it.
   *
   * So it is one `commit` and one history entry: undo crosses a Look switch in a
   * single press, which is §4's "applying is non-destructive" from the user's
   * side of the screen.
   */
  applyLook: (patch: LookPatch) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;

  /** The last refusal, as a sentence. Cleared by the next successful op. */
  refusal: string | null;
  clearRefusal: () => void;
}

export interface EditorOptions {
  runtime: ConfigRuntime;
  panel: SnapPanel;
  render: SnapRender;
}

export function useEditor({ runtime, panel, render }: EditorOptions): EditorApi {
  const store = runtime.store;
  const look = store.getSnapshot().look;

  const [selection, setSelection] = useState<readonly LayerId[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  /*
   * The history is per-WINDOW and per-mount, so it is a ref rather than state:
   * re-creating it on a re-render would silently empty the undo stack every
   * time the user changed anything, which is the one bug an undo stack cannot
   * survive.
   */
  const [history] = useState(() => createStoreLookHistory(store));

  useEffect(() => {
    const bump = (): void => {
      setVersion((v) => v + 1);
    };
    // Redraw the undo/redo buttons when a remote change becomes an entry.
    const off = store.subscribe(bump);
    return () => {
      off();
      history.dispose();
    };
  }, [history, store]);

  const modules = useMemo(() => listModules(), []);

  const registry = useMemo<EditorRegistry>(
    () => ({
      placementOf: (kind) =>
        placementOfKind(kind, (id) => modules.find((m) => m.id === id) ?? null),
      defaultConfigOf: (kind) => {
        const mod = modules.find((m) => m.id === kind);
        if (mod === undefined) return {};
        // The bank first: a kind the user has already configured keeps those
        // settings when it becomes an overlay, which is what "switching back
        // does not lose your settings" means one level down.
        return store.getSnapshot().modules[kind]?.cfg ?? mod.defaults;
      },
    }),
    [modules, store],
  );

  /** The one place a look change becomes a commit AND a history entry. */
  const commitLook = useCallback(
    (next: Look) => {
      store.commit((s) => ({ ...s, look: next }));
      history.push(store.getSnapshot().look);
      setRefusal(null);
    },
    [history, store],
  );

  /**
   * A whole Look file, applied as one operation.
   *
   * `withBaseKind` runs FIRST and the file's own look is written over the top.
   * The order is load bearing twice over: the helper is the only place in
   * `src/app` allowed to write `activeModuleId` (`switchBase.test.ts` greps for
   * it), and it settles that field from the kind — but it also rebuilds the base
   * LAYER from `baseLook()`, which would throw away a name the file gave it.
   * Writing `look` after means the base kind is mirrored and the file's base
   * layer survives intact, so `validateAppState`'s reconciliation is a no-op.
   */
  const applyLook = useCallback(
    (patch: LookPatch) => {
      store.commit((s) => {
        const kind = patch.look.layers[0]?.kind;
        const based = kind === undefined ? s : withBaseKind(s, kind);
        return { ...based, look: patch.look, modules: patch.modules };
      });
      history.push(store.getSnapshot().look);
      setRefusal(null);
    },
    [history, store],
  );

  /** …and the one place a refusal becomes a sentence. */
  const commitResult = useCallback(
    (result: OpResult): LayerId | null => {
      if (!result.ok) {
        setRefusal(REFUSAL_TEXT[result.reason]);
        return null;
      }
      commitLook(result.look);
      return result.id ?? null;
    },
    [commitLook],
  );

  const select = useCallback((id: LayerId | null, additive = false) => {
    setSelection((current) => {
      if (id === null) return [];
      if (!additive) return [id];
      return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    });
  }, []);

  const add = useCallback(
    (kind: string, seed?: unknown) => {
      const placement = registry.placementOf(kind);
      if (placement === null) {
        setRefusal(REFUSAL_TEXT['unknown-kind']);
        return;
      }
      // Smart placement, principle 5: the first FREE slot, not the middle.
      const { t } = placeNewLayer({
        look,
        frame: placement.overlayDefault.frame,
        preferred: placement.overlayDefault.t,
        panel,
        render,
      });
      const id = commitResult(
        addLayer(look, kind, registry, seed === undefined ? { t } : { t, cfg: seed }),
      );
      // A new layer is selected, so its strip is what changed on the screen.
      if (id !== null) setSelection([id]);
      /*
       * §7: a layer arrives, it does not blink into existence.
       *
       * On the frame AFTER the commit, because the host the animation runs on
       * is built by the compositor from the look this commit just wrote — one
       * `requestAnimationFrame` is the cheapest way to be behind that without
       * this hook knowing anything about `LayerHost`'s scheduling.
       */
      if (id !== null && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          fadeLayerIn(id);
        });
      }
    },
    [commitResult, look, panel, registry, render],
  );

  /*
   * The selection strip's controls are a chunk, and this is where it starts.
   *
   * A kind's strip declaration lives in `src/modules/<kind>/editor.ts` and is
   * fetched on demand, because it is config-only data that was riding the eager
   * registry onto the LCD's critical path (`EditorContract`). `SelectionStrip`
   * can load it itself, and does — but it only mounts once the selection has
   * already changed, so kicking the fetch off HERE, the moment a layer of that
   * kind is selected, is what usually makes the strip present on the very first
   * paint after the click rather than one round trip later.
   *
   * The base's kind too: with nothing selected the strip carries the
   * background's controls, so the base is a selection the user did not have to
   * make. Both are a no-op after the first time — `loadStripFor` is cached and
   * de-duplicated per kind.
   */
  const baseKind = look.layers[0]?.kind;
  const selectedKind =
    selection.length === 1 ? look.layers.find((l) => l.id === selection[0])?.kind : undefined;
  useEffect(() => {
    for (const kind of [baseKind, selectedKind]) {
      // Prefetch only. A failure here is silent by design: `SelectionStrip`
      // asks again when it mounts, and it is the thing that can show it.
      if (kind !== undefined) void loadStripFor(kind).catch(() => undefined);
    }
  }, [baseKind, selectedKind]);

  const api: EditorApi = {
    look,
    layers: look.layers,
    overlays: look.layers.slice(1),
    selection,
    selected: look.layers.find((l) => selection.length === 1 && l.id === selection[0]) ?? null,
    registry,
    modules,

    select,
    selectMany: setSelection,
    isSelected: (id) => selection.includes(id),

    add,
    remove: (id) => {
      const done = (): void => {
        // Read the look FRESH: the fade puts a fifth of a second between the
        // press and the commit, and `look` above is the one this render closed
        // over. Committing that would silently undo anything that landed in
        // between — including the other CAM browser's edit.
        commitLook(removeLayer(store.getSnapshot().look, id));
        setSelection((s) => s.filter((x) => x !== id));
      };
      /*
       * §7: fade OUT, then unmount — an unmount cannot be animated.
       *
       * `fadeLayerOut` returns `null` when there is nothing to animate (no
       * compositor on this surface, no WAAPI, reduced motion), and then the
       * removal is synchronous exactly as it has always been. That is what
       * keeps the jsdom suites — which call `remove()` and read the document on
       * the next line — passing without a fake clock.
       */
      const fading = fadeLayerOut(id);
      if (fading === null) done();
      else void fading.then(done);
    },
    duplicate: (id) => {
      const copy = commitResult(duplicateLayer(look, id, registry));
      if (copy !== null) setSelection([copy]);
    },
    rename: (id, name) => {
      commitLook(renameLayer(look, id, name));
    },
    setOn: (id, on) => {
      commitLook(toggleLayer(look, id, on));
    },
    move: (id, toIndex) => {
      commitLook(reorder(look, id, toIndex));
    },
    setLocked: (id, locked) => {
      commitLook(setLocked(look, id, locked));
    },
    isLocked: (id) => look.layers.find((l) => l.id === id)?.locked === true,
    transform: (id, patch) => {
      // Through the RESULT form, so a locked layer produces the sentence rather
      // than a press that silently does nothing.
      commitResult(setTransformOf(look, id, patch));
    },
    transformMany: (patches) => {
      if (patches.length === 0) return;
      commitResult(transformMany(look, patches));
    },
    writeConfig: (id, configVersion, cfg) => {
      if (id === BASE_LAYER_ID) return;
      commitResult(setConfig(look, id, configVersion, cfg));
    },
    commitLook,
    applyLook,

    undo: () => {
      history.undo();
      setVersion((v) => v + 1);
    },
    redo: () => {
      history.redo();
      setVersion((v) => v + 1);
    },
    // `version` is read so the memo above is not the only thing re-running when
    // a remote change lands; the buttons are derived from the stack's depth.
    canUndo: version >= 0 && history.canUndo(),
    canRedo: history.canRedo(),

    refusal,
    clearRefusal: () => {
      setRefusal(null);
    },
  };

  return api;
}
