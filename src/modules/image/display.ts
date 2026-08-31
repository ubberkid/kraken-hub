/**
 * The image module's display renderer.
 *
 * Resolution order for a source, mirroring the video module's download-first
 * policy so the two modules behave the same way for the same reasons:
 *
 *   1. `kraken-hub-image:<id>` → paint it out of IndexedDB. Done, offline.
 *   2. Already downloaded from this URL? Paint the local copy. This is what
 *      makes a reboot with the network down keep working.
 *   3. `downloadMode: 'auto'` → fetch the bytes into the library here, on the
 *      display, then paint the local copy.
 *   4. A CORS refusal is NOT an error: point `<img>` at the remote URL and say
 *      nothing. The user sees their picture either way.
 *
 * GIFs are rendered as a plain `<img>`, so the browser animates them natively —
 * we never decode frames ourselves. What the LCD actually shows is governed by
 * CAM's capture rate, not by the GIF: at CAM's 1 FPS default you see one frame
 * of the animation per second. `imageUrl.ts` says so in the panel.
 *
 * Everything per-frame is imperative (invariant I4). In fact there is no
 * per-frame work at all — a still picture changes only when the config, the
 * geometry or the slideshow says so — which is why `needsFrameLoop` is false
 * and `frame()` is not implemented.
 */

import { createLogger } from '../../lib/log';
import { computeFit, toTransformCss } from '../../render/fit';

import { downloadImage } from './download';
import { getImageBlob, listImages, touchImage, type ImageRecord } from './imageStore';
import { validateImageUrl } from './imageUrl';

import type { ImageModuleConfig } from './schema';
import type { Geometry } from '../../platform/geometry';
import type { Rect } from '../../render/types';
import type { DisplayRenderer, ModuleContext, UpdateReason } from '../types';

import './image.css';

const log = createLogger('image/display');

const MS_PER_SEC = 1000;
const QUARTER_TURN = 90;
const THREE_QUARTER_TURN = 270;
/** Slideshow advances are cheap but not free; never poll faster than this. */
const MIN_TIMER_MS = 1000;

interface Source {
  /** What goes in `img.src`. Not named `href`: invariant 2's lint rule reads any
   * `x.href` in an assignment as a navigation, and it is right to. */
  src: string;
  /** Set when `href` is an object URL we own and must revoke. */
  objectUrl: string | null;
  label: string;
}

function isQuarterTurn(rotate: number): boolean {
  return rotate === QUARTER_TURN || rotate === THREE_QUARTER_TURN;
}

export function createRenderer(): DisplayRenderer<ImageModuleConfig> {
  let root: HTMLElement | null = null;
  let rot: HTMLElement | null = null;
  let img: HTMLImageElement | null = null;
  let message: HTMLElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let cfg: ImageModuleConfig | null = null;

  let source: Source | null = null;
  /** Bumped on every source change; an in-flight resolve compares against it. */
  let session = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let slides: ImageRecord[] = [];
  let slideIndex = 0;

  const releaseSource = (): void => {
    const owned = source?.objectUrl ?? null;
    // The display page runs for weeks; a leaked object URL pins the whole blob
    // for the life of the document.
    if (owned !== null) URL.revokeObjectURL(owned);
    source = null;
  };

  const setMessage = (text: string | null): void => {
    if (message === null) return;
    message.textContent = text ?? '';
    message.hidden = text === null;
  };

  /** The transform. Recomputed on load, on config change and on geometry change. */
  const applyFit = (): void => {
    if (img === null || rot === null || ctxRef === null || cfg === null) return;
    const g: Geometry = ctxRef.geometry();
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    if (natW <= 0 || natH <= 0) return;

    // A quarter turn swaps the box the picture is fitted into: the rotation is
    // applied to the WRAPPER, so the picture is laid out in the rotated frame
    // and then the whole frame is turned. One transform each, no trigonometry.
    const quarter = isQuarterTurn(cfg.render.rotate);
    const boxW = quarter ? g.height : g.width;
    const boxH = quarter ? g.width : g.height;

    rot.style.width = `${String(boxW)}px`;
    rot.style.height = `${String(boxH)}px`;
    rot.style.transform = `translate(-50%, -50%) rotate(${String(cfg.render.rotate)}deg)`;

    const rect: Rect = { x: 0, y: 0, w: natW, h: natH };
    const fit = computeFit({
      viewportW: boxW,
      viewportH: boxH,
      rect,
      fit: cfg.render.fit,
      zoom: cfg.render.zoom,
      offsetX: cfg.render.offsetX,
      offsetY: cfg.render.offsetY,
    });

    img.style.width = `${String(natW)}px`;
    img.style.height = `${String(natH)}px`;
    img.style.transform = toTransformCss(fit);
  };

  const show = (next: Source): void => {
    if (img === null) return;
    releaseSource();
    source = next;
    setMessage(null);
    img.hidden = false;
    img.alt = next.label;
    img.src = next.src;
  };

  /** Step 1 and 2 of the resolution order: anything already in the library. */
  const fromLibrary = async (id: string): Promise<Source | null> => {
    const blob = await getImageBlob(id);
    if (blob === null) return null;
    void touchImage(id);
    const objectUrl = URL.createObjectURL(blob);
    return { src: objectUrl, objectUrl, label: 'Stored image' };
  };

  const resolve = async (mine: number): Promise<void> => {
    if (cfg === null || ctxRef === null) return;
    const signal = ctxRef.signal;
    const stale = (): boolean => mine !== session || signal.aborted;

    if (cfg.slideshow.enabled) {
      slides = await listImages();
      if (stale()) return;
      if (slides.length > 0) {
        slideIndex = slideIndex % slides.length;
        await showSlide(mine);
        return;
      }
      // An empty library is not a failure state on its own — fall through and
      // treat the configured URL as the single "slide".
    }

    const url = cfg.url;
    const check = validateImageUrl(url, { context: 'display' });

    if (check.kind === 'empty') {
      setMessage('No image chosen.\nCAM → Kraken → Configure');
      if (img !== null) img.hidden = true;
      return;
    }

    if (check.kind === 'local') {
      const id = check.localId;
      const found = id === null ? null : await fromLibrary(id);
      if (stale()) return;
      if (found === null) {
        setMessage("That image isn't in this display's library.\nCAM → Kraken → Configure");
        if (img !== null) img.hidden = true;
        return;
      }
      show(found);
      return;
    }

    if (check.blocking) {
      setMessage(check.issues[0]?.message ?? 'That link cannot be shown.');
      if (img !== null) img.hidden = true;
      return;
    }

    // Step 2: already downloaded from this URL?
    const seen = (await listImages()).find((r) => r.sourceUrl === check.url);
    if (stale()) return;
    if (seen !== undefined) {
      const local = await fromLibrary(seen.id);
      if (stale()) return;
      if (local !== null) {
        show(local);
        return;
      }
    }

    // Step 3: download it into the library, right here on the display.
    if (cfg.downloadMode === 'auto') {
      const result = await downloadImage(check.url, signal);
      if (stale()) return;
      if (result.ok) {
        const objectUrl = URL.createObjectURL(result.blob);
        show({ src: objectUrl, objectUrl, label: result.record.name });
        return;
      }
      // Step 4: a refusal is not an error. Stream it.
      log.info(`keeping ${check.url} as a stream (${result.reason})`);
    }

    show({ src: check.url, objectUrl: null, label: 'Image' });
  };

  const showSlide = async (mine: number): Promise<void> => {
    const row = slides[slideIndex];
    if (row === undefined) return;
    const found = await fromLibrary(row.id);
    if (mine !== session) return;
    if (found === null) return;
    show({ ...found, label: row.name });
  };

  const restartTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (!cfg?.slideshow.enabled) return;
    const everyMs = Math.max(cfg.slideshow.intervalSec * MS_PER_SEC, MIN_TIMER_MS);
    timer = setInterval(() => {
      if (slides.length === 0) return;
      slideIndex = (slideIndex + 1) % slides.length;
      void showSlide(session);
    }, everyMs);
  };

  const restart = (): void => {
    session += 1;
    void resolve(session);
    restartTimer();
  };

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: ImageModuleConfig) {
      ctxRef = ctx;
      cfg = config;

      root = document.createElement('div');
      root.className = 'kh-image';
      root.style.background = config.background;

      rot = document.createElement('div');
      rot.className = 'kh-image__rot';

      img = document.createElement('img');
      img.className = 'kh-image__img';
      img.decoding = 'async';
      img.alt = '';
      img.addEventListener('load', applyFit, { signal: ctx.signal });
      img.addEventListener(
        'error',
        () => {
          setMessage('That image could not be loaded.\nCAM → Kraken → Configure');
          if (img !== null) img.hidden = true;
        },
        { signal: ctx.signal },
      );

      message = document.createElement('div');
      message.className = 'kh-image__message';
      message.hidden = true;

      rot.append(img);
      root.append(rot, message);
      host.append(root);

      restart();
    },

    update(config: ImageModuleConfig, reason: UpdateReason) {
      const previous = cfg;
      cfg = config;
      if (root !== null) root.style.background = config.background;

      const sourceChanged =
        previous?.url !== config.url ||
        previous.downloadMode !== config.downloadMode ||
        previous.slideshow.enabled !== config.slideshow.enabled;

      if (sourceChanged) {
        restart();
        return;
      }
      if (previous.slideshow.intervalSec !== config.slideshow.intervalSec) restartTimer();
      // Everything else is pure geometry: no refetch, no reload, no flicker.
      if (reason.changed.length > 0) applyFit();
    },

    geometry() {
      applyFit();
    },

    reinit() {
      /*
       * Re-resolve the current source, but do NOT touch the slideshow timer.
       *
       * The watchdog calls this whenever it sees a rAF or monitoring stall,
       * which on a hidden window happens routinely — and `restartTimer()` would
       * reset the countdown every time, so a slideshow on a machine that stalls
       * every few seconds would never advance at all. Caught by the e2e
       * slideshow test, which drives a fake clock and therefore trips the
       * watchdog on every fast-forward.
       */
      session += 1;
      void resolve(session);
    },

    unmount() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      session += 1;
      releaseSource();
      if (img !== null) img.removeAttribute('src');
      root?.remove();
      root = null;
      rot = null;
      img = null;
      message = null;
      ctxRef = null;
      cfg = null;
      slides = [];
    },
  };
}
