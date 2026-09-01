import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Meter } from './index';

/**
 * The Meter's null contract, as an invariant — round 5's S3.
 *
 * The bug was one operator: `` width: `${pct ?? 100}%` ``, under a docstring
 * that said `null` rendered indeterminate. Four call sites pass `null`, all for
 * the same reason (the total is not known), and all four drew a full accent-
 * coloured bar — the exact pixels a *completed* download produces. A quota
 * nobody had measured read as a full disk; a chunked transfer read as finished
 * at byte one and stayed finished while the bytes climbed.
 *
 * The assertions below are deliberately about the DOM rather than about
 * computed style: what must be true is that when the percentage is unknown
 * there is **no fill element at all**, so no stylesheet, override or future
 * refactor can quietly reintroduce a width. jsdom does not run the animation,
 * and it does not need to — the treatment is CSS, the contract is structural.
 */

let host: HTMLDivElement;
let root: Root;

function draw(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

const fill = (): HTMLElement | null => host.querySelector('.kh-meter__fill');
const pulse = (): HTMLElement | null => host.querySelector('.kh-meter__pulse');
const track = (): HTMLElement | null => host.querySelector('.kh-meter__track');

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

describe('Meter', () => {
  it('draws a fill at the percentage it was given', () => {
    draw(<Meter pct={40} />);
    expect(fill()?.style.width).toBe('40%');
    expect(pulse()).toBeNull();
    expect(track()?.getAttribute('aria-valuenow')).toBe('40');
  });

  it('draws NO fill when the percentage is unknown — never a full bar', () => {
    draw(<Meter pct={null} label="space in use — unknown" />);
    expect(fill()).toBeNull();
    expect(pulse()).not.toBeNull();
    expect(host.querySelector('[data-known="false"]')).not.toBeNull();
  });

  it('omits aria-valuenow when indeterminate, rather than announcing a number', () => {
    draw(<Meter pct={null} />);
    // Absent, not "0" and not "100": an absent `aria-valuenow` is how ARIA
    // spells indeterminate, and either number would be the same lie in audio.
    expect(track()?.hasAttribute('aria-valuenow')).toBe(false);
  });

  it('treats a non-finite percentage as unknown too', () => {
    draw(<Meter pct={Number.NaN} />);
    expect(fill()).toBeNull();
    expect(pulse()).not.toBeNull();
  });

  it('goes back to a real fill the moment a percentage arrives', () => {
    draw(<Meter pct={null} />);
    expect(fill()).toBeNull();
    draw(<Meter pct={0} />);
    // Zero is a KNOWN quantity and gets a real (empty) fill, not the pulse.
    expect(fill()?.style.width).toBe('0%');
    expect(pulse()).toBeNull();
  });
});
