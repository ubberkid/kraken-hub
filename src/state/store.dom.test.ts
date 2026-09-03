/**
 * The store's notification is a claim that something CHANGED.
 *
 * `replace()` is how the sync layer hands this page a freshly resolved
 * snapshot, and `resolveState` builds a brand-new object graph on every call —
 * so an identity comparison there is a guard that never fires. Every inbound
 * frame therefore notified, `src/app/config/useSync.ts` published on the
 * notification, the peer published back, and two configuration surfaces held
 * the wire at ten frames a second with nobody touching anything. The same
 * notification rebuilt the editor's compositor (a new `LayerHost`, a new WebGL
 * context, `uTime` back to zero), which is what the user saw as a display that
 * "starts over from the beginning constantly".
 *
 * So the rule pinned here: a snapshot that is EQUAL is not a change, whatever
 * its identity, and the store says nothing about it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAppState } from './defaults';
import { resetStateCache } from './storage';
import { createStore } from './store';

import type { AppState } from './schema';

/** A structurally identical state with a brand-new identity — what `resolveState` returns. */
const cloneOf = (s: AppState): AppState => JSON.parse(JSON.stringify(s)) as AppState;

describe('store.replace', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStateCache();
  });

  afterEach(() => {
    localStorage.clear();
    resetStateCache();
  });

  it('does not notify for an equal-but-new snapshot', () => {
    const store = createStore(defaultAppState(), 'config');
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const twin = cloneOf(store.getSnapshot());
    expect(twin).not.toBe(store.getSnapshot());
    store.replace(twin);

    expect(notifications).toBe(0);
    store.dispose();
  });

  it('keeps the snapshot IDENTITY stable across an equal replace', () => {
    // React memo keys hang off this identity: `HomeView`'s halo panel is
    // derived from `state.render`, and a new identity there destroys and
    // rebuilds the editor's compositor.
    const store = createStore(defaultAppState(), 'config');
    const before = store.getSnapshot();
    store.replace(cloneOf(before));
    expect(store.getSnapshot()).toBe(before);
    store.dispose();
  });

  it('still notifies when the snapshot actually differs', () => {
    const store = createStore(defaultAppState(), 'config');
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const changed = cloneOf(store.getSnapshot());
    changed.render = { ...changed.render, rotate: 90 };
    store.replace(changed);

    expect(notifications).toBe(1);
    expect(store.getSnapshot().render.rotate).toBe(90);
    store.dispose();
  });

  it('notifies once, not twice, for two identical replaces of a new value', () => {
    const store = createStore(defaultAppState(), 'config');
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    const changed = cloneOf(store.getSnapshot());
    changed.render = { ...changed.render, rotate: 180 };
    store.replace(changed);
    store.replace(cloneOf(changed));

    expect(notifications).toBe(1);
    store.dispose();
  });
});
