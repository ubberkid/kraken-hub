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

import { stateToSyncBody, syncBodyToPatch } from './appSync';
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
