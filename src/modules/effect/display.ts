/**
 * STEP 3 (docs/modules.md §5) — the Effects renderer.
 *
 * One `<canvas>` per instance, one GL program, one three-vertex draw per painted
 * tick. The shape of the file, and why:
 *
 *  - **The fragment source arrives late, on purpose.** `effects.ts` reaches each
 *    one through a dynamic `import()`, so this chunk carries the runner and not
 *    the twelve programs; the panel downloads the ~1.5 kB of GLSL for the effect
 *    that is actually on screen. Until it lands, the two background colours are
 *    already painted as a CSS gradient, so a slow first frame is a still version
 *    of the right picture rather than a black panel.
 *  - **Nothing is allocated per frame.** Colours are unpacked into one
 *    `Float32Array` when the config changes; the draw path is `uniform*` calls
 *    and a `drawArrays`, with no object literals, no `map`, and no closures.
 *  - **Time is integrated, never read.** `frame()` accumulates `dt · speed`, so
 *    the speed slider bends the motion instead of jumping it, and `hz1` (one
 *    paint per second) is a *cadence* change rather than a *time* change: the
 *    effect is where it would have been either way.
 *  - **Warmth glides.** The monitoring feed is 1 Hz; writing a reading straight
 *    into the uniform would step every pixel once a second, which is precisely
 *    what CAM's frame compressor charges most for. `motion.ts` does the easing.
 *  - **The GL context is a resource, so it is released — but not on a switch.**
 *    Hidden means freed (`WEBGL_lose_context`), visible means rebuilt on a FRESH
 *    canvas element, and a driver-initiated loss takes the same path. Changing
 *    effect is the other verb entirely: the program is deleted and relinked on
 *    the SAME live context, because a canvas whose context was lost through the
 *    extension hands the same dead context back to `getContext` forever.
 *  - **Which of the three paths ran is written on the host.** `data-gl` on the
 *    root is `webgl2`, `webgl1` or `none`, and `data-gl-lost` is present while a
 *    context is gone. The fallback ladder was invisible before: the diagnostics
 *    report can say what the webview *offers*, but only the element can say what
 *    this panel actually got, which is what hardware row H29 has to read. The
 *    attribute records the renderer that is RUNNING, so a granted context whose
 *    program would not link reads `none` — the still frame is what is on screen.
 *    `DisplayRenderer` has no status hook to mirror it through; the element is
 *    the whole surface.
 *
 * "Effect" is the only word for these anywhere a user can read. The technical
 * one belongs in comments like this one and in `docs/design/effects-ports/`.
 */

import { createLogger } from '../../lib/log';
import { BASE_LAYER_ID } from '../../state/look/types';
import { setReplicaThumb } from '../replicaThumb';

import { loadFragment } from './effects';
import { advanceTime, approachTemp, normalizeTemp, shouldDraw, type BudgetTier } from './motion';
import { EFFECT_DEFAULTS, MAX_COLOUR_SLOTS, type EffectConfig } from './schema';

import type { NormalizedMonitoring } from '../../platform/monitoring';
import type { LayerId } from '../../state/look/types';
import type { DisplayRenderer, ModuleContext } from '../types';

import './effect.css';

const log = createLogger('modules/effect');

/** A fullscreen triangle needs three vertices and no buffer on WebGL2. */
const VERTEX_COUNT = 3;
const COLOUR_COMPONENTS = 3;

/** `#RRGGBB` -> three floats. */
const HEX_RADIX = 16;
const HEX_R = 1;
const HEX_G = 3;
const HEX_B = 5;
/** Two hex digits per channel; three components per colour; two per vertex. */
const PAIR = 2;
const BYTE_MAX = 255;

/** Readback for the phone's replica ring. Never more than once a second. */
const THUMB_INTERVAL_MS = 1000;
const THUMB_TYPE = 'image/webp';
const THUMB_QUALITY = 0.7;

/**
 * The vertex stage: three vertices covering the viewport, derived from
 * `gl_VertexID`, with no attribute and no buffer to allocate or free.
 */
const VS_ES3 = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** WebGL1 has no `gl_VertexID`, so the same triangle comes from a buffer. */
const VS_ES1 = `attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** Clip-space corner that puts the third vertex outside the viewport. */
const NDC_OVER = 3;
const ES1_TRIANGLE = new Float32Array([-1, -1, NDC_OVER, -1, -1, NDC_OVER]);

/**
 * GLSL ES 3.00 -> 1.00, which is a two-line change for these twelve sources:
 * they declare one output and use no other ES 3 syntax (every `transpose`/
 * `round` in the ports is inside a comment, and the minifier removes comments).
 */
function toEs1(frag: string): string {
  // The newline before `#` is not cosmetic: the sources are minified onto long
  // lines, and a preprocessor directive that does not start its own line is
  // rejected outright ("'#' : invalid character").
  return frag.replace('#version 300 es\n', '').replace('out vec4 o;', '\n#define o gl_FragColor\n');
}

function compile(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (sh === null) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
    log.warn(`effect program rejected: ${gl.getShaderInfoLog(sh) ?? 'no log'}`);
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  if (vs === null || fs === null) {
    if (vs !== null) gl.deleteShader(vs);
    if (fs !== null) gl.deleteShader(fs);
    return null;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  // Attached shaders are reference-counted by the program; deleting them here
  // is the documented way to make the program own them.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
    log.warn(`effect program did not link: ${gl.getProgramInfoLog(prog) ?? 'no log'}`);
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function hexComponent(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + PAIR), HEX_RADIX) / BYTE_MAX;
}

/** Writes `#RRGGBB` into three consecutive floats. No allocation. */
function unpackColour(hex: string, into: Float32Array, slot: number): void {
  const base = slot * COLOUR_COMPONENTS;
  into[base] = hexComponent(hex, HEX_R);
  into[base + 1] = hexComponent(hex, HEX_G);
  into[base + PAIR] = hexComponent(hex, HEX_B);
}

/**
 * Which of the three paths a panel is on, as one word on the host element.
 *
 * `'none'` is the CSS still frame — no context was granted, the program did not
 * link, or the context has been released because the display is hidden.
 */
export type GlKind = 'webgl2' | 'webgl1' | 'none';

/** The attribute H29 reads. `root.dataset.gl`, spelled once. */
export const GL_ATTR = 'data-gl';
/** Present (`"true"`) only between `webglcontextlost` and its restore. */
export const GL_LOST_ATTR = 'data-gl-lost';
/**
 * Which of the twelve is on the panel, by id.
 *
 * The same argument as `data-gl`: the element is the only place that can say
 * what is actually running, and a browser test that has to prove a runtime
 * SWITCH landed has nothing else to wait on — the picture changes every frame
 * anyway, so pixels alone cannot tell "switched" from "moved".
 */
export const EFFECT_ATTR = 'data-effect';

/**
 * The context and the program are two lifetimes, not one.
 *
 * They used to be one record, and freeing it took the context down with the
 * program — including on an effect SWITCH, which needs a new program and the
 * same context. `WEBGL_lose_context.loseContext()` is not undone by asking the
 * canvas for a context again: per the spec `getContext` hands back the SAME
 * object, still lost, until the page calls `restoreContext()`, and a browser
 * does not restore an extension-induced loss on its own. So the switch linked
 * against a dead context, `draw()` bailed on `isContextLost()`, and the panel
 * presented its lost drawing buffer — white on ANGLE/D3D11, which is what a real
 * Kraken showed. (Headless SwiftShader tolerated it, which is why an audit of
 * twelve switches passed.) Splitting the record splits the two verbs:
 * `releaseProgram()` for a switch, `dropContext()` for hidden/unmount/loss.
 */
interface GlContext {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  /** WebGL2 — decides the vertex stage and whether the source is transpiled. */
  es3: boolean;
}

interface GlProgram {
  prog: WebGLProgram;
  buffer: WebGLBuffer | null;
  uTime: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uTemp: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uBright: WebGLUniformLocation | null;
  uColors: (WebGLUniformLocation | null)[];
}

export function createRenderer(): DisplayRenderer<EffectConfig> {
  let root: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctxRef: ModuleContext | null = null;
  let cfg: EffectConfig = EFFECT_DEFAULTS;

  let glCtx: GlContext | null = null;
  let glProg: GlProgram | null = null;
  /**
   * True once this canvas's context has been lost — by us (`dropContext`) or by
   * the driver. A poisoned canvas can never grant a working context again, so
   * the next build replaces the ELEMENT rather than asking it twice.
   */
  let canvasPoisoned = false;
  let fragSource: string | null = null;
  /** Bumped on every load so a late `import()` for a stale effect is dropped. */
  let loadToken = 0;

  let time = 0;
  let tier: BudgetTier = 'full';
  let lastDrawAt: number | null = null;
  let lastThumbAt = 0;
  let hidden = false;

  let warmth = 0;
  /** The reading the warmth is gliding toward; `null` = CAM is not reporting it. */
  let warmthTarget: number | null = null;

  /**
   * The host's `data-gl`, written through one function so the element and the
   * renderer cannot disagree. Idempotent: a rebuild onto the same context kind
   * does not touch the DOM.
   */
  let glKind: GlKind = 'none';
  const setGlKind = (next: GlKind): void => {
    if (glKind === next && root?.getAttribute(GL_ATTR) === next) return;
    glKind = next;
    root?.setAttribute(GL_ATTR, next);
  };

  const colours = new Float32Array(MAX_COLOUR_SLOTS * COLOUR_COMPONENTS);
  let slots = EFFECT_DEFAULTS.colors.length;

  /**
   * This instance's slot on the replica ring.
   *
   * `ctx.layer?.id ?? BASE_LAYER_ID` is the idiom the contract asks for: two
   * effects in one look are two layers with two ids, and keying by "the effect
   * module" instead would have the overlay overwrite the base's thumbnail once
   * a second, forever.
   */
  const thumbKey = (): LayerId => ctxRef?.layer?.id ?? BASE_LAYER_ID;

  const readColours = (): void => {
    slots = Math.min(cfg.colors.length, MAX_COLOUR_SLOTS);
    for (let i = 0; i < slots; i += 1) {
      unpackColour(cfg.colors[i] ?? '#000000', colours, i);
    }
  };

  /**
   * The still picture, painted by CSS and owned by the root element.
   *
   * It is the first thing on screen (before the fragment source has been
   * fetched) and the last thing standing (no WebGL at all, or a program that
   * would not compile), so in every one of those cases the panel shows the
   * user's own two background colours rather than black.
   */
  const paintFallback = (): void => {
    if (root === null) return;
    const first = cfg.colors[0] ?? '#000000';
    const last = cfg.colors[cfg.colors.length - 1] ?? first;
    root.style.setProperty('--kh-effect-a', first);
    root.style.setProperty('--kh-effect-b', last);
    root.setAttribute(EFFECT_ATTR, cfg.effect);
  };

  const sizeCanvas = (): void => {
    if (canvas === null || ctxRef === null) return;
    const g = ctxRef.geometry();
    // DPR 1, deliberately: the panel IS the pixels. Rendering a full-surface
    // fragment program at 2× would double the cost for pixels CAM downsamples
    // away before the LCD ever sees them.
    const w = Math.max(Math.round(g.width), 1);
    const h = Math.max(Math.round(g.height), 1);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };

  const onContextLost = (e: Event): void => {
    // Without preventDefault the context is never restorable and the panel
    // stays on its still frame until the next reload — which, on a display that
    // runs for weeks, means forever.
    e.preventDefault();
    glProg = null;
    glCtx = null;
    // The element carries the loss: asking THIS canvas for a context again
    // returns the same dead one, which is the bug this whole split exists for.
    canvasPoisoned = true;
    lastDrawAt = null;
    setGlKind('none');
    root?.setAttribute(GL_LOST_ATTR, 'true');
    log.warn('GL context lost — rebuilding');
  };

  const onContextRestored = (): void => {
    root?.removeAttribute(GL_LOST_ATTR);
    // The driver restored THIS canvas, so it is usable again; `ensureContext()`
    // re-checks `isContextLost()` anyway and falls back to a fresh element if
    // the restore did not really take.
    canvasPoisoned = false;
    buildGl();
    draw();
  };

  /**
   * Delete the program and its buffer. **Keeps the context.**
   *
   * This is the effect-switch verb: the next program compiles against the same
   * live context, and the canvas keeps showing the last frame of the outgoing
   * effect for the ~1 frame it takes the new fragment source to arrive.
   */
  const releaseProgram = (): void => {
    if (glProg === null || glCtx === null) return;
    const { gl } = glCtx;
    if (!gl.isContextLost()) {
      gl.deleteProgram(glProg.prog);
      if (glProg.buffer !== null) gl.deleteBuffer(glProg.buffer);
    }
    glProg = null;
    lastDrawAt = null;
  };

  /**
   * Give the context back to the driver: hidden, unmounted, or already lost.
   *
   * A hidden display with a live GL context still owns driver memory, and this
   * page runs for weeks. The canvas is poisoned by the call — `getContext` on it
   * would return the same lost object forever — so the next build starts from a
   * fresh element.
   */
  const dropContext = (): void => {
    setGlKind('none');
    releaseProgram();
    if (glCtx === null) return;
    const lose: WEBGL_lose_context | null = glCtx.gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    glCtx = null;
    canvasPoisoned = true;
    lastDrawAt = null;
  };

  /**
   * Swap in a brand new `<canvas>` in the same place, with the same classes and
   * the same two listeners.
   *
   * The only way back from a lost context that the page itself caused: the
   * element carries the loss, not the renderer.
   */
  const replaceCanvas = (): void => {
    if (canvas === null || root === null) return;
    const next = document.createElement('canvas');
    next.className = canvas.className;
    canvas.replaceWith(next);
    canvas = next;
    canvasPoisoned = false;
    if (ctxRef !== null) {
      canvas.addEventListener('webglcontextlost', onContextLost, { signal: ctxRef.signal });
      canvas.addEventListener('webglcontextrestored', onContextRestored, { signal: ctxRef.signal });
    }
    sizeCanvas();
  };

  const CONTEXT_ATTRS = (): WebGLContextAttributes => ({
    alpha: ctxRef?.layer?.role === 'overlay',
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    // Nothing reads the buffer back except the 1 Hz thumbnail, which reads it
    // inside the same task as the draw. Preserving it would cost a copy per
    // frame for the other 39.
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  });

  const createContext = (): GlContext | null => {
    if (canvas === null) return null;
    const attrs = CONTEXT_ATTRS();
    const gl2 = canvas.getContext('webgl2', attrs);
    const gl: WebGLRenderingContext | WebGL2RenderingContext | null =
      gl2 ?? canvas.getContext('webgl', attrs);
    if (gl === null) return null;
    return { gl, es3: gl2 !== null };
  };

  /**
   * A LIVE context on the current canvas, or `null`.
   *
   * Reuses the one already in hand — that is the whole point of the split — and
   * only when it is genuinely gone does it go through a fresh element. The
   * second `isContextLost()` check is the belt to the poison flag's braces: it
   * catches the spec behaviour directly (a canvas handing back its own lost
   * context) without depending on this file having recorded the loss.
   */
  const ensureContext = (): GlContext | null => {
    if (glCtx !== null && !glCtx.gl.isContextLost()) return glCtx;
    if (glCtx !== null) {
      glProg = null;
      glCtx = null;
      canvasPoisoned = true;
    }
    if (canvas === null) return null;
    if (canvasPoisoned) replaceCanvas();

    let made = createContext();
    if (made?.gl.isContextLost() === true) {
      replaceCanvas();
      made = createContext();
      if (made?.gl.isContextLost() === true) made = null;
    }
    if (made === null) {
      log.warn('no WebGL context — the effect stays on its still frame');
      return null;
    }
    glCtx = made;
    return made;
  };

  /**
   * Compile and link the CURRENT fragment source against the current context,
   * and fetch every uniform location FROM THE NEW PROGRAM.
   *
   * Locations are per program and are never carried across a switch — a location
   * from the outgoing program is meaningless to the incoming one even when the
   * uniform has the same name.
   */
  const buildGl = (): void => {
    if (canvas === null || fragSource === null || glProg !== null || hidden) return;

    const ctx = ensureContext();
    if (ctx === null) {
      setGlKind('none');
      return;
    }
    const { gl, es3 } = ctx;

    const prog = link(gl, es3 ? VS_ES3 : VS_ES1, es3 ? fragSource : toEs1(fragSource));
    // A granted context whose program will not compile is still the still
    // frame, so the attribute says `none` rather than naming a renderer that
    // never drew anything.
    if (prog === null) {
      setGlKind('none');
      return;
    }

    let buffer: WebGLBuffer | null = null;
    if (!es3) {
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, ES1_TRIANGLE, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, PAIR, gl.FLOAT, false, 0, 0);
      }
    }

    const uColors: (WebGLUniformLocation | null)[] = [];
    for (let i = 0; i < slots; i += 1) {
      uColors.push(gl.getUniformLocation(prog, `uColor${String(i)}`));
    }

    glProg = {
      prog,
      buffer,
      uTime: gl.getUniformLocation(prog, 'uTime'),
      uResolution: gl.getUniformLocation(prog, 'uResolution'),
      uTemp: gl.getUniformLocation(prog, 'uTemp'),
      uScale: gl.getUniformLocation(prog, 'uScale'),
      uBright: gl.getUniformLocation(prog, 'uBright'),
      uColors,
    };
    setGlKind(es3 ? 'webgl2' : 'webgl1');
    lastDrawAt = null;
  };

  /**
   * Switch effect: drop the PROGRAM, keep the context, link the new source onto
   * it when the lazy import lands.
   *
   * `data-gl` is deliberately left alone across the gap. The context that is
   * running has not changed, and the canvas is still presenting the last frame
   * the outgoing program drew, so writing `none` here would claim a still frame
   * that is not what is on screen.
   */
  const loadProgram = (): void => {
    if (ctxRef === null) return;
    loadToken += 1;
    const token = loadToken;
    const wanted = cfg.effect;
    releaseProgram();
    fragSource = null;
    loadFragment(wanted).then(
      (src) => {
        // A slower import for an effect the user has already moved off must not
        // overwrite the one they are now looking at.
        if (token !== loadToken) return;
        fragSource = src;
        buildGl();
        draw();
      },
      (err: unknown) => {
        log.warn(`effect source failed to load: ${wanted}`, err);
      },
    );
  };

  const captureThumb = (): void => {
    if (canvas === null) return;
    const key = thumbKey();
    canvas.toBlob(
      (blob) => {
        setReplicaThumb(key, blob);
      },
      THUMB_TYPE,
      THUMB_QUALITY,
    );
  };

  function draw(): void {
    if (glProg === null || glCtx === null || canvas === null) return;
    const { gl } = glCtx;
    if (gl.isContextLost()) return;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(glProg.prog);
    gl.uniform1f(glProg.uTime, time);
    gl.uniform2f(glProg.uResolution, canvas.width, canvas.height);
    gl.uniform1f(glProg.uTemp, cfg.reactsToTemp ? warmth : 0);
    gl.uniform1f(glProg.uScale, cfg.scale);
    gl.uniform1f(glProg.uBright, cfg.brightness);
    for (let i = 0; i < glProg.uColors.length; i += 1) {
      const base = i * COLOUR_COMPONENTS;
      gl.uniform3f(
        glProg.uColors[i] ?? null,
        colours[base] ?? 0,
        colours[base + 1] ?? 0,
        colours[base + PAIR] ?? 0,
      );
    }
    gl.drawArrays(gl.TRIANGLES, 0, VERTEX_COUNT);
  }

  return {
    mount(host: HTMLElement, ctx: ModuleContext, config: EffectConfig) {
      ctxRef = ctx;
      cfg = config;
      root = document.createElement('div');
      root.className = 'kh-effect';
      // Before anything is asked of the driver the honest answer is the still
      // frame, which is also exactly what is painted at this instant.
      root.setAttribute(GL_ATTR, 'none');
      glKind = 'none';
      canvasPoisoned = false;
      canvas = document.createElement('canvas');
      canvas.className = 'kh-effect__canvas';
      root.append(canvas);
      host.append(root);

      canvas.addEventListener('webglcontextlost', onContextLost, { signal: ctx.signal });
      canvas.addEventListener('webglcontextrestored', onContextRestored, { signal: ctx.signal });

      readColours();
      paintFallback();
      sizeCanvas();
      loadProgram();
    },

    update(config: EffectConfig) {
      const effectChanged = config.effect !== cfg.effect;
      cfg = config;
      readColours();
      paintFallback();
      if (effectChanged) {
        loadProgram();
        return;
      }
      // Force the next tick to paint even at `hz1`: a config change the user
      // just made must not wait up to a second to appear.
      lastDrawAt = null;
      draw();
    },

    frame(f) {
      time = advanceTime(time, f.dt, cfg.speed);
      if (warmthTarget !== null) warmth = approachTemp(warmth, warmthTarget, f.dt);
      if (!shouldDraw(tier, f.frame, f.t, lastDrawAt)) return;
      lastDrawAt = f.t;
      draw();
      if (f.t - lastThumbAt >= THUMB_INTERVAL_MS) {
        lastThumbAt = f.t;
        captureThumb();
      }
    },

    monitoring(n: NormalizedMonitoring) {
      if (!cfg.reactsToTemp) return;
      const source = cfg.tempSource;
      const reading =
        source === 'cpu' ? n.cpu.tempC : source === 'gpu' ? n.gpu.tempC : n.kraken.liquidTempC;
      // `null` (CAM dropped the sensor) holds the current warmth rather than
      // gliding to cold — an absent reading is not a cold one.
      warmthTarget = normalizeTemp(reading);
    },

    geometry() {
      sizeCanvas();
      lastDrawAt = null;
      draw();
    },

    budget(next: BudgetTier) {
      tier = next;
    },

    visibility(v) {
      hidden = v === 'hidden';
      // Hidden gives the context back; un-hidden goes through `ensureContext()`,
      // which sees the poisoned canvas and builds on a fresh element rather than
      // asking the dead one twice.
      if (hidden) dropContext();
      else {
        buildGl();
        draw();
      }
    },

    reinit() {
      // Idempotent, and time-neutral: the watchdog fires on routine stalls, so
      // this may not restart the clock or re-fetch a source that is already in
      // hand. It rebuilds the context only when there isn't one.
      sizeCanvas();
      buildGl();
      lastDrawAt = null;
      draw();
    },

    unmount() {
      loadToken += 1;
      const key = thumbKey();
      dropContext();
      setReplicaThumb(key, null);
      root?.remove();
      root = null;
      glKind = 'none';
      canvas = null;
      ctxRef = null;
      fragSource = null;
    },
  };
}
