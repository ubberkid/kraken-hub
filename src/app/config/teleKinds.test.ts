/**
 * The shared `tele` channel carries four unrelated conversations, and telling
 * them apart is what stopped the quality picker from blinking.
 *
 * The display publishes `videoStats` every 2 s, `monitor` every 2.5 s, a
 * `library` index every five minutes, and chunked `diagReport` / `thumb` parts
 * on demand. Only the video packets know anything about `provider`, `quality`
 * or `levels` — so a reader that takes "the most recent packet of any kind" and
 * asks it about the video gets "nothing known" roughly once a second, in
 * lockstep with the telemetry cadence. `qualityControlFor(null)` answers that
 * with `'none'`, which renders a paragraph where the `<Select>` was: the
 * control vanished and came back on the packet rate, and its whole DOM subtree
 * went with it.
 */

import { describe, expect, it } from 'vitest';

import { carriesVideoTelemetry } from './useSync';

describe('carriesVideoTelemetry', () => {
  it('claims the video module’s own packets', () => {
    expect(carriesVideoTelemetry({ ts: 1, kind: 'videoStats' })).toBe(true);
    // An error packet carries the provider and the quality too, and the picker
    // must keep showing the right control while an error is on screen.
    expect(carriesVideoTelemetry({ ts: 1, kind: 'videoError', provider: 'hls' })).toBe(true);
  });

  it('disclaims every other conversation on the channel', () => {
    expect(carriesVideoTelemetry({ ts: 1, kind: 'monitor', module: 'clock' })).toBe(false);
    expect(carriesVideoTelemetry({ ts: 1, kind: 'library', clips: [] })).toBe(false);
    expect(carriesVideoTelemetry({ ts: 1, kind: 'thumb', i: 0 })).toBe(false);
    expect(carriesVideoTelemetry({ ts: 1, kind: 'diagReport', i: 2 })).toBe(false);
    expect(carriesVideoTelemetry({ ts: 1, kind: 'offline' })).toBe(false);
  });

  it('goes by the fields when the kind is one it has never heard of', () => {
    // A peer on a different build, or a fork: the readers use the fields, so
    // the fields are what the test is.
    expect(carriesVideoTelemetry({ ts: 1, kind: 'videoStatsV2', provider: 'dash' })).toBe(true);
    expect(carriesVideoTelemetry({ ts: 1, kind: 'whatever', stats: { currentTime: 3 } })).toBe(
      true,
    );
    expect(carriesVideoTelemetry({ ts: 1, kind: 'whatever' })).toBe(false);
  });
});
