/**
 * The remote's live ring — a **state replica**, not a pixel stream.
 *
 * The old mini-halo was a stylized surface: a coloured disc that stood for the
 * display without ever showing it. This runs the display's *actual* module
 * renderer on the phone, driven by synced state. The clock ring is the real
 * clock renderer (and its time is correct by definition, because the phone has
 * its own clock); the stats ring is the real stats renderer, fed the monitoring
 * snapshot the display puts on the telemetry channel; the picture rings show a
 * thumbnail the display shipped once, keyed by content hash.
 *
 * ## Why this is allowed, and why the reverse would not be
 *
 * Invariant I8 forbids the DISPLAY graph from importing `src/ui` or
 * `src/app/config`. It says nothing about the other direction, and the other
 * direction is what this is: the config page reaching for a module's display
 * chunk. That chunk is already a separate lazy import — it has to be, so the
 * LCD downloads only the module it is showing — so loading it here costs the
 * config bundle nothing and `npm run size` proves it on every build.
 *
 * ## The seam that made it possible
 *
 * `DisplayRenderer.mount()` already takes a `ModuleContext` with `geometry()`,
 * `monitoring` and `render()` as *injected accessors* rather than reaching for
 * platform singletons. That was written for the display's own runtime; it turns
 * out to be exactly the seam a replica needs. So nothing in `clock/display.ts`
 * or `stats/display.ts` changed for this feature — the renderers cannot tell
 * they are on a phone, which is the strongest possible guarantee that the ring
 * shows what the panel shows.
 *
 * ## The two budgets
 *
 *  - **1 Hz, maximum.** Every module here is `motionLevel: 'static'` or
 *    `'low'`; a clock's second hand is the fastest thing on any of them.
 *  - **Fully paused when `document.hidden`.** A remote left open in a
 *    background tab must cost a phone nothing at all — no timer, no repaint.
 */

import { createLogger } from '../../lib/log';
import { resolveModule } from '../../modules/registry';
import { FALLBACK_SHAPE } from '../../platform/devicePresets';
import { deriveGeometry } from '../../platform/geometry';
import { snapshotToMonitoring, type MonitorSnapshot } from '../../sync/monitorSnapshot';

import type { DisplayRenderer, ModuleContext } from '../../modules/types';
import type { FrameClock, FrameInfo } from '../../platform/fpsGovernor';
import type { Geometry, GeometryRender } from '../../platform/geometry';
import type { MonitoringSource, NormalizedMonitoring } from '../../platform/monitoring';
import type { RenderSettings } from '../../state/schema';

const log = createLogger('config/replica');

/** 1 Hz, and not a frame faster — see the header. */
export const REPLICA_TICK_MS = 1000;
const MS_PER_SEC = 1000;

/** The panel geometry the display reported, as it arrives on the wire. */
export interface ReplicaDisplayInfo {
  w: number;
  h: number;
  shape: string;
  targetFps: number;
}

export interface ReplicaInput {
  moduleId: string;
  /** The active module's validated config, straight out of the synced state. */
  config: unknown;
  /**
   * The paired device's own geometry.
   *
   * `null` until a telemetry packet has arrived, and then FIXED for as long as
   * the display keeps reporting the same panel. This is the whole reason the
   * ring looks right: a stats dial tuned for a 240 px square must not be laid
   * out as though it were a 640 px circle just because the phone's ring is
   * round. Falling back to the library default would be a guess, so a replica
   * with no reported geometry renders at the fallback and says so upstream.
   */
  display: ReplicaDisplayInfo | null;
  render: RenderSettings;
  /** The last monitoring snapshot off the telemetry channel, if any. */
  monitor: MonitorSnapshot | null;
  /** When that snapshot was sampled, on the DISPLAY's clock. */
  monitorAt: number;
}

export interface ReplicaHandle {
  update(next: ReplicaInput): void;
  stop(): void;
}

/**
 * A `FrameClock` that never runs.
 *
 * The replica drives `renderer.frame()` from its own 1 Hz timer instead: a
 * module that subscribes to the clock on the display would otherwise get a
 * rAF-rate feed on a phone, which is exactly the battery cost this design
 * exists to avoid. `stats()` still answers honestly — zero frames, because
 * zero frames is what this clock has produced.
 */
function idleFrameClock(): FrameClock {
  return {
    subscribe: () => () => {
      /* nothing to unsubscribe from */
    },
    pause: () => undefined,
    resume: () => undefined,
    stats: () => ({ achievedFps: 0, longFrames: 0, lastTickAt: 0, paused: true, frame: 0 }),
    stop: () => undefined,
  };
}

/**
 * A `MonitoringSource` fed by the wire rather than by `window.nzxt`.
 *
 * `latest()` returning `null` is a first-class answer, and the stats renderer
 * already knows what to do with it: it shows "Waiting for CAM data…" rather
 * than a wall of zeroes. That is what the ring shows before the first packet
 * lands, and it is the truth.
 */
function wiredMonitoringSource(read: () => { norm: NormalizedMonitoring; at: number } | null): {
  source: MonitoringSource;
  push: (norm: NormalizedMonitoring) => void;
} {
  const subs = new Set<(n: NormalizedMonitoring, raw: NzxtV1.MonitoringData) => void>();
  return {
    push(norm) {
      for (const cb of subs) {
        try {
          // No raw payload crosses the wire — it is several hundred bytes of
          // fields no dial can show. Every renderer in the repo reads `norm`;
          // an empty object is the honest stand-in for what was not sent.
          cb(norm, {});
        } catch (err) {
          log.warn('replica monitoring subscriber threw', err);
        }
      }
    },
    source: {
      latest: () => {
        const now = read();
        return now === null ? null : { norm: now.norm, raw: {} };
      },
      subscribe(cb) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
      lastUpdateAt: () => read()?.at ?? 0,
      // Staleness is the display's call, not ours: it reports the snapshot it
      // has, and a packet that stops arriving already stops updating `at`.
      isStale: () => read() === null,
      isSimulated: () => false,
      intervals: () => [],
      rearm: () => undefined,
      dispose: () => {
        subs.clear();
      },
    },
  };
}

/**
 * The replica's fixed `Geometry`, derived from what the display reported.
 *
 * `render` is the two safe-area fractions and nothing else — `GeometryRender`,
 * not the whole `RenderSettings`. A caller memoising this has to key on what it
 * passes, and keying on a whole `RenderSettings` object means keying on an
 * identity `resolveState` rebuilds on every state delivery. Narrowing the type
 * is what lets `HomeView` key on two numbers instead, and a `RenderSettings`
 * still satisfies it, so every existing caller is unchanged.
 */
export function replicaGeometry(info: ReplicaDisplayInfo | null, render: GeometryRender): Geometry {
  return deriveGeometry(
    {
      width: info?.w ?? 0,
      height: info?.h ?? 0,
      // The platform's own rule, verbatim: anything that is not explicitly a
      // circle is treated as square — no mask, no inset loss, nothing cropped
      // away that the user expected to see. With no report at all we take the
      // library's own fallback rather than inventing one.
      shape: info === null ? FALLBACK_SHAPE : info.shape === 'circle' ? 'circle' : 'square',
      targetFps: info?.targetFps ?? 1,
      dpr: 1,
      // `'nzxt'` when we have a report, because that is literally where these
      // numbers came from — a display that read them off `window.nzxt` and put
      // them on the wire. It matters: `deriveGeometry` substitutes the
      // *preference* frame rate for a `'fallback'` source, and the number here
      // IS the reported one.
      source: info === null ? 'fallback' : 'nzxt',
    },
    { fallbackTargetFps: info?.targetFps ?? 1 },
    { safeRadiusPct: render.safeRadiusPct, safeAreaPct: render.safeAreaPct },
  );
}

/**
 * Mount a module's real display renderer into `host` and keep it fed.
 *
 * `host` is sized to the PANEL's pixel dimensions and scaled down by the
 * caller's CSS — that is what lets the renderer lay itself out exactly as it
 * does on the LCD while occupying 132 px on a phone. Sizing the host to the
 * ring instead would give a correct-looking but wrong picture: every module
 * here scales its type and its dials off `geometry()`, not off its container.
 */
export function startReplica(host: HTMLElement, initial: ReplicaInput): ReplicaHandle {
  let input = initial;
  let renderer: DisplayRenderer<unknown> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  const isDisposed = (): boolean => disposed;
  const abort = new AbortController();
  let frame = 0;
  let mountedModuleId = initial.moduleId;
  let lastConfig: unknown = initial.config;
  let lastMonitorAt = 0;
  let offMonitoring: (() => void) | null = null;

  const monitoring = wiredMonitoringSource(() =>
    input.monitor === null
      ? null
      : { norm: snapshotToMonitoring(input.monitor, input.monitorAt), at: input.monitorAt },
  );

  const ctx: ModuleContext = {
    geometry: () => replicaGeometry(input.display, input.render),
    frameClock: idleFrameClock(),
    monitoring: monitoring.source,
    render: () => input.render,
    log: createLogger(`replica/${initial.moduleId}`),
    signal: abort.signal,
  };

  const tick = (): void => {
    // The whole battery story, in one line: a hidden tab does nothing at all.
    if (document.hidden || renderer === null) return;
    frame += 1;
    const g = ctx.geometry();
    const info: FrameInfo = {
      t: performance.now(),
      dt: REPLICA_TICK_MS,
      frame,
      targetFps: g.targetFps,
      budgetMs: REPLICA_TICK_MS,
      // Honest: this clock delivers one frame a second and no more, so that is
      // what it achieves. A module reading this to decide how much work it can
      // afford will decide "very little", which is exactly right on a phone.
      achievedFps: MS_PER_SEC / REPLICA_TICK_MS,
    };
    renderer.frame?.(info);
  };

  void (async () => {
    try {
      const mod = resolveModule(initial.moduleId);
      const loaded = await mod.loadDisplay();
      if (isDisposed()) return;
      const created = loaded.createRenderer();
      await created.mount(host, ctx, mod.validate(initial.config));
      if (isDisposed()) {
        created.unmount();
        return;
      }
      renderer = created;
      // Subscribe the renderer to the wired feed, exactly as `ModuleHost` does
      // on the display. Without this the source is fed and nothing listens: the
      // stats ring sits on "Waiting for CAM data…" forever while the packets it
      // is waiting for arrive twice a second.
      offMonitoring = monitoring.source.subscribe((n, raw) => {
        created.monitoring?.(n, raw);
      });
      // A snapshot may already be in hand — the telemetry packet that told us
      // which module to load usually carries one — so push it before the first
      // tick, or the ring shows "waiting" for a second it does not need to.
      if (input.monitor !== null) {
        lastMonitorAt = input.monitorAt;
        created.monitoring?.(snapshotToMonitoring(input.monitor, input.monitorAt), {});
      }
      tick();
      timer = setInterval(tick, REPLICA_TICK_MS);
    } catch (err) {
      log.warn(`replica for module ${initial.moduleId} failed to mount`, err);
    }
  })();

  return {
    update(next) {
      const previous = input;
      input = next;
      if (renderer === null) return;
      // A module switch is a remount, and the caller owns that: it tears this
      // handle down and starts a new one, because a renderer cannot become a
      // different module.
      if (next.moduleId !== mountedModuleId) return;

      if (next.monitor !== null && next.monitorAt !== lastMonitorAt) {
        lastMonitorAt = next.monitorAt;
        monitoring.push(snapshotToMonitoring(next.monitor, next.monitorAt));
      }
      if (next.render !== previous.render || next.display !== previous.display) {
        renderer.geometry?.(ctx.geometry());
      }
      if (next.config !== lastConfig) {
        lastConfig = next.config;
        try {
          renderer.update(resolveModule(mountedModuleId).validate(next.config), {
            changed: ['*'],
            origin: 'remote',
          });
        } catch (err) {
          log.warn('replica renderer threw in update', err);
        }
      }
    },

    stop() {
      disposed = true;
      mountedModuleId = '';
      if (timer !== null) clearInterval(timer);
      timer = null;
      offMonitoring?.();
      offMonitoring = null;
      abort.abort();
      try {
        renderer?.unmount();
      } catch (err) {
        log.warn('replica renderer threw in unmount', err);
      }
      renderer = null;
      monitoring.source.dispose();
      host.replaceChildren();
    },
  };
}
