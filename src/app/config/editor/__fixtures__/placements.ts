/**
 * The shipped kinds' placement table (§1.4), as data, for the editor's tests.
 *
 * It is a COPY on purpose. The editor may not import `src/modules/registry.ts`
 * (eager, and it would drag every manifest into `config-ui`), and a test that
 * read the real registry would be asserting facts about the video module rather
 * than about the op under test: "a third effect is refused" must stay true even
 * if effect's `maxInstances` changes, and it stays true here because the test
 * states the 2 it is testing against.
 *
 * W2 owns the real numbers. If the two ever disagree, the real ones win and this
 * table is just a fixture that needs a new value.
 */

import { IDENTITY } from '../../../../state/look/types';
import { fakeRegistry, type EditorPlacement } from '../registryPort';

export const TEST_PLACEMENTS: Record<string, EditorPlacement> = {
  video: {
    roles: ['base'],
    maxInstances: 1,
    resize: 'scale',
    minFrame: 0.5,
    overlayDefault: { frame: { w: 1, h: 1, shape: 'square' }, t: IDENTITY },
  },
  image: {
    roles: ['base', 'overlay'],
    maxInstances: 8,
    resize: 'scale',
    minFrame: 0.3,
    overlayDefault: {
      frame: { w: 0.8, h: 0.8, shape: 'circle' },
      t: { ...IDENTITY, x: 0.45, y: -0.45 },
    },
  },
  clock: {
    roles: ['base', 'overlay'],
    maxInstances: 8,
    resize: 'frame',
    minFrame: 0.4,
    overlayDefault: { frame: { w: 1, h: 0.5, shape: 'square' }, t: { ...IDENTITY, y: 0.55 } },
  },
  stats: {
    roles: ['base', 'overlay'],
    maxInstances: 8,
    resize: 'frame',
    minFrame: 0.4,
    overlayDefault: { frame: { w: 1.6, h: 0.5, shape: 'square' }, t: { ...IDENTITY, y: 0.6 } },
  },
  effect: {
    roles: ['base', 'overlay'],
    maxInstances: 2,
    resize: 'scale',
    minFrame: 0.5,
    overlayDefault: { frame: { w: 1.2, h: 1.2, shape: 'circle' }, t: IDENTITY },
  },
};

export const testRegistry = fakeRegistry(TEST_PLACEMENTS);
