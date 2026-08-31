import type { Geometry } from '../../platform/geometry';
import type { ReactNode } from 'react';

import './display.css';

/**
 * The host element for everything on the LCD.
 *
 * `contain: strict` keeps a misbehaving module from affecting layout outside
 * the stage, and the round mask (applied only when the panel really is round,
 * or when the user forced it) both prevents corner bleed into CAM's capture and
 * pins the invisible corners to flat black.
 *
 * The circle is also drawn under the simulator so a developer sees exactly what
 * the panel will clip — that is the whole point of the preview bezel.
 */
export function Stage({
  geometry,
  masked,
  background,
  children,
}: {
  geometry: Geometry;
  masked: boolean;
  background: string;
  children: ReactNode;
}) {
  return (
    <div
      className={masked ? 'kh-stage kh-stage--circle' : 'kh-stage'}
      data-shape={geometry.shape}
      data-target-fps={geometry.targetFps}
      style={{ background }}
    >
      {children}
    </div>
  );
}
