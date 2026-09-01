/**
 * "The quality bias selector is showing and hiding every like 1 second."
 *
 * The second symptom in the second report of the module-switch bug, and it has
 * the same cause as the third one ("everything repaints"): the remote read the
 * video's provider off `lastTele`, which is the most recent packet of ANY kind,
 * on a `tele` channel that four unrelated publishers share.
 *
 * `RemoteQuality`'s SHAPE depends on that provider — `bias` and `set` render a
 * `<Select>`, `readonly` and `none` render a paragraph — so a `monitor` packet
 * arriving between two `videoStats` packets did not merely blank a reading, it
 * tore the control out of the DOM. The display alternates `videoStats` (2 s)
 * and `monitor` (2.5 s) forever, so the picker blinked forever.
 *
 * The first test below is the reproduction, stated as the component contract:
 * hand it a packet with no provider and the `<Select>` is GONE. The second is
 * the fix, stated as the property that matters: while the caller keeps handing
 * it the last VIDEO packet, the `<Select>`'s DOM node survives every unrelated
 * packet on the channel — asserted on node identity, because a control that is
 * unmounted and remounted looks perfectly present every time you check.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { carriesVideoTelemetry } from '../useSync';

import { RemoteQuality } from './RemoteQuality';

import type { VideoModuleConfig } from '../../../modules/video/types';

const VIDEO_STATS: Record<string, unknown> = {
  ts: 1,
  kind: 'videoStats',
  provider: 'hls',
  quality: { height: 1080, label: '1080p' },
  levels: [
    { h: 720, l: '720p' },
    { h: 1080, l: '1080p' },
  ],
};

/** The replica feed's packet: the same channel, and no opinion about any video. */
const MONITOR: Record<string, unknown> = { ts: 2, kind: 'monitor', module: 'video' };

function config(): VideoModuleConfig {
  return {
    url: 'https://example.test/stream.m3u8',
    quality: { mode: 'auto', height: null },
  } as VideoModuleConfig;
}

let host: HTMLDivElement;
let root: Root;

/** React 19 warns unless every render and unmount is inside `act`. */
function draw(tele: Record<string, unknown> | null): void {
  act(() => {
    root.render(
      <RemoteQuality
        cfg={config()}
        tele={tele}
        fallbackProvider={null}
        onChange={() => undefined}
      />,
    );
  });
}

const selector = (): HTMLElement | null => host.querySelector('#remote-quality');

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('RemoteQuality on a shared telemetry channel', () => {
  it('loses the control entirely when handed a packet that knows nothing about video', () => {
    draw(VIDEO_STATS);
    expect(selector()).not.toBeNull();

    // Precisely what `lastTele` used to hand it, twice a second, forever.
    draw(MONITOR);
    expect(selector()).toBeNull();
    expect(host.querySelector('[data-testid="remote-quality-readout"]')).not.toBeNull();
  });

  it('keeps the very same DOM node while the last VIDEO packet is what it is given', () => {
    draw(VIDEO_STATS);
    const first = selector();
    expect(first).not.toBeNull();

    // The packet stream the display really produces. `carriesVideoTelemetry` is
    // what decides which of these updates `lastVideo`, so the loop below is the
    // caller's behaviour after the fix, not a restatement of it.
    const stream = [MONITOR, VIDEO_STATS, MONITOR, { ts: 3, kind: 'library', clips: [] }, MONITOR];
    let lastVideo: Record<string, unknown> = VIDEO_STATS;
    for (const packet of stream) {
      if (carriesVideoTelemetry(packet)) lastVideo = packet;
      draw(lastVideo);
      // Identity, not presence: a remounted control is visible every time too.
      expect(selector()).toBe(first);
    }
  });
});
