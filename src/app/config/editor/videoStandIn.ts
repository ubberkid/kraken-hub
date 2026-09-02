/**
 * What `video` is on the CONFIGURATION window: a poster and an arc, never a
 * decoder.
 *
 * The editor's halo is a real `LayerHost` running the real display renderers, so
 * that what you drag is what the panel shows. Video is the one kind that cannot
 * be — and the reason is not performance, it is correctness:
 *
 *  - **One decoder per look is the model** (§0.4, `maxInstances: 1`). A second
 *    `<video>` on this origin is a second decoder and a second download, on a
 *    laptop battery, for a picture nobody is watching.
 *  - **A cross-origin YouTube `<iframe>` cannot be sampled at all**, so a
 *    "mirror" of one would be an embed playing a different second of the same
 *    video beside the panel's.
 *  - The existing home screen already made this decision and shipped it
 *    (`VideoHalo`): the poster, the source's name, and a live position arc fed
 *    from telemetry. This is that, as a `DisplayRenderer`, so the compositor can
 *    mount it exactly where the real one would go.
 *
 * The arc is pushed in through `command('progress', 0..1)` — the same imperative
 * channel a remote uses — so the editor can update it once a second from the
 * telemetry mirror without a React render per frame (I4).
 */

import type { DisplayRenderer, ModuleContext } from '../../../modules/types';

/** What this stand-in reads out of whatever config it is handed. */
interface StandInConfig {
  url?: unknown;
}

function nameOf(cfg: unknown): string {
  const url = (cfg as StandInConfig | null)?.url;
  if (typeof url !== 'string' || url === '') return 'Nothing chosen yet';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    return last === undefined || last === '' ? parsed.hostname.replace(/^www\./, '') : last;
  } catch {
    // A `kraken-hub-clip:<id>` ref is not a URL and never will be. The library
    // knows its name; the halo does not need to, and inventing one would be a
    // guess printed in the middle of the panel.
    return 'Your clip';
  }
}

/**
 * The stand-in.
 *
 * Deliberately DOM rather than canvas: it is two elements and one `stroke-dashoffset`
 * write per second, which is cheaper than any drawing loop and costs no context.
 */
/*
 * The SVG namespace. Not an origin — `createElementNS` will not make an
 * `<svg>` without it — but it is a URL-shaped literal, so it is named once here
 * rather than repeated inline where the "no hardcoded origins" rule would have
 * to be silenced twice.
 */
// eslint-disable-next-line no-restricted-syntax -- the SVG namespace, not a host
const SVG_NS = 'http://www.w3.org/2000/svg';

export function createVideoStandIn(): DisplayRenderer<unknown> {
  let host: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let arc: SVGCircleElement | null = null;
  let circumference = 0;

  const setProgress = (fraction: number | null): void => {
    if (arc === null) return;
    if (fraction === null || !Number.isFinite(fraction)) {
      arc.style.setProperty('opacity', '0');
      return;
    }
    const clamped = Math.max(0, Math.min(1, fraction));
    arc.style.setProperty('opacity', '1');
    arc.style.setProperty('stroke-dashoffset', String(circumference * (1 - clamped)));
  };

  return {
    mount(root: HTMLElement, _ctx: ModuleContext, config: unknown) {
      host = root;
      root.classList.add('kh-standin');

      const poster = document.createElement('div');
      poster.className = 'kh-standin__poster';
      poster.setAttribute('aria-hidden', 'true');

      label = document.createElement('p');
      label.className = 'kh-standin__name';
      label.textContent = nameOf(config);

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'kh-standin__arc');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('aria-hidden', 'true');
      const radius = 47;
      circumference = 2 * Math.PI * radius;
      arc = document.createElementNS(SVG_NS, 'circle');
      arc.setAttribute('cx', '50');
      arc.setAttribute('cy', '50');
      arc.setAttribute('r', String(radius));
      arc.setAttribute('pathLength', String(circumference));
      arc.style.setProperty('stroke-dasharray', String(circumference));
      arc.style.setProperty('stroke-dashoffset', String(circumference));
      arc.style.setProperty('opacity', '0');
      svg.append(arc);

      root.replaceChildren(poster, label, svg);
    },

    update(config: unknown) {
      if (label !== null) label.textContent = nameOf(config);
    },

    /** `progress` (0..1) from the telemetry mirror. Anything else is ignored. */
    command(op: string, arg?: unknown) {
      if (op !== 'progress') return;
      setProgress(typeof arg === 'number' ? arg : null);
    },

    unmount() {
      host?.classList.remove('kh-standin');
      host?.replaceChildren();
      host = null;
      label = null;
      arc = null;
    },
  };
}
