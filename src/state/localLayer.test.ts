import { describe, expect, it } from 'vitest';

import { defaultAppState } from './defaults';
import { resolveState } from './precedence';

import type { DeepPartial } from './schema';
import type { AppState } from './schema';

/**
 * The precedence rule behind the "it reverts to Video after a second" bug.
 *
 * The mechanism, stated once: the remote layer outranks the persisted one and
 * it is sticky. A peer that once said `activeModuleId: 'video'` keeps saying it
 * — from an in-memory accumulation — for the life of the page, so every
 * re-resolve after a local switch to Clock put `video` back. The `local` layer
 * is what a deliberate local edit goes into, and it sits above `remote` and
 * below `url`.
 *
 * `src/sync/appSync.ts` owns WHEN that layer is filled and cleared (a live
 * frame clears it, a retained replay does not — see `appSync.test.ts`); this
 * file owns the ordering it depends on.
 */
const persisted: DeepPartial<AppState> = { activeModuleId: 'clock' };
const remote: DeepPartial<AppState> = { activeModuleId: 'video' };

describe('the local layer', () => {
  it('is what the bug needed: remote alone still beats persisted', () => {
    // Unchanged behaviour, asserted so the fix cannot be mistaken for
    // "local edits always win", which would break the phone remote.
    expect(resolveState({ persisted, remote }).state.activeModuleId).toBe('video');
  });

  it('lets a local edit outrank a stale remote entry', () => {
    const local: DeepPartial<AppState> = { activeModuleId: 'clock' };
    expect(resolveState({ persisted, remote, local }).state.activeModuleId).toBe('clock');
  });

  it('still loses to a URL parameter, which always wins', () => {
    const local: DeepPartial<AppState> = { activeModuleId: 'clock' };
    const url: DeepPartial<AppState> = { activeModuleId: 'stats' };
    expect(resolveState({ persisted, remote, local, url }).state.activeModuleId).toBe('stats');
  });

  it('merges per leaf, so an unrelated remote value survives a local edit', () => {
    const resolved = resolveState({
      persisted,
      remote: { activeModuleId: 'video', render: { zoom: 2 } },
      local: { activeModuleId: 'clock' },
    });
    expect(resolved.state.activeModuleId).toBe('clock');
    expect(resolved.state.render.zoom).toBe(2);
  });

  it('protects module config, not just the active module', () => {
    // The bug class is general: ANY setting changed locally has to survive a
    // stale echo, which is why the fix is a layer and not a special case.
    const resolved = resolveState({
      remote: { modules: { video: { v: 2, cfg: { url: 'old' } } } },
      local: { modules: { video: { v: 2, cfg: { url: 'new' } } } },
    });
    const cfg = resolved.state.modules['video']?.cfg as { url?: string } | undefined;
    expect(cfg?.url).toBe('new');
  });

  it('is inert when empty — the normal case', () => {
    const withLayer = resolveState({ persisted, remote, local: {} }).state;
    const without = resolveState({ persisted, remote }).state;
    expect(withLayer.activeModuleId).toBe(without.activeModuleId);
  });

  it('reports its paths as overridden, like the other layers above persisted', () => {
    const resolved = resolveState({ persisted, local: { activeModuleId: 'clock' } });
    expect(resolved.overridden).toContain('activeModuleId');
  });

  it('never breaks the defaults floor', () => {
    expect(resolveState({ local: {} }).state.activeModuleId).toBe(defaultAppState().activeModuleId);
  });
});
