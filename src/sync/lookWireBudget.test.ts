/**
 * §6.2: the worst legal document has to fit one 8 kB envelope.
 *
 * The look is the one thing the trim ladder is NEVER allowed to touch — a look
 * with a layer missing is not a smaller look, it is a different arrangement, and
 * half of somebody's panel silently disappearing is a worse failure than a
 * refused publish. So the budget has to be proved rather than hoped for: this
 * builds the largest document the validator will accept (eight layers at the
 * look byte cap, a full four-kind module bank, playback, render and a full
 * stamp map) and asserts that `fitStateEnvelope` finds a fitting frame with the
 * layers still whole.
 */

import { describe, expect, it } from 'vitest';

import { defaultAppState } from '../state/defaults';
import { MAX_LAYERS, MAX_LOOK_BYTES, lookBytes } from '../state/look/types';
import { validateAppState } from '../state/validate';

import { stateToSyncBody } from './appSync';
import { encodeEnvelope, envelopeBytes } from './envelope';
import { createSyncService } from './SyncService';
import {
  MAX_ENVELOPE_BYTES,
  PROTOCOL_VERSION,
  type Envelope,
  type SyncStateBody,
  type SyncTransport,
} from './types';

import type { StampTuple } from './hlc';
import type { Layer } from '../state/look/types';
import type { AppState, ModuleSlot } from '../state/schema';

/** A layer with the biggest config the kinds in §6.2 carry (effect ≈ 160 B). */
function fatOverlay(index: number): Layer {
  return {
    id: `layer${String(index).padStart(3, '0')}`,
    kind: 'effect',
    on: true,
    name: 'A layer name of the maximum'.slice(0, 24),
    frame: { w: 1.25, h: 0.75, shape: 'square' },
    t: { x: 0.321, y: -0.654, s: 1.875, r: 137, a: 0.625 },
    locked: true,
    v: 3,
    cfg: {
      preset: 'aurora',
      speed: 0.875,
      intensity: 0.625,
      palette: ['#112233', '#445566', '#778899', '#aabbcc'],
      blend: 'screen',
      seed: 987_654,
    },
  };
}

/** The biggest bank the design costs out: a video kind plus three others. */
function fatBank(): Record<string, ModuleSlot> {
  return {
    video: {
      v: 5,
      cfg: {
        source: { kind: 'library', id: 'a-fairly-long-library-identifier-0001' },
        url: 'https://example.test/a/reasonably/long/path/to/a/clip/file-name.mp4',
        render: { fit: 'contain-circle', zoom: 1.25, offsetX: 0.1, offsetY: -0.1 },
        loop: { enabled: true, startSec: 12.5, endSec: 145.25 },
        quality: { pin: '1080p', downloadMode: 'stream-only' },
        audioEnabled: false,
        demoWhenEmpty: true,
        poster: 'thumb-0001',
      },
    },
    clock: {
      v: 2,
      cfg: { face: 'analog', showSeconds: true, color: '#ffffff', tz: 'Europe/Oslo' },
    },
    stats: {
      v: 4,
      cfg: { layout: 'dial', metrics: ['cpuTemp', 'gpuTemp', 'cpuLoad', 'gpuLoad'], units: 'c' },
    },
    effect: { v: 3, cfg: { preset: 'aurora', speed: 1, intensity: 0.5, blend: 'screen' } },
  };
}

function worstLegalState(): AppState {
  const base = defaultAppState();
  const layers: Layer[] = [
    { ...base.look.layers[0]!, kind: 'video' },
    ...Array.from({ length: MAX_LAYERS - 1 }, (_, i) => fatOverlay(i)),
  ];
  const { state } = validateAppState({
    ...base,
    activeModuleId: 'video',
    look: { layers },
    modules: fatBank(),
    playback: {
      ownerModuleId: 'video',
      paused: false,
      posSec: 1234.5678,
      posAtTs: 1_700_000_000_000,
      durationSec: 7200,
      rate: 1.25,
      muted: false,
      volume: 0.75,
      loop: { enabled: true, startSec: 10, endSec: 200 },
    },
  });
  return state;
}

/** A full stamp map — every leaf of the worst legal document, uncapped. */
function fullStamps(body: SyncStateBody): { map: Record<string, StampTuple> } {
  const map: Record<string, StampTuple> = {};
  const paths = [
    'activeModuleId',
    'look.order',
    ...(body.look?.layers ?? []).map((l) => `look.layer.${l.id}`),
    ...Object.keys(body.render).map((k) => `render.${k}`),
    'playback',
    'modules.video.cfg.source.id',
    'modules.video.cfg.url',
    'modules.video.cfg.render.fit',
    'modules.video.cfg.quality.pin',
    'modules.stats.cfg.layout',
    'modules.clock.cfg.face',
    'modules.effect.cfg.preset',
  ];
  for (const path of paths) {
    map[path] = [1_700_000_000_000, 9, 'phonepeera01'];
  }
  return { map };
}

/** The transport the service publishes onto, so the fitted frame can be read back. */
function captureTransport(sent: Uint8Array[]): SyncTransport {
  return {
    id: 'fake',
    caps: {
      retained: true,
      replayMs: 0,
      needsNetwork: false,
      maxPayload: 64_000,
      channels: ['state', 'cmd', 'tele'],
      encrypted: false,
    },
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    publishState(frame) {
      sent.push(frame);
      return Promise.resolve();
    },
    publishCmd: () => Promise.resolve(),
    publishTele: () => Promise.resolve(),
    onState: () => () => undefined,
    onCmd: () => () => undefined,
    onTele: () => () => undefined,
    status: () => 'online',
    onStatus: () => () => undefined,
  };
}

describe('the worst legal look on the wire (§6.2)', () => {
  it('is a document the validator actually accepts', () => {
    const state = worstLegalState();
    expect(state.look.layers).toHaveLength(MAX_LAYERS);
    // The document cap is a NOTE rather than a refusal, so this is here to say
    // what "worst legal" means: at or under the cap ops enforce at write time.
    expect(lookBytes(state.look)).toBeLessThanOrEqual(MAX_LOOK_BYTES * 2);
  });

  it('fits one envelope with every layer intact', async () => {
    const state = worstLegalState();
    const body = stateToSyncBody(state);
    const stamps = fullStamps(body);
    const sent: Uint8Array[] = [];
    const service = createSyncService({
      role: 'config',
      clientId: 'configpeer01',
      settings: { ...state.sync, roomCode: 'ABCD1234', transport: 'fake', enabled: true },
      withLocal: false,
      factories: { fake: () => captureTransport(sent) },
      wireStamps: () => ({ ...stamps, clock: [1_700_000_000_000, 9, 'phonepeera01'] }),
    });
    await service.start();
    service.publishState(body, { rev: 12, immediate: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = sent[0];
    expect(frame).toBeDefined();
    expect(frame?.length ?? Infinity).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);

    const env = JSON.parse(
      new TextDecoder().decode(frame ?? new Uint8Array()),
    ) as Envelope<SyncStateBody>;
    // Never truncated, never stripped: the layers are the one thing the ladder
    // may not reach for.
    expect(env.body.look?.layers).toHaveLength(MAX_LAYERS);
    expect(env.body.look?.layers.map((l) => l.id)).toEqual(state.look.layers.map((l) => l.id));
    await service.stop();
  });

  it('rotates the stamp window so every stamped leaf travels within a bounded number of frames', async () => {
    /*
     * The last rung of the ladder, and the reason it rotates.
     *
     * A stamp dropped from a frame whose body still names the leaf is not an
     * omission: the receiver reads the unstamped value as `EPOCH`, so that leaf
     * cannot win an argument it should win. Under a FIXED window that is
     * permanent — the leaf can never climb back. Under a rotating one the loss
     * lasts a frame or two, and the bound is stated rather than hoped for:
     * with `n` stamps and at least one travelling per frame, every stamped leaf
     * carries its stamp within at most `n` frames. In practice this rung never
     * fires at all — the worst legal document plus its whole stamp map is
     * inside the cap, which the test below asserts.
     */
    /*
     * REAL leaves of the body, not invented paths: the rung above this one
     * drops a stamp whose leaf the trimmed body no longer carries, so a stamp
     * map made of names the body never had would be emptied there and this rung
     * would never fire at all.
     */
    const base = defaultAppState();
    const cfg: Record<string, unknown> = {};
    for (let i = 0; i < 300; i += 1) cfg[`k${String(i).padStart(3, '0')}`] = i;
    const body = stateToSyncBody({
      ...base,
      activeModuleId: 'video',
      modules: { ...base.modules, video: { v: 1, cfg } },
    });
    // Far more stamps than 8 kB can hold, so the rung is forced to fire.
    const map: Record<string, StampTuple> = {};
    for (let i = 0; i < 300; i += 1) {
      map[`modules.video.cfg.k${String(i).padStart(3, '0')}`] = [
        1_700_000_000_000 + i,
        9,
        'phonepeera01',
      ];
    }
    const sent: Uint8Array[] = [];
    const service = createSyncService({
      role: 'config',
      clientId: 'configpeer01',
      settings: {
        ...defaultAppState().sync,
        roomCode: 'ABCD1234',
        transport: 'fake',
        enabled: true,
      },
      withLocal: false,
      factories: { fake: () => captureTransport(sent) },
      wireStamps: () => ({ map, clock: [1_700_000_000_000, 9, 'phonepeera01'] }),
    });
    await service.start();

    const seen = new Set<string>();
    let frames = 0;
    const bound = Object.keys(map).length;
    while (seen.size < bound && frames < bound) {
      service.publishState(body, { rev: 12 + frames, immediate: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const frame = sent[sent.length - 1];
      expect(frame).toBeDefined();
      expect(frame?.length ?? Infinity).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
      const env = JSON.parse(
        new TextDecoder().decode(frame ?? new Uint8Array()),
      ) as Envelope<SyncStateBody>;
      for (const path of Object.keys(env.stamps ?? {})) seen.add(path);
      frames += 1;
    }
    expect(seen.size).toBe(bound);
    // The bound is `n` frames; the real number is far smaller, and stating it
    // here is what would catch a rung that quietly stopped rotating.
    expect(frames).toBeLessThan(bound);
    await service.stop();
  });

  it('ships a defaulted leaf WITH its stamp, or not at all', async () => {
    /*
     * Skeptic 1's wire trace, pinned.
     *
     * The ladder used to open by dropping the stamps of every leaf whose value
     * equalled the built-in default, while shipping those values anyway. The
     * safety argument was "a receiver that does not get one keeps whatever it
     * already holds, which for a leaf still sitting on its default is the same
     * value", and its premise is false in exactly the case that matters: the
     * receiver is not holding the default, it is holding the value the ROOM
     * agreed on. `render.fit`'s default is 'cover', so "undo my crop" became
     * unsendable the moment a frame crossed 8 kB — on every frame, forever,
     * because the same stamp was dropped from every frame the sender would ever
     * send while the value stayed defaulted.
     *
     * The rotating rung is allowed to leave a stamp off a frame; it is not
     * allowed to leave it off every frame. So the assertion is over a bounded
     * run of frames, which is precisely the difference between the two.
     */
    const base = defaultAppState();
    const cfg: Record<string, unknown> = {};
    for (let i = 0; i < 150; i += 1) cfg[`knob${String(i).padStart(3, '0')}`] = i;
    const body = stateToSyncBody({
      ...base,
      activeModuleId: 'video',
      modules: { ...base.modules, video: { v: 1, cfg } },
      render: { ...base.render, fit: 'cover' },
    });
    expect(body.render.fit).toBe(defaultAppState().render.fit);

    const map: Record<string, StampTuple> = {
      'render.fit': [1_700_000_099_999, 0, 'phonepeer001'],
    };
    for (let i = 0; i < 150; i += 1)
      map[`modules.video.cfg.knob${String(i).padStart(3, '0')}`] = [
        1_700_000_000_000 + i,
        0,
        'phonepeer001',
      ];

    const sent: Uint8Array[] = [];
    const service = createSyncService({
      role: 'remote',
      clientId: 'phonepeer001',
      settings: {
        ...defaultAppState().sync,
        roomCode: 'ABCD1234',
        transport: 'fake',
        enabled: true,
      },
      withLocal: false,
      factories: { fake: () => captureTransport(sent) },
      wireStamps: () => ({ map, clock: [1_700_000_099_999, 0, 'phonepeer001'] }),
    });
    await service.start();

    let fitStamped = 0;
    for (let i = 0; i < 24; i += 1) {
      service.publishState(body, { rev: 7 + i, immediate: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const frame = sent[sent.length - 1];
      expect(frame?.length ?? Infinity).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
      const env = JSON.parse(
        new TextDecoder().decode(frame ?? new Uint8Array()),
      ) as Envelope<SyncStateBody>;
      expect(env.body.render.fit).toBe('cover');
      // The map does not fit whole, so the trimming rung genuinely fires: this
      // is what makes the test a test rather than a frame that never needed to
      // drop anything.
      expect(Object.keys(env.stamps ?? {}).length).toBeLessThan(Object.keys(map).length);
      if (Object.keys(env.stamps ?? {}).includes('render.fit')) fitStamped += 1;
    }
    expect(fitStamped).toBeGreaterThan(0);
    await service.stop();
  });

  it('leaves headroom before the bank has to be trimmed', () => {
    /*
     * The point of the number, stated as a number: the full document plus a
     * full stamp map is inside the cap WITHOUT reaching the `partial: true`
     * rung, so a room with eight layers still exchanges every module's config.
     */
    const body = stateToSyncBody(worstLegalState());
    const stamps = fullStamps(body);
    const env: Envelope<SyncStateBody> = {
      v: PROTOCOL_VERSION,
      ch: 'state',
      ts: 1_700_000_000_000,
      src: 'configpeer01',
      role: 'config',
      seq: 42,
      rev: 12,
      stamps: stamps.map,
      clock: [1_700_000_000_000, 9, 'phonepeera01'],
      body,
    };
    expect(() => encodeEnvelope(env)).not.toThrow();
    expect(envelopeBytes(env)).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
  });
});
