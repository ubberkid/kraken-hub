import { useEffect, useState } from 'react';

import type { DisplayRuntime } from './runtime';

/**
 * `?debug=1` / `diagnostics.showDebugOverlay` — geometry, achieved FPS, the
 * storage-delivery counters and ONE LINE PER LAYER, drawn inside the safe inset.
 *
 * The per-layer numbers (`p95`, the EMA of that layer's `frame()`) are
 * accumulated in the compositor's closure state and merely *read* here once a
 * second via `setInterval` — never per frame, because a per-frame React update
 * is exactly what invariant I4 forbids. It reads `runtime.layers`, so it prints
 * the same lines whether the stage is the configured look or the
 * `&pattern=stack` diagnostic.
 */
const REFRESH_MS = 1000;

export function DebugOverlay({ runtime }: { runtime: DisplayRuntime }) {
  const [text, setText] = useState('');

  useEffect(() => {
    const tick = (): void => {
      const g = runtime.geometry.get();
      const stats = runtime.frameClock.stats();
      const layers = runtime.layers.current?.stats() ?? null;
      setText(
        [
          `${String(g.width)}×${String(g.height)} ${g.shape} (${g.source})`,
          `target ${String(g.targetFps)} fps · achieved ${stats.achievedFps.toFixed(1)}`,
          `long frames ${String(stats.longFrames)} · dpr ${String(g.dpr)}`,
          `safe inset ${String(g.safeInsetPx)}px · inscribed ${String(g.inscribedSquarePx)}px`,
          ...(layers === null
            ? []
            : [
                `stack ${layers.tier} · ${String(layers.layers.length)} layers · ` +
                  `${String(layers.surfaces)} surfaces`,
                ...layers.layers.map(
                  (l) =>
                    `${l.id} ${l.kind} ${l.tier} ${
                      l.ticks
                        ? `p95 ${l.p95Ms.toFixed(2)}ms · ema ${l.emaMs.toFixed(2)}ms`
                        : 'no frame()'
                    }`,
                ),
                // A skipped or unknown kind renders NOTHING, so without this the
                // panel would simply be missing a layer with no way to find out why.
                ...layers.notes.map((note) => `! ${note.id} ${note.reason}`),
              ]),
        ].join('\n'),
      );
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [runtime]);

  return <div className="kh-debug">{text}</div>;
}
