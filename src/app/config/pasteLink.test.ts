import { describe, expect, it } from 'vitest';

import { defaultAppState } from '../../state/defaults';

import { submitVideoLink } from './pasteLink';

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
