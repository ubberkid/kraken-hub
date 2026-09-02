import { describe, expect, it } from 'vitest';

import { LOOK_TEMPLATES, templateById } from '../../../../../state/look/templates';
import { IDENTITY } from '../../../../../state/look/types';

import { createPreviewBudget, MAX_LIVE_PREVIEWS, previewModeOf, stillPaint } from './previewPolicy';

import type { LookFile } from '../../../../../state/look/file';

const CLOCK = templateById('tpl-minimal-clock')!.file;
const NEBULA = templateById('tpl-nebula-clock')!.file;

describe('what may run in a card', () => {
  it('lets an ordinary Look run live', () => {
    expect(previewModeOf(CLOCK)).toBe('live');
  });

  it('never opens a graphics context for an effect', () => {
    // Nebula's base is an effect. One context per card would evict the editor's
    // own canvas long before the grid finished scrolling.
    expect(previewModeOf(NEBULA)).toBe('still');
  });

  it('is a property of the whole Look, not only its base', () => {
    const overlayEffect: LookFile = {
      ...CLOCK,
      look: {
        layers: [
          ...CLOCK.look.layers,
          {
            id: 'lfx',
            kind: 'effect',
            on: true,
            frame: { w: 1, h: 1, shape: 'square' as const },
            t: IDENTITY,
          },
        ],
      },
    };
    expect(previewModeOf(overlayEffect)).toBe('still');
  });

  it('covers every shipped template without throwing', () => {
    for (const t of LOOK_TEMPLATES) expect(['live', 'still']).toContain(previewModeOf(t.file));
  });
});

describe('the still frame', () => {
  it('paints the Look’s own palette rather than inventing one', () => {
    const paint = stillPaint(NEBULA);
    expect(paint).not.toBeNull();
    // The first and last of the stored material, which is what the effect
    // module's own fallback paints.
    expect(paint).toContain('#00BCFF');
    expect(paint).toContain('#00003E');
  });

  it('says nothing at all when the Look has no colours to show', () => {
    expect(stillPaint(CLOCK)).toBeNull();
  });
});

describe('the live-preview budget', () => {
  it('hands out exactly its ceiling', () => {
    const budget = createPreviewBudget();
    const ids = Array.from({ length: MAX_LIVE_PREVIEWS + 3 }, (_, i) => `c${String(i)}`);
    const granted = ids.filter((id) => budget.claim(id));
    expect(granted).toHaveLength(MAX_LIVE_PREVIEWS);
    expect(budget.size()).toBe(MAX_LIVE_PREVIEWS);
  });

  it('is idempotent: claiming twice does not spend two slots', () => {
    const budget = createPreviewBudget(2);
    expect(budget.claim('a')).toBe(true);
    expect(budget.claim('a')).toBe(true);
    expect(budget.size()).toBe(1);
  });

  it('gives a waiting card its turn the moment one is freed', () => {
    const budget = createPreviewBudget(1);
    let woken = 0;
    budget.subscribe(() => {
      woken += 1;
    });
    expect(budget.claim('a')).toBe(true);
    expect(budget.claim('b')).toBe(false);
    budget.release('a');
    expect(woken).toBe(2);
    expect(budget.claim('b')).toBe(true);
  });

  it('ignores a release for a slot nobody held', () => {
    const budget = createPreviewBudget(1);
    let woken = 0;
    budget.subscribe(() => {
      woken += 1;
    });
    budget.release('nobody');
    expect(woken).toBe(0);
  });
});
