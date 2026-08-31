import { beforeEach, describe, expect, it } from 'vitest';

import { DIAG_DISPLAY_SUFFIX, DIAG_SCHEMA_VERSION } from '../../diag/report';
import { TELE_SUFFIX } from '../../modules/video/telemetry/videoTelemetry';
import { readRaw, removeRaw, writeRaw } from '../../platform/storage';

import { DISPLAY_SEEN_SUFFIX, hasDisplayBeenSeen } from './displaySeen';

describe('hasDisplayBeenSeen', () => {
  beforeEach(() => {
    removeRaw(DISPLAY_SEEN_SUFFIX);
    removeRaw(DIAG_DISPLAY_SUFFIX);
    removeRaw(TELE_SUFFIX);
  });

  it('is false on a fresh installation — nothing has ever connected', () => {
    expect(hasDisplayBeenSeen()).toBe(false);
    expect(readRaw(DISPLAY_SEEN_SUFFIX)).toBeNull();
  });

  it('latches the moment the display publishes anything', () => {
    writeRaw(
      TELE_SUFFIX,
      JSON.stringify({
        ch: 'tele',
        kind: 'videoStats',
        ts: 1,
        display: { w: 400, h: 400, shape: 'circle', targetFps: 40 },
      }),
    );
    expect(hasDisplayBeenSeen()).toBe(true);
    expect(readRaw(DISPLAY_SEEN_SUFFIX)).toBe('1');
  });

  /**
   * The reason the latch exists at all: telemetry is perishable. It stops when
   * CAM closes, and a user who finished setup last week must not be shown step
   * one again on a cold boot.
   */
  it('stays true after the evidence goes away', () => {
    writeRaw(
      DIAG_DISPLAY_SUFFIX,
      JSON.stringify({
        schemaVersion: DIAG_SCHEMA_VERSION,
        mode: 'display',
        device: { width: 400, height: 400, shape: 'circle', targetFps: 40 },
      }),
    );
    expect(hasDisplayBeenSeen()).toBe(true);

    removeRaw(DIAG_DISPLAY_SUFFIX);
    expect(hasDisplayBeenSeen()).toBe(true);
  });

  /** A report the CONFIG page wrote about itself is not a display connecting. */
  it('ignores a report this window wrote about itself', () => {
    writeRaw(
      DIAG_DISPLAY_SUFFIX,
      JSON.stringify({
        schemaVersion: DIAG_SCHEMA_VERSION,
        mode: 'config',
        device: { width: 400, height: 400, shape: 'circle', targetFps: 40 },
      }),
    );
    expect(hasDisplayBeenSeen()).toBe(false);
  });
});
