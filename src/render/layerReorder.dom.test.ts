/**
 * Why the base layer never moves in the DOM.
 *
 * `LayerHost` promises that reordering overlays costs zero raster (§2.6) and
 * that the base host is never detached (§0.4). Both halves rest on one fact
 * about the platform, and this is where it is written down:
 *
 *   - a `<canvas>` SURVIVES `insertBefore`. Moving it is a tree operation, not a
 *     re-creation: it keeps its element identity, its pixels and its rendering
 *     context. That is what makes reordering overlays free.
 *   - an `<iframe>` does NOT. Re-inserting it discards `contentWindow` and
 *     re-navigates — a YouTube embed would reload, lose its position and buy a
 *     network round trip. That is the concrete reason the base host is created
 *     once and never moved, and why `video` is `roles: ['base'],
 *     maxInstances: 1`.
 *
 * jsdom implements the iframe half faithfully (a re-insert produces a new window
 * and document) and implements no canvas contexts at all, so the WebGL
 * assertion is gated on a real context being obtainable. The Chromium half was
 * measured for real; see docs/design/w0-measurements.md.
 *
 * This file outlived the W0 spike it was written for: the measurement was
 * throwaway, the platform fact the design leans on is not.
 */

import { describe, expect, it } from 'vitest';

function hosts(): { a: HTMLDivElement; b: HTMLDivElement } {
  const a = document.createElement('div');
  const b = document.createElement('div');
  document.body.append(a, b);
  return { a, b };
}

describe('moving a layer host in the DOM', () => {
  it('keeps the canvas element itself — insertBefore is a move, not a re-create', () => {
    const { a, b } = hosts();
    const canvas = document.createElement('canvas');
    a.append(canvas);
    canvas.dataset['marker'] = 'kept';

    b.insertBefore(canvas, null);

    expect(canvas.parentElement).toBe(b);
    expect(b.firstElementChild).toBe(canvas);
    expect(canvas.dataset['marker']).toBe('kept');
    expect(canvas.isConnected).toBe(true);
  });

  const gl = document.createElement('canvas').getContext('webgl2');

  // jsdom has no canvas contexts; in a real browser this is the assertion the
  // reorder path depends on.
  it.skipIf(gl === null)('keeps its WebGL2 context object across insertBefore', () => {
    const { a, b } = hosts();
    const canvas = document.createElement('canvas');
    a.append(canvas);
    const before = canvas.getContext('webgl2');
    b.insertBefore(canvas, null);
    expect(canvas.getContext('webgl2')).toBe(before);
    expect(before?.isContextLost()).toBe(false);
  });

  it('DESTROYS an iframe: its window and document are replaced, so it re-navigates', () => {
    const { a, b } = hosts();
    const frame = document.createElement('iframe');
    a.append(frame);
    const windowBefore = frame.contentWindow;
    const documentBefore = frame.contentDocument;
    expect(windowBefore === null).toBe(false);

    b.insertBefore(frame, null);

    // Compared as booleans on purpose: a detached window cannot be serialised
    // for a diff (jsdom throws reading `location` on the discarded one).
    expect(frame.contentWindow === windowBefore).toBe(false);
    expect(frame.contentDocument === documentBefore).toBe(false);
  });
});
