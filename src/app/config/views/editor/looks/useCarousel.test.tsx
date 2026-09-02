import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAppState } from '../../../../../state/defaults';
import { createStore, type Store } from '../../../../../state/store';

import { useCarousel } from './useCarousel';

/**
 * **The carousel does not open the library until there is a rotation to run.**
 *
 * This hook is mounted on the HOME screen, and `state.carousel` is undefined
 * until somebody switches a rotation on. Reading the media index at mount
 * therefore pulled `module-video` and `module-image` — and every row in both
 * stores — into CAM's boot path for a feature that was off, and ran the
 * legacy→merged picture migration before anybody had opened the shelf. The
 * spy counts exactly that: reads, against the state that should or should not
 * cause one.
 */

vi.mock('./mediaIndex', () => ({ readMediaIndex: vi.fn(() => Promise.resolve([])) }));

const { readMediaIndex } = await import('./mediaIndex');
const readSpy = vi.mocked(readMediaIndex);

let host: HTMLDivElement;
let root: Root;
let store: Store;

function Probe({ owns }: { owns: boolean }) {
  useCarousel({ store, owns });
  return null;
}

function mount(owns = true): void {
  act(() => {
    root.render(<Probe owns={owns} />);
  });
}

function switchOn(): void {
  act(() => {
    store.commit((s) => ({ ...s, carousel: { lookIds: ['a', 'b'], intervalSec: 30 } }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  readSpy.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  store = createStore(defaultAppState(), 'config', { commitBase: 'snapshot' });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  store.dispose();
});

describe('useCarousel media reads', () => {
  it('reads nothing at mount while the rotation is off', () => {
    expect(defaultAppState().carousel).toBeUndefined();
    mount();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('reads once when the rotation is switched on', () => {
    mount();
    switchOn();
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('does not read again on later commits while it stays on', () => {
    mount();
    switchOn();
    act(() => {
      store.commit((s) => ({ ...s, carousel: { lookIds: ['a', 'b'], intervalSec: 60 } }));
    });
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('reads at mount when the rotation is already on', () => {
    store.commit((s) => ({ ...s, carousel: { lookIds: ['a', 'b'], intervalSec: 30 } }));
    readSpy.mockClear();
    mount();
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('never reads in a window that does not own the bytes', () => {
    mount(false);
    switchOn();
    expect(readSpy).not.toHaveBeenCalled();
  });
});
