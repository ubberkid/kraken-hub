import { describe, expect, it } from 'vitest';

import { DEVICE_PRESETS } from '../platform/devicePresets';

import {
  CAM_FRAME_RATE_INSTRUCTION,
  CAM_FRAME_RATE_LEAD,
  CAM_FRAME_RATE_TAIL,
  CAM_PATH_FRAME_RATE,
  fpsAdvisoryBody,
} from './camPaths';

/**
 * The instruction is exported in pieces so JSX can bold the path, and as one
 * string for surfaces that build plain text. Two spellings of one sentence is
 * exactly the drift this file exists to end, so the pieces are pinned to the
 * whole.
 */
describe('the CAM frame-rate instruction', () => {
  it('composes from its own parts', () => {
    expect(`${CAM_FRAME_RATE_LEAD} ${CAM_PATH_FRAME_RATE} ${CAM_FRAME_RATE_TAIL}`).toBe(
      CAM_FRAME_RATE_INSTRUCTION,
    );
  });

  it('names the maximum for the panel actually attached, never Elite’s', () => {
    // The number the copy used to hardcode, and the two panels it was wrong for.
    expect(fpsAdvisoryBody(DEVICE_PRESETS.elite.targetFps)).toContain('40 FPS on this panel');
    expect(fpsAdvisoryBody(DEVICE_PRESETS.z.targetFps)).toContain('1 FPS on this panel');
    expect(fpsAdvisoryBody(DEVICE_PRESETS.kraken2023.targetFps)).toContain('25 FPS on this panel');
    expect(fpsAdvisoryBody(DEVICE_PRESETS.z.targetFps)).not.toContain('Elite');
  });

  it('says nothing about a ceiling it cannot name', () => {
    for (const unknown of [null, 0, Number.NaN]) {
      const body = fpsAdvisoryBody(unknown);
      expect(body).toBe(`${CAM_FRAME_RATE_INSTRUCTION}.`);
      expect(body).not.toContain('FPS');
    }
  });

  it('always carries the one spelling of the path', () => {
    expect(fpsAdvisoryBody(40)).toContain(CAM_PATH_FRAME_RATE);
  });
});
