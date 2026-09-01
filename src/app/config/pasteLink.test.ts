import { describe, expect, it } from 'vitest';

import { defaultAppState } from '../../state/defaults';

import { pasteAction, submitVideoLink } from './pasteLink';

import type { ConfigRuntime } from './runtime';
import type { AppState } from '../../state/schema';
import type { Store } from '../../state/store';

/**
 * One paste, one meaning, on both surfaces.
 *
 * The home screen's row and the Library page's **+** panel used to be different
 * code, and the copies had drifted: the Library page called the download
 * manager directly, which skipped the `config` validation context (so an
 * `http://` link was never upgraded) and skipped `downloadMode` entirely.
 *
 * The store here is a stub rather than `createStore()` deliberately — this is a
 * test about validation and what gets committed, not about persistence.
 */
function stubRuntime(initial: AppState = defaultAppState()): {
  runtime: ConfigRuntime;
  commits: number;
} {
  let snapshot = initial;
  const counter = { n: 0 };
  const store: Partial<Store> = {
    getSnapshot: () => snapshot,
    commit: (mutate) => {
      counter.n += 1;
      snapshot = mutate(snapshot);
      return snapshot;
    },
  };
  return {
    runtime: { store: store as Store } as ConfigRuntime,
    get commits() {
      return counter.n;
    },
  };
}

describe('submitVideoLink', () => {
  it('makes a valid link the video source and activates the video module', () => {
    const stub = stubRuntime();
    const result = submitVideoLink(stub.runtime, '  https://example.test/clip.mp4  ');

    expect(result.accepted).toBe(true);
    const next = stub.runtime.store.getSnapshot();
    expect(next.activeModuleId).toBe('video');
    expect((next.modules['video']?.cfg as { url: string }).url).toBe(
      'https://example.test/clip.mp4',
    );
  });

  it('commits the NORMALIZED url, so an http link is upgraded rather than mixed', () => {
    const stub = stubRuntime();
    const result = submitVideoLink(stub.runtime, 'http://example.test/clip.mp4');

    expect(result.accepted).toBe(true);
    expect((stub.runtime.store.getSnapshot().modules['video']?.cfg as { url: string }).url).toBe(
      'https://example.test/clip.mp4',
    );
    // The upgrade is worth a word to the user, not a silent rewrite.
    expect(result.issue).not.toBeNull();
  });

  it('commits nothing for an empty box', () => {
    const stub = stubRuntime();
    expect(submitVideoLink(stub.runtime, '   ')).toEqual({ issue: null, accepted: false });
    expect(stub.commits).toBe(0);
  });

  it('reports a blocking problem and leaves the source alone', () => {
    const stub = stubRuntime();
    const before = stub.runtime.store.getSnapshot();
    const result = submitVideoLink(stub.runtime, 'not a url at all');

    expect(result.accepted).toBe(false);
    expect(result.issue?.severity).toBe('error');
    expect(stub.commits).toBe(0);
    expect(stub.runtime.store.getSnapshot()).toBe(before);
  });

  it('keeps every other video setting the user had chosen', () => {
    const initial = defaultAppState();
    const seeded: AppState = {
      ...initial,
      modules: {
        ...initial.modules,
        video: { v: 1, cfg: { url: '', downloadMode: 'stream-only' } },
      },
    };
    const stub = stubRuntime(seeded);
    submitVideoLink(stub.runtime, 'https://example.test/clip.mp4');

    const cfg = stub.runtime.store.getSnapshot().modules['video']?.cfg as {
      downloadMode: string;
    };
    expect(cfg.downloadMode).toBe('stream-only');
  });
});

/**
 * The mapping both surfaces read — round 5's S1.
 *
 * It lived inside `HomeView`, so it existed on exactly one of the two screens
 * that draw this row. The phone's field committed `modules.video.cfg.url`
 * whatever was on the panel: with Image active, a pasted `.jpg` went into the
 * video config, the image module stayed empty, and the receipt underneath said
 * it had been sent. These assertions are about the mapping rather than about
 * either screen, because a mapping only one screen consults is the bug.
 */
describe('pasteAction', () => {
  it('is the picture field when Image is on the panel', () => {
    const stub = stubRuntime({ ...defaultAppState(), activeModuleId: 'image' });
    const action = pasteAction(stub.runtime, 'image');

    expect(action?.moduleId).toBe('image');
    expect(action?.label).toBe('Paste a picture link');
    expect(action?.submitLabel).toBe('Show');
    // It keeps what it committed: the row IS the panel's old picture input.
    expect(action?.clearOnAccept).toBe(false);
  });

  it('is the video field when Video is on the panel', () => {
    const stub = stubRuntime();
    const action = pasteAction(stub.runtime, 'video');

    expect(action?.moduleId).toBe('video');
    expect(action?.label).toBe('Paste a video link');
    expect(action?.submitLabel).toBe('Play');
    expect(action?.clearOnAccept).toBe(true);
  });

  it('commits a picture link to the IMAGE module, never to the video url', () => {
    const stub = stubRuntime({ ...defaultAppState(), activeModuleId: 'image' });
    const action = pasteAction(stub.runtime, 'image');
    const outcome = action?.submit('https://example.test/photo.jpg');

    expect(outcome?.accepted).toBe(true);
    const next = stub.runtime.store.getSnapshot();
    expect((next.modules['image']?.cfg as { url: string }).url).toBe(
      'https://example.test/photo.jpg',
    );
    // The reproduction, inverted: the video config must be untouched.
    expect((next.modules['video']?.cfg as { url?: string } | undefined)?.url ?? '').toBe('');
    expect(next.activeModuleId).toBe('image');
  });

  it('has nothing to offer Clock and Stats, so both surfaces show the quiet switch', () => {
    const stub = stubRuntime();
    expect(pasteAction(stub.runtime, 'clock')).toBeNull();
    expect(pasteAction(stub.runtime, 'stats')).toBeNull();
  });

  it('shortens the placeholder on a narrow screen without changing the noun', () => {
    const stub = stubRuntime();
    const wide = pasteAction(stub.runtime, 'video');
    const phone = pasteAction(stub.runtime, 'video', { narrow: true });

    expect(wide?.placeholder.length).toBeGreaterThan(phone?.placeholder.length ?? 0);
    expect(phone?.placeholder).toContain('video link');
  });

  it('reports what the module is holding, so a field can mirror it', () => {
    const initial = defaultAppState();
    const stub = stubRuntime({
      ...initial,
      modules: {
        ...initial.modules,
        video: { v: 1, cfg: { url: 'https://example.test/clip.mp4' } },
      },
    });
    expect(pasteAction(stub.runtime, 'video')?.value).toBe('https://example.test/clip.mp4');
  });
});
