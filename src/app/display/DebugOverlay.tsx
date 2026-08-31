import { useEffect, useState } from 'react';

import type { DisplayRuntime } from './runtime';

/**
 * `?debug=1` / `diagnostics.showDebugOverlay` — geometry, achieved FPS and the
 * storage-delivery counters, drawn inside the safe inset.
 *
 * Stub in M0: it reads the same values the diagnostics report publishes, at
 * 1 Hz via `setInterval` rather than per frame, because a per-frame React
 * update is exactly what invariant I4 forbids.
 */
const REFRESH_MS = 1000;

export function DebugOverlay({ runtime }: { runtime: DisplayRuntime }) {
  const [text, setText] = useState('');

  useEffect(() => {
    const tick = (): void => {
      const g = runtime.geometry.get();
      const stats = runtime.frameClock.stats();
      setText(
        [
          `${String(g.width)}×${String(g.height)} ${g.shape} (${g.source})`,
          `target ${String(g.targetFps)} fps · achieved ${stats.achievedFps.toFixed(1)}`,
          `long frames ${String(stats.longFrames)} · dpr ${String(g.dpr)}`,
          `safe inset ${String(g.safeInsetPx)}px · inscribed ${String(g.inscribedSquarePx)}px`,
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
