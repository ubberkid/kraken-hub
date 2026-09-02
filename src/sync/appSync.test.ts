/**
 * The state body's round trip — with the field that used to be dead on arrival.
 *
 * `playback` is the only part of `SyncStateBody` that is not plain
 * configuration: it is a `posSec + posAtTs` sample, and the display's
 * cold-restore resume is built on it surviving a full encode → wire → decode →
 * precedence-patch trip with its timestamp intact. A regression here would be
 * silent — the display would simply start at zero — which is exactly the kind
 * of thing that went unnoticed before.
 */

import { describe, expect, it } from 'vitest';

import { defaultAppState } from '../state/defaults';
import { validateAppState } from '../state/validate';

import { enumerateLeaves, stateToSyncBody, syncBodyToPatch } from './appSync';
import { decodeEnvelope, encodeEnvelope } from './envelope';
import { anchorPosition } from './position';
import { PROTOCOL_VERSION, type Envelope, type SyncStateBody } from './types';

import type { AppState, PlaybackState } from '../state/schema';

const NOW = 1_700_000_000_000;

const PLAYBACK: PlaybackState = {
  ownerModuleId: 'video',
  paused: false,
  posSec: 42.5,
  posAtTs: NOW,
  durationSec: 300,
  rate: 1,
  muted: true,
  volume: 1,
  loop: { enabled: false, startSec: 0, endSec: null },
};

function stateWithPlayback(): AppState {
  return { ...defaultAppState(), playback: PLAYBACK };
}

function roundTrip(body: SyncStateBody): SyncStateBody {
  const env: Envelope<SyncStateBody> = {
    v: PROTOCOL_VERSION,
    ch: 'state',
    ts: NOW,
    src: 'test-client1',
    role: 'remote',
    seq: 1,
    rev: 7,
    body,
  };
  const decoded = decodeEnvelope(encodeEnvelope(env));
  expect(decoded).not.toBeNull();
  return decoded?.body as SyncStateBody;
}

describe('playback on the wire', () => {
  it('survives a full envelope round trip with its timestamp intact', () => {
    const body = roundTrip(stateToSyncBody(stateWithPlayback()));

    expect(body.playback).not.toBeNull();
    expect(body.playback).toEqual(PLAYBACK);
    // The pair, specifically: a bare `posSec` would be unusable on a machine
    // that does not share this one's clock.
    expect(body.playback?.posSec).toBe(42.5);
    expect(body.playback?.posAtTs).toBe(NOW);
  });

  it('reaches the precedence layer as a patch, not as a dropped field', () => {
    const patch = syncBodyToPatch(roundTrip(stateToSyncBody(stateWithPlayback())));
    expect(patch.playback).toEqual(PLAYBACK);
  });

  it('re-anchors to a usable position after the trip', () => {
    const body = roundTrip(stateToSyncBody(stateWithPlayback()));
    const p = body.playback;
    expect(p).not.toBeNull();
    const anchored = anchorPosition(
      { posSec: p?.posSec ?? 0, posAtTs: p?.posAtTs ?? 0, paused: p?.paused ?? false },
      NOW + 4000,
      p?.durationSec ?? null,
    );
    expect(anchored.posSec).toBeCloseTo(46.5);
    expect(anchored.stale).toBe(false);
  });

  it('survives the state validator, which a retained snapshot goes through', () => {
    // A cold display parses the persisted document with `validateState`; a
    // playback block that did not survive validation would be indistinguishable
    // from one that never arrived.
    const validated = validateAppState(JSON.parse(JSON.stringify(stateWithPlayback())) as unknown);
    expect(validated.state.playback).toEqual(PLAYBACK);
  });

  it('still carries an absent playback as null rather than dropping the key', () => {
    const body = roundTrip(stateToSyncBody(defaultAppState()));
    expect(body.playback).toBeNull();
    expect('playback' in body).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The look, on the wire
// ---------------------------------------------------------------------------

describe('the look on the wire (§6.1)', () => {
  it('carries the arrangement, not just the base kind', () => {
    const overlay = {
      id: 'labcdefg',
      kind: 'clock',
      on: true,
      frame: { w: 1, h: 1, shape: 'square' as const },
      t: { x: 0.2, y: -0.3, s: 1, r: 0, a: 1 },
      cfg: { face: 'analog' },
    };
    const state: AppState = {
      ...defaultAppState(),
      activeModuleId: 'video',
      look: { layers: [{ ...defaultAppState().look.layers[0] }, overlay] } as AppState['look'],
    };
    const body = roundTrip(stateToSyncBody(state));
    expect(body.look?.layers).toHaveLength(2);
    expect(body.look?.layers[1]).toEqual(overlay);
  });

  it('writes the base kind into the base layer, so the two cannot disagree', () => {
    const state = { ...defaultAppState(), activeModuleId: 'stats' };
    const body = roundTrip(stateToSyncBody(state));
    expect(body.activeModuleId).toBe('stats');
    expect(body.look?.layers[0]?.kind).toBe('stats');
  });

  it('projects a body with no look at all through baseLook', () => {
    const legacy: SyncStateBody = {
      activeModuleId: 'clock',
      modules: {},
      playback: null,
      render: defaultAppState().render,
    };
    const patch = syncBodyToPatch(legacy);
    expect(patch.look?.layers).toHaveLength(1);
    expect(patch.look?.layers?.[0]?.kind).toBe('clock');
    expect(patch.look?.layers?.[0]?.frame).toBe('panel');
  });
});

// ---------------------------------------------------------------------------
// The leaf enumeration — the one definition of a merge unit
// ---------------------------------------------------------------------------

/**
 * `src/sync/leaves.ts` says what a leaf is, and this pins it.
 *
 * It used to be answered in three places that disagreed, which is how a leaf
 * could be claimed under one name and arbitrated under another. One function,
 * one test.
 */
describe('enumerateLeaves', () => {
  it('carves render per key and playback whole', () => {
    const leaves = enumerateLeaves(stateToSyncBody(stateWithPlayback()));
    expect(leaves.get('render.fit')).toBe(defaultAppState().render.fit);
    expect(leaves.get('render.rotate')).toBe(0);
    // Atomic: `posSec` and `posAtTs` are only meaningful together.
    expect(leaves.get('playback')).toEqual(PLAYBACK);
    expect(leaves.has('playback.posSec')).toBe(false);
  });

  it('reaches inside a module config rather than treating the slot as one leaf', () => {
    const leaves = enumerateLeaves(
      stateToSyncBody({
        ...defaultAppState(),
        modules: { video: { v: 1, cfg: { render: { fit: 'contain' }, url: 'x' } } },
      }),
    );
    expect(leaves.get('modules.video.cfg.render.fit')).toBe('contain');
    expect(leaves.get('modules.video.cfg.url')).toBe('x');
    expect(leaves.get('modules.video.v')).toBe(1);
  });

  it('gives every layer its own leaf and the z-order one of its own', () => {
    const base = defaultAppState().look.layers[0];
    const overlay = {
      id: 'labcdefg',
      kind: 'clock',
      on: true,
      frame: { w: 1, h: 1, shape: 'square' as const },
      t: { x: 0, y: 0, s: 1, r: 0, a: 1 },
      cfg: {},
    };
    const state = {
      ...defaultAppState(),
      look: { layers: [base, overlay] } as AppState['look'],
    };
    const leaves = enumerateLeaves(stateToSyncBody(state));
    expect(leaves.get('look.order')).toEqual(['base', 'labcdefg']);
    expect(leaves.get('look.layer.labcdefg')).toEqual(overlay);
    expect(leaves.has('look.layer.base')).toBe(true);
  });

  it('treats the base kind and activeModuleId as ONE leaf', () => {
    const leaves = enumerateLeaves(
      stateToSyncBody({ ...defaultAppState(), activeModuleId: 'clock' }),
    );
    expect(leaves.get('activeModuleId')).toBe('clock');
    // The base layer leaf carries it too, but only as a mirror written from the
    // same value — there is no second merge unit that could disagree.
    const base = leaves.get('look.layer.base') as { kind: string };
    expect(base.kind).toBe('clock');
  });
});
