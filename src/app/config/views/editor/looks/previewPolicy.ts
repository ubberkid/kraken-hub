/**
 * How many Looks may be ALIVE on the screen at once, and what the rest show.
 *
 * §4 asks for live-rendered previews: the card is the Look, running, not a
 * screenshot somebody took once. That is the right promise and it is not free —
 * a live card is a `LayerHost` with the real renderers in it, and a grid of
 * thirty is thirty compositors sharing CAM's frame budget with the halo the user
 * is actually editing.
 *
 * Two caps, and they are different kinds of cap:
 *
 *  1. **Six live at a time** ({@link MAX_LIVE_PREVIEWS}), claimed by whichever
 *    cards are on screen. Everything else draws its still frame. Six is the
 *    number that fits a scrolled row and a half at CAM's window, so in practice
 *    what you are looking at is live and what you are not is not.
 *  2. **An effect LAYER is never live in a card** ({@link previewModeOf},
 *    {@link NEVER_LIVE_KINDS}). Effects are WebGL, one context each, and
 *    browsers hard-limit contexts per page — a grid that opened one per card
 *    would evict the EDITOR's own context and blank the canvas behind the
 *    sheet. So the effect's own still frame is painted instead: the first and
 *    last colours of the user's palette as a ramp, the same fallback
 *    `effect/display.ts` paints before its shader has loaded and after a
 *    context is lost. The real palette, drawn by CSS.
 *
 *    What this mode is NOT is a card with nothing else in it. Round 11's F-4
 *    measured five of the ten templates rendering as a single gradient div,
 *    because `LookPreview` treated `'still'` as a property of the CARD rather
 *    than of the layer and skipped the compositor entirely — so Nebula clock
 *    lost its clock and Lava lamp + temps lost its stats. The mode says which
 *    LAYERS must not run; `LookPreview` stills those and composites the rest.
 *
 * Pure. The allocator is a set with a ceiling and the policy is a fold over the
 * layers, so both are tested without a browser or a GPU.
 */

import { getModule } from '../../../../../modules/registry';

import type { LookFile } from '../../../../../state/look/file';

/** Live previews allowed at once, across the whole sheet. */
export const MAX_LIVE_PREVIEWS = 6;

/** The kinds that may not run in a card, and why is in the header. */
export const NEVER_LIVE_KINDS: readonly string[] = ['effect'];

export type PreviewMode = 'live' | 'still';

/**
 * Could this Look run in a card at all, budget aside?
 *
 * A Look containing an effect ANYWHERE — base or overlay — is still, not just
 * one whose base is an effect: an overlay effect opens exactly the same context.
 */
/**
 * Does this Look read the monitoring feed? — round 10's F8.
 *
 * A card whose Look carries a stats face runs the real renderer against
 * `previewMonitoring`, which invents numbers when nothing is publishing. The
 * sheet has to say so, and saying so starts with knowing which cards it is
 * about. `capabilities.needsMonitoring` is the module's own answer, so a kind
 * added later is covered without an edit here.
 *
 * A policy question about a `LookFile`, which is what this module is for.
 */
export function readsMonitoring(file: LookFile): boolean {
  return file.look.layers.some(
    (l) => l.on && getModule(l.kind)?.capabilities.needsMonitoring === true,
  );
}

export function previewModeOf(file: LookFile): PreviewMode {
  return file.look.layers.some((l) => NEVER_LIVE_KINDS.includes(l.kind)) ? 'still' : 'live';
}

/**
 * The still frame's paint: the Look's own colours, as a CSS ramp.
 *
 * Read from whichever layer actually carries a palette — the effect config's
 * `colors`, which is where the user's material choice lives. A Look with no
 * palette at all gets `null` and the card draws its neutral ground rather than
 * inventing a colour scheme for somebody's clock.
 *
 * Deliberately NOT a screenshot and deliberately not a canvas snapshot: both
 * are a picture of a Look at a moment, and this is the one thing in the sheet
 * that is allowed not to be live, so it should look like what it is.
 */
export function stillPaint(file: LookFile): string | null {
  const colours = paletteOf(file);
  if (colours === null) return null;
  const first = colours[0] ?? '#000000';
  const last = colours[colours.length - 1] ?? first;
  return `linear-gradient(145deg, ${first}, ${last})`;
}

/** Every place a palette can hide in a file: a base config, or an overlay's cfg. */
function paletteOf(file: LookFile): string[] | null {
  const fromConfigs = Object.values(file.configs)
    .map(coloursIn)
    .find((c) => c !== null);
  if (fromConfigs != null) return fromConfigs;
  for (const layer of file.look.layers) {
    const found = coloursIn(layer.cfg);
    if (found !== null) return found;
  }
  return null;
}

function coloursIn(cfg: unknown): string[] | null {
  if (cfg === null || typeof cfg !== 'object') return null;
  const raw = (cfg as Record<string, unknown>)['colors'];
  if (!Array.isArray(raw)) return null;
  const hex = raw.filter((c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
  return hex.length === 0 ? null : hex;
}

/**
 * Who is allowed to be live right now.
 *
 * First come, first served among the cards that are on screen — not "the first
 * six in the grid" — because the cards claim as they scroll into view and
 * release as they leave. A card that cannot get a slot is not broken; it is
 * still, and it takes a slot the moment one is freed.
 */
export interface PreviewBudget {
  claim: (id: string) => boolean;
  release: (id: string) => void;
  /** Whether this id currently holds a slot. */
  holds: (id: string) => boolean;
  size: () => number;
  /** Notified whenever a slot changes hands, so a waiting card can try again. */
  subscribe: (cb: () => void) => () => void;
}

export function createPreviewBudget(max: number = MAX_LIVE_PREVIEWS): PreviewBudget {
  const held = new Set<string>();
  const subs = new Set<() => void>();
  const emit = (): void => {
    for (const cb of [...subs]) cb();
  };
  return {
    claim: (id) => {
      if (held.has(id)) return true;
      if (held.size >= max) return false;
      held.add(id);
      emit();
      return true;
    },
    release: (id) => {
      if (held.delete(id)) emit();
    },
    holds: (id) => held.has(id),
    size: () => held.size,
    subscribe: (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}
