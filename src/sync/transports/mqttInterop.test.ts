import { describe, expect, it } from 'vitest';

import { describeMqttModule, resolveMqttConnect } from './MqttTransport';

/**
 * The regression pin for the production bug that shipped in 2f556b4.
 *
 * On a real Kraken Elite (CAM 4.76.5, Electron 32.1.0 / Chromium 128) every
 * boot logged:
 *
 *   sync/service  mqtt connect failed — trying the next transport
 *   TypeError: (intermediate value).connect is not a function
 *
 * Cause: mqtt's exports map serves node (and therefore vitest) a real ESM
 * `build/index.js` with a named `connect`, but serves browsers
 * `dist/mqtt.esm.js`, whose only export is a `default`. The old code called
 * `(await import('mqtt')).connect(...)` and worked everywhere except the one
 * place that matters.
 *
 * Two halves are needed to pin that, and this file has both:
 *
 *  1. the resolver against the REAL package, imported exactly the way the
 *     transport imports it — that proves the shipped dependency is still
 *     resolvable without touching a broker;
 *  2. the resolver against each synthetic shape, including the browser one that
 *     node's resolution can never produce here.
 */

describe('mqtt ESM/CJS interop', () => {
  it('resolves a callable from the REAL mqtt package, imported as the transport imports it', async () => {
    const mod: unknown = await import('mqtt');
    const connect = resolveMqttConnect(mod);
    expect(connect).not.toBeNull();
    expect(typeof connect).toBe('function');
  });

  it('names the shapes it found when nothing is callable', async () => {
    const mod: unknown = await import('mqtt');
    // The diagnostic must be usable on a device with no devtools, so it has to
    // say what it saw, not just that it failed.
    expect(describeMqttModule(mod)).toMatch(/module=object/);
    expect(describeMqttModule(mod)).toMatch(/connect=function|default\.connect=function/);
  });
});

describe('resolveMqttConnect — the shapes a bundler can emit', () => {
  const fn = (): unknown => ({});

  it('takes a named `connect` export first (node / vitest resolution)', () => {
    const connect = resolveMqttConnect({ connect: fn });
    expect(connect).not.toBeNull();
  });

  it('takes `default.connect` when the namespace has only a default (the browser build)', () => {
    // This is exactly what rolldown emits for `dist/mqtt.esm.js`, and exactly
    // what the old code crashed on.
    const ns = { default: { connect: fn } };
    expect(resolveMqttConnect(ns)).not.toBeNull();
    expect((ns as { connect?: unknown }).connect).toBeUndefined();
  });

  it('takes a callable `default` itself as the last resort', () => {
    expect(resolveMqttConnect({ default: fn })).not.toBeNull();
  });

  it('returns null — never a non-callable — when no shape matches', () => {
    expect(resolveMqttConnect({})).toBeNull();
    expect(resolveMqttConnect({ connect: 1, default: { connect: 'no' } })).toBeNull();
    expect(resolveMqttConnect(null)).toBeNull();
    expect(resolveMqttConnect(undefined)).toBeNull();
  });

  it('describes an unusable module without throwing', () => {
    expect(describeMqttModule({ default: { nope: 1 } })).toBe(
      'module=object connect=undefined default=object default.connect=undefined keys=[default]',
    );
    expect(describeMqttModule(null)).toBe(
      'module=null connect=undefined default=undefined default.connect=undefined keys=[]',
    );
  });
});
