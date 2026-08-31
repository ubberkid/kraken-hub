import { describe, expect, it } from 'vitest';

import { YT_LADDER } from '../types';

import {
  YT_QUALITY_HEIGHTS,
  bufferHealthy,
  decideQuality,
  heightToQualityLabel,
  qualityLabelToHeight,
} from './qualityPolicy';

import type { QualitySignals } from './qualityPolicy';

function signals(over: Partial<QualitySignals> = {}): QualitySignals {
  return {
    observedHeight: 1080,
    loadedFraction: 0.5,
    duration: 300,
    currentTime: 10,
    bufferingEventsIn30s: 0,
    currentWidth: 1920,
    steppedUp: false,
    perf: 'auto',
    ladder: YT_LADDER,
    ...over,
  };
}

describe('§2.7 label map', () => {
  it('maps every documented label', () => {
    expect(YT_QUALITY_HEIGHTS).toEqual({
      small: 240,
      medium: 360,
      large: 480,
      hd720: 720,
      hd1080: 1080,
      hd1440: 1440,
      hd2160: 2160,
      highres: 2160,
    });
  });

  it('resolves labels to heights and back', () => {
    expect(qualityLabelToHeight('hd1080')).toBe(1080);
    expect(qualityLabelToHeight('small')).toBe(240);
    expect(qualityLabelToHeight('unknown')).toBeNull();
    expect(qualityLabelToHeight(null)).toBeNull();
    expect(heightToQualityLabel(1080)).toBe('hd1080');
    expect(heightToQualityLabel(1000)).toBe('hd720');
    expect(heightToQualityLabel(100)).toBeNull();
  });
});

describe('buffer health', () => {
  it('needs more than 6 s of buffer ahead of the playhead', () => {
    expect(bufferHealthy({ loadedFraction: 0.1, duration: 300, currentTime: 10 })).toBe(true);
    expect(bufferHealthy({ loadedFraction: 0.05, duration: 300, currentTime: 10 })).toBe(false);
    expect(bufferHealthy({ loadedFraction: 1, duration: Number.NaN, currentTime: 0 })).toBe(false);
  });
});

describe('§2.7 ladder policy', () => {
  it('is satisfied at 720 and above', () => {
    for (const h of [720, 1080, 1440, 2160]) {
      const d = decideQuality(signals({ observedHeight: h }));
      expect(d.action).toBe('ok');
      expect(d.telemetry).toBe('quality');
      expect(d.nextWidth).toBe(1920);
    }
  });

  it('steps 1920 -> 2560 on the size-limited hypothesis', () => {
    const d = decideQuality(signals({ observedHeight: 480 }));
    expect(d.action).toBe('step-up');
    expect(d.nextWidth).toBe(2560);
    expect(d.sizeCapProven).toBe(false);
  });

  it('stops escalating after one step and publishes quality-capped', () => {
    const d = decideQuality(signals({ observedHeight: 480, steppedUp: true, currentWidth: 2560 }));
    expect(d.action).toBe('hold');
    expect(d.telemetry).toBe('quality-capped');
    expect(d.sizeCapProven).toBe(true);
  });

  it('never steps past the widest rung', () => {
    const d = decideQuality(signals({ observedHeight: 480, currentWidth: 2560 }));
    expect(d.action).toBe('hold');
    expect(d.telemetry).toBe('quality-capped');
  });

  it('does not step up when the buffer is starved — that would make it worse', () => {
    const d = decideQuality(signals({ observedHeight: 360, loadedFraction: 0.01 }));
    expect(d.action).not.toBe('step-up');
    expect(d.telemetry).toBe('network-limited');
  });

  it('treats repeated buffering as network-limited even with a healthy buffer', () => {
    const d = decideQuality(signals({ observedHeight: 360, bufferingEventsIn30s: 2 }));
    expect(d.telemetry).toBe('network-limited');
  });

  it('steps DOWN under auto when the network is the limit', () => {
    const d = decideQuality(signals({ observedHeight: 360, loadedFraction: 0.01, perf: 'auto' }));
    expect(d.action).toBe('step-down');
    expect(d.nextWidth).toBe(1600);
  });

  it('holds instead of stepping down when the user pinned quality mode', () => {
    const d = decideQuality(
      signals({ observedHeight: 360, loadedFraction: 0.01, perf: 'quality' }),
    );
    expect(d.action).toBe('hold');
    expect(d.nextWidth).toBe(1920);
  });

  it('does nothing before onPlaybackQualityChange has ever fired', () => {
    const d = decideQuality(signals({ observedHeight: null }));
    expect(d.action).toBe('hold');
    expect(d.telemetry).toBe('quality-unknown');
  });
});
