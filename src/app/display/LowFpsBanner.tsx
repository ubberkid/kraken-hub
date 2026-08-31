import { useEffect, useState } from 'react';

/**
 * The highest-leverage piece of UX in the whole app.
 *
 * CAM's frame-rate slider defaults to **1 FPS**. A user who never touches it
 * sees a slideshow and blames us, not the slider. So when the panel reports
 * `targetFps <= lowFpsThreshold` and the active module actually animates, we
 * say exactly where the slider is — as a full card for 20 s, then as a small
 * persistent badge that costs almost nothing to encode.
 *
 * It clears itself the moment a higher `targetFps` is observed.
 */
const ADVISORY_MS = 20_000;

export function LowFpsBanner({
  targetFps,
  threshold,
  motionLevel = 'full',
}: {
  targetFps: number;
  threshold: number;
  /** The active module's `capabilities.motionLevel`; `static` never advises. */
  motionLevel?: 'static' | 'low' | 'full';
}) {
  const [expanded, setExpanded] = useState(true);
  const low = targetFps <= threshold && motionLevel !== 'static';

  useEffect(() => {
    if (!low) return undefined;
    const timer = setTimeout(() => {
      setExpanded(false);
    }, ADVISORY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [low]);

  if (!low) return null;

  if (!expanded) {
    return <div className="kh-lowfps__badge">{targetFps} FPS — raise Frame Rate in CAM</div>;
  }

  return (
    <div className="kh-overlay kh-lowfps">
      <div className="kh-card">
        <p className="kh-card__title">{targetFps} FPS</p>
        <p className="kh-card__body">
          Open CAM → Lighting → Kraken → Web Integration → <strong>Frame Rate</strong> and drag it
          to maximum.
        </p>
        <p className="kh-card__footer">This notice disappears once a higher frame rate is set.</p>
      </div>
    </div>
  );
}
