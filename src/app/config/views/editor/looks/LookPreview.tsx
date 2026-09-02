/**
 * One card's picture: the Look itself, running, at thumbnail size.
 *
 * §4 asks for "live-rendered previews — the replica renders any Look file at
 * thumbnail size", and this is that, with no second renderer and no screenshot
 * pipeline: a real `LayerHost` with the real modules in it, laid out at the
 * PANEL's pixel size and scaled down by CSS. That last part is the same rule
 * `replica.ts` follows for the phone's ring, and it is the reason the card is a
 * true likeness — every module sizes its type and its dials off `geometry()`,
 * so a stats face tuned for the panel must be laid out at panel size and then
 * shrunk, never laid out at 120 px and called a preview.
 *
 * ## Three things stop a grid of these from being a bad idea
 *
 *  - **Mounted when scrolled into view, destroyed on leave.** An
 *    `IntersectionObserver` per card; nothing runs for a card nobody is looking
 *    at.
 *  - **Six live at once, sheet-wide** (`previewPolicy.ts`). A card that cannot
 *    claim a slot draws its still frame and takes a slot when one is freed.
 *  - **Effect LAYERS are never live in a card** — the layer, not the card
 *    (round 11's F-4). They are WebGL, one context each, and a browser's
 *    per-page context limit is small enough that a grid would evict the
 *    EDITOR's own canvas. So an effect layer is switched off and its own still
 *    frame — the user's palette as a ramp, exactly what `effect/display.ts`
 *    paints before its shader loads — becomes the card's ground; every OTHER
 *    layer in the Look composites over it through the same `LayerHost`. The
 *    card that used to be a bare gradient is the Look with one layer stilled.
 *
 * The video stand-in comes free: the registry is `previewRegistry(getModule)`,
 * the same wrapper the editor's canvas uses, so no card ever opens a decoder or
 * an embed.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { getModule } from '../../../../../modules/registry';
import { createFrameClock } from '../../../../../platform/fpsGovernor';
import { LayerHost } from '../../../../../render/LayerHost';
import { configsOf } from '../../../../../render/lookOf';
import { createPreviewMonitoring, monitoringIsSimulated } from '../../../editor/previewMonitoring';
import { previewRegistry } from '../../../editor/previewRegistry';

import { NEVER_LIVE_KINDS, previewModeOf, readsMonitoring, stillPaint } from './previewPolicy';

import type { PreviewBudget } from './previewPolicy';
import type { Geometry } from '../../../../../platform/geometry';
import type { LookFile } from '../../../../../state/look/file';
import type { ModuleId, ModuleSlot, RenderSettings } from '../../../../../state/schema';
import type { MonitorSnapshot } from '../../../../../sync/monitorSnapshot';

/**
 * The most often a card repaints.
 *
 * The halo the user is editing gets the panel's real rate; a row of thumbnails
 * does not need it, and six of them at 30 Hz is the frame budget of the thing
 * being previewed spent on previews. Capped rather than fixed, so a 1 FPS
 * Kraken's cards are 1 FPS too — the card should not be smoother than the panel
 * it is standing in for.
 */
export const PREVIEW_MAX_FPS = 15;

export interface LookPreviewProps {
  /** Stable for the life of the card; the budget's key. */
  previewId: string;
  file: LookFile;
  /** The panel this thumbnail is standing in for, at its own pixel size. */
  panel: Geometry;
  render: RenderSettings;
  /** The latest monitoring snapshot off the wire, and when it was sampled. */
  monitor: MonitorSnapshot | null;
  monitorAt: number;
  budget: PreviewBudget;
}

/** The per-kind bank a file's own configs make, for `configsOf`. */
function bankOf(file: LookFile): { modules: Record<ModuleId, ModuleSlot> } {
  const modules: Record<ModuleId, ModuleSlot> = {};
  for (const [kind, cfg] of Object.entries(file.configs)) {
    modules[kind] = { v: file.configVersions?.[kind] ?? 1, cfg };
  }
  return { modules };
}

export function LookPreview({
  previewId,
  file,
  panel,
  render,
  monitor,
  monitorAt,
  budget,
}: LookPreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  /*
   * Whether this card currently holds one of the six live slots, read from the
   * budget rather than mirrored into state. `useSyncExternalStore` is the right
   * shape twice over: the budget IS an external store, and a `setState` inside
   * the claiming effect would be a cascading render on every scroll.
   */
  const slot = useSyncExternalStore(
    budget.subscribe,
    () => budget.holds(previewId),
    () => false,
  );

  const mode = previewModeOf(file);
  const paint = stillPaint(file);

  /*
   * A "still" card is still the LOOK — round 11's F-4.
   *
   * `previewModeOf` refuses to run an effect in a card, and it is right to: an
   * effect is a WebGL context, browsers hard-limit them per page, and a grid of
   * them would evict the editor's own canvas. What it must not do — and what it
   * did — is make the whole card a two-stop CSS ramp. Five of the ten templates
   * carry an effect somewhere, and all five rendered as a single gradient div
   * with nothing else in it: Overlay, Lava lamp + temps, Nebula clock, Sunset
   * loop + clock and Focus each lost the clock, the stats strip, the ring or
   * the text that is the actual difference between them. A person choosing
   * between five identical gradients is not choosing.
   *
   * So the refusal is narrowed to the LAYER it is about. The effect layers are
   * switched off (`on: false` — `LayerHost.setLook` filters on exactly that, so
   * nothing mounts and no context is opened), their still frame is painted
   * behind the stage as the card's ground, and every other layer composites
   * over it through the same `LayerHost` the live cards use. One renderer, one
   * geometry, one set of module code: the card is a likeness of the Look minus
   * the one thing a thumbnail cannot afford to run.
   *
   * The BUDGET still applies. A composited still card is a real compositor and
   * claims one of the six slots like any other; a card that cannot get one
   * shows the ramp alone, which is exactly what every card in this mode used to
   * show.
   */
  const shown = useMemo(
    (): LookFile =>
      mode === 'live'
        ? file
        : {
            ...file,
            look: {
              ...file.look,
              layers: file.look.layers.map((l) =>
                NEVER_LIVE_KINDS.includes(l.kind) ? { ...l, on: false } : l,
              ),
            },
          },
    [file, mode],
  );

  /*
   * The card's dials are the simulator's too — F8, the same claim the editor's
   * halo makes about the same source. A card that is a still frame is not
   * showing a reading at all, so it says nothing; a live card whose Look has a
   * layer that reads monitoring says it once, under the picture.
   */
  const sampled =
    monitoringIsSimulated({ snapshot: monitor, at: monitorAt }) && readsMonitoring(file);

  // -- on screen? -----------------------------------------------------------

  useEffect(() => {
    const el = frameRef.current;
    if (el === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        setOnScreen(entries.some((e) => e.isIntersecting));
      },
      // A card that is about to be scrolled to is worth starting: the margin
      // buys roughly one row, so a preview is alive by the time it is looked at
      // rather than fading in a beat late.
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  // -- a slot, if there is one ---------------------------------------------

  useEffect(() => {
    if (!onScreen) return undefined;
    budget.claim(previewId);
    // A card that missed out waits for a slot to be freed rather than polling.
    // `claim` is a no-op once held, so this cannot loop on its own emission.
    const off = budget.subscribe(() => {
      budget.claim(previewId);
    });
    return () => {
      off();
      budget.release(previewId);
    };
  }, [budget, onScreen, previewId]);

  // -- the compositor -------------------------------------------------------

  /** Is a compositor mounted at all — for either mode. */
  const running = onScreen && slot;
  /** …and is it running the Look UNABRIDGED? That is what `data-preview` says. */
  const live = mode === 'live' && running;

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || !running) return undefined;

    const monitoring = createPreviewMonitoring({ snapshot: monitor, at: monitorAt });
    const clock = createFrameClock(() => Math.min(panel.targetFps, PREVIEW_MAX_FPS));
    const host = new LayerHost(stage, {
      registry: previewRegistry(getModule),
      panel,
      clock,
      render: () => render,
      monitoring: monitoring.source,
    });
    const off = monitoring.source.subscribe((n, raw) => {
      host.setMonitoring(n, raw);
    });
    host.setLook(shown.look, configsOf(shown.look, bankOf(shown), getModule));

    return () => {
      off();
      host.destroy();
      clock.stop();
      monitoring.stop();
    };
    // `monitor`/`monitorAt` are read once at mount on purpose: a card is a
    // likeness, not a dial, and re-creating six compositors every second
    // because a temperature moved is the cost this file exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, shown, panel, render]);

  return (
    <div
      className="kh-lookprev"
      ref={frameRef}
      data-testid={`look-preview-${previewId}`}
      data-preview={live ? 'live' : 'still'}
      data-composited={running ? 'true' : 'false'}
      data-shape={panel.shape}
    >
      {/*
        The effect's still frame, BEHIND the rest of the Look (F-4).

        `.kh-lookprev__still` fills the card and the stage above it is absolute,
        so the two stack without either knowing about the other: the ramp is the
        ground an effect would have painted, and the clock, the stats strip, the
        ring and the text composite over it exactly as they do on the panel.
        It is also what a card shows on its own while it is waiting for one of
        the six slots, which is the state every one of these cards used to be in
        permanently.
      */}
      {mode === 'still' && (
        <div
          className="kh-lookprev__still"
          style={paint === null ? undefined : { background: paint }}
        />
      )}
      {running && (
        <div
          className="kh-lookprev__stage"
          ref={stageRef}
          style={{
            width: `${String(panel.width)}px`,
            height: `${String(panel.height)}px`,
            /*
             * Panel pixels, shrunk to the card. The card's own size is a CSS
             * decision; this is the one number that has to agree with it.
             *
             * `--kh-lookprev-size` is UNITLESS (looks.css) because `scale()`
             * takes a number: with the token at `120px` this whole declaration
             * was invalid and silently dropped, and every card showed the
             * top-left 4.6 % of a 640 px stage. See looks.css for the measurement.
             */
            transform: `scale(calc(var(--kh-lookprev-size) / ${String(panel.width)}))`,
          }}
        />
      )}
      {/*
        The card MARKS itself when its dials are invented; the sentence is said
        once for the grid (F8, and see `looksReadSamples` below).

        A 100 px card in the rail's column has room for a dot and no room at all
        for "Sample readings — until CAM sends real ones", which measured four
        wrapped lines over a 104 px picture. Truncating it there would be the
        same failure F10 found on the budget meter, so the words go where there
        is room for them and the card keeps the pointer: `data-sampled` draws
        the mark, and `aria-hidden` is deliberately absent from neither — the
        note under the grid is the accessible statement.
      */}
      {running && sampled && <span className="kh-lookprev__sample" aria-hidden="true" />}
    </div>
  );
}
