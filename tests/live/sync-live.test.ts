/**
 * The OPT-IN live smoke test. Never runs in PR CI.
 *
 * `tests/e2e/sync-remote.spec.ts` proves everything that is a claim about
 * *kraken-hub*: the envelope we build, the key we derive, the dedup we perform,
 * the failover we execute. Those run against the in-repo broker simulator and
 * are hermetic.
 *
 * This file makes the two claims that are about *the outside world* — that
 * `broker.emqx.io` really does honour a retained message, and that `ntfy.sh`
 * really does replay one from its cache — and it needs the public internet to
 * do it. A failure here is information about somebody else's uptime rather than
 * a regression in this repo, and making every pull request depend on that would
 * train the whole project to ignore a red build.
 *
 *     npm run test:live            # KRAKEN_HUB_LIVE=1
 *
 * It uses a fresh random room every run, so two people running it at once never
 * collide, and it CLEANS UP after itself: a zero-length retained publish is how
 * MQTT deletes a retained message, and leaving one on a public broker forever
 * would be rude.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { deriveRoomKeys } from '../../src/sync/crypto';
import { generateRoomCode } from '../../src/sync/roomCode';
import { createSyncService } from '../../src/sync/SyncService';
import { createMqttTransport } from '../../src/sync/transports/MqttTransport';

import type { SyncSettings } from '../../src/state/schema';
import type { SyncStateBody } from '../../src/sync/types';

const LIVE = process.env['KRAKEN_HUB_LIVE'] === '1';

/**
 * Node 20 has no global `EventSource`, and the transport opens one after the
 * replay poll. The claim under test is the REPLAY (a plain `fetch`), so a
 * no-op stand-in is honest here: it is not standing in for anything the
 * assertions look at.
 */
if (LIVE && typeof (globalThis as { EventSource?: unknown }).EventSource === 'undefined') {
  (globalThis as { EventSource?: unknown }).EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: MessageEvent<string>) => void) | null = null;
    close(): void {
      /* nothing to close */
    }
  };
}

const BASE: SyncSettings = {
  enabled: true,
  roomCode: null,
  transport: 'mqtt',
  mqttUrl: '',
  ntfyBase: '',
  persistRemote: false,
  publishTelemetry: false,
};

function snapshot(id: string): SyncStateBody {
  return {
    activeModuleId: 'video',
    modules: { video: { v: 1, cfg: { url: `https://example.invalid/${id}.mp4` } } },
    playback: null,
    render: {
      fit: 'cover',
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      rotate: 0,
      safeAreaPct: 0.08,
      safeRadiusPct: 0.88,
      maskCircle: 'auto',
      background: '#000000',
    },
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Rooms this run created, so `afterAll` can wipe their retained slots. */
const usedRooms: string[] = [];

/** A zero-length retained publish is how MQTT deletes a retained message. */
async function clearRetained(room: string): Promise<void> {
  const keys = await deriveRoomKeys(room);
  const transport = createMqttTransport();
  const controller = new AbortController();
  try {
    await transport.connect({
      topicId: keys.topicId,
      clientId: `cleanup${Math.random().toString(36).slice(2, 8)}`,
      role: 'config',
      mqttUrl: '',
      ntfyBase: '',
      signal: controller.signal,
    });
    await transport.publishState(new Uint8Array());
    // The verified caveat: publishing a retained message and closing quickly
    // loses it. The same race applies to the deletion.
    await delay(1500);
  } finally {
    await transport.disconnect();
  }
}

afterAll(async () => {
  for (const room of usedRooms) {
    await clearRetained(room).catch(() => undefined);
  }
}, 60_000);

describe.skipIf(!LIVE)('live sync smoke', () => {
  it('EMQX carries an encrypted retained snapshot to a cold peer', async () => {
    const room = generateRoomCode();
    usedRooms.push(room);
    const settings: SyncSettings = { ...BASE, roomCode: room, transport: 'mqtt' };

    const writer = createSyncService({
      role: 'remote',
      clientId: `w${Math.random().toString(36).slice(2, 13)}`,
      settings,
      withLocal: false,
    });
    await writer.start();
    expect(writer.status().network).toBe('online');

    writer.publishState(snapshot('retained'), { rev: 7, immediate: true });
    // Settle before closing: research-providersAndSync.md verified that a
    // publish-then-immediate-close silently loses the retained message.
    await delay(2000);
    await writer.stop();

    // A genuinely cold peer: a different client id, a fresh connection, and
    // no knowledge of anything but the room code.
    const reader = createSyncService({
      role: 'display',
      clientId: `r${Math.random().toString(36).slice(2, 13)}`,
      settings,
      withLocal: false,
    });
    const retained: SyncStateBody[] = [];
    reader.onState((body, meta) => {
      if (meta.retained) retained.push(body);
    });
    await reader.start();
    await delay(3000);
    await reader.stop();

    expect(retained.length).toBeGreaterThan(0);
    expect(retained[0]?.modules['video']).toEqual({
      v: 1,
      cfg: { url: 'https://example.invalid/retained.mp4' },
    });
  }, 60_000);

  it('ntfy replays a published snapshot to a cold peer', async () => {
    const room = generateRoomCode();
    const settings: SyncSettings = { ...BASE, roomCode: room, transport: 'ntfy' };

    const writer = createSyncService({
      role: 'remote',
      clientId: `w${Math.random().toString(36).slice(2, 13)}`,
      settings,
      withLocal: false,
    });
    await writer.start();
    writer.publishState(snapshot('replayed'), { rev: 3, immediate: true });
    await delay(2000);
    await writer.stop();

    const reader = createSyncService({
      role: 'display',
      clientId: `r${Math.random().toString(36).slice(2, 13)}`,
      settings,
      withLocal: false,
    });
    const seen: SyncStateBody[] = [];
    reader.onState((body) => {
      seen.push(body);
    });
    await reader.start();
    await delay(2000);
    await reader.stop();

    // ntfy has no retention; this arrives from the /json?poll=1&since=10m
    // replay cache, which is the whole reason it is a usable fallback.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.modules['video']).toEqual({
      v: 1,
      cfg: { url: 'https://example.invalid/replayed.mp4' },
    });
    // Nothing to clean up: ntfy messages expire on their own after 12 h.
  }, 60_000);
});
