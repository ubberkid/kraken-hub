/**
 * The config/remote page's connection to the sync layer.
 *
 * Kept out of `RemoteView.tsx` because a `.tsx` file in this app exports exactly
 * one component (React Fast Refresh, and the ESLint rule that guards it), and
 * because the lifecycle here — start on room change, stop on unmount, publish
 * on every commit — is the sort of thing that is much easier to read when it is
 * not interleaved with markup.
 *
 * Everything is behind a dynamic `import()` of the sync core, so a user who
 * never opens the Remote tab never downloads it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createDiagAssembler } from '../../diag/wire';
import { createChunkAssembler } from '../../lib/chunkedTele';
import { LIBRARY_CHUNK_KIND } from '../../lib/libraryPacket';
import { createLogger } from '../../lib/log';
import { clientId } from '../../platform/env';
import { stateToSyncBody } from '../../sync/appSync';
import { decodeMonitorSnapshot } from '../../sync/monitorSnapshot';

import type { ReplicaDisplayInfo } from './replica';
import type { ConfigRuntime } from './runtime';
import type { DiagReport } from '../../diag/report';
import type { AppState } from '../../state/schema';
import type { AppSync } from '../../sync/appSync';
import type { MonitorSnapshot } from '../../sync/monitorSnapshot';
import type { CmdOp, RecvMeta, SyncStatus } from '../../sync/types';

const log = createLogger('config/sync');

/**
 * The display's 0.5 Hz "here is what I am" packet, decoded.
 *
 * Everything the remote's live ring needs that it cannot work out for itself:
 * which module is on screen, what shape and size the panel is, and the five
 * monitoring readings. Local time is deliberately absent — the phone has a
 * clock, and a clock replica is correct by definition.
 */
export interface MonitorSample {
  module: string | null;
  display: ReplicaDisplayInfo | null;
  snapshot: MonitorSnapshot | null;
  /** The DISPLAY's clock at the sample, which is what the replica anchors on. */
  at: number;
}

/** A reassembled ring thumbnail, cached by content hash so it is sent once. */
export interface RingThumb {
  id: string | null;
  dataUrl: string;
}

/**
 * Telemetry arrives as `unknown` and is written by a peer that may be a
 * different version of this app, or a fork. A geometry that is not four usable
 * numbers is dropped rather than half-read: laying a module out against a
 * partly-parsed panel size is worse than laying it out against the default.
 */
function isDisplayInfo(raw: unknown): raw is ReplicaDisplayInfo {
  if (typeof raw !== 'object' || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o['w'] === 'number' &&
    typeof o['h'] === 'number' &&
    typeof o['shape'] === 'string' &&
    typeof o['targetFps'] === 'number' &&
    o['w'] > 0 &&
    o['h'] > 0
  );
}

/**
 * A tele packet plus when we saw it.
 *
 * Typed as an open record on purpose: `src/sync` deliberately knows nothing
 * about the video module's `TelePacket`, so the shape is only guaranteed to
 * carry `ts` and `kind`, and every reader narrows what it needs.
 */
export interface TeleSample {
  body: Record<string, unknown>;
  meta: RecvMeta;
  at: number;
}

/**
 * Does this packet carry the video module's own view of the world?
 *
 * The `tele` channel is SHARED: the video module publishes `videoStats` every
 * 2 s, the replica feed publishes `monitor` every 2.5 s, the clip index and the
 * chunked diagnostics report and thumbnails all ride the same stream. Only the
 * video packets carry `provider`, `quality` and `levels`.
 *
 * That mattered because the whole quality control was derived from
 * `lastTele` — "the most recent packet of ANY kind" — so a `monitor` packet
 * landing between two `videoStats` packets read as "no provider", which
 * `qualityControlFor(null)` answers with `'none'`, which renders a paragraph
 * where the `<Select>` was. The picker therefore vanished and came back roughly
 * once a second, in lockstep with the telemetry cadence, and every consumer of
 * the same object repainted with it. Latching the video packets separately is
 * the fix: a `monitor` packet now says nothing about the video, because it
 * never knew anything about the video.
 */
export function carriesVideoTelemetry(body: Record<string, unknown>): boolean {
  const kind = body['kind'];
  if (kind === 'videoStats' || kind === 'videoError') return true;
  // Lenient on purpose: a peer on a different build (or a fork) may name its
  // packets differently, and the fields are what the readers actually use.
  return typeof body['provider'] === 'string' || typeof body['stats'] === 'object';
}

/**
 * How often a remote with no shelf re-asks for one.
 *
 * Three seconds: fast enough that a phone opened before the display finished
 * booting fills in while the user is still looking at it, slow enough that a
 * room with nobody home is not a chatty one. Well clear of `SyncService`'s
 * 200 ms per-op command throttle, which DROPS rather than queues.
 */
export const LIBRARY_PULL_RETRY_MS = 3000;

export interface SyncHandle {
  status: SyncStatus | null;
  /**
   * The most recent packet of any kind.
   *
   * Liveness ONLY — "is there a Kraken on the other end, and how long ago did
   * it say so". Never read a video field off this: see `lastVideo`.
   */
  lastTele: TeleSample | null;
  /**
   * The most recent packet that carried VIDEO telemetry — provider, quality,
   * levels, stats.
   *
   * Sticky across the other packet kinds on the shared channel, which is the
   * entire point. See `carriesVideoTelemetry`.
   */
  lastVideo: TeleSample | null;
  /**
   * The most recent packet that actually carried `stats`.
   *
   * Kept apart from `lastTele` because the scrubber re-anchors from
   * `stats.currentTime` + the packet's own `ts`, and a `library` or `videoError`
   * packet arriving in between must not blank the position out — nor, worse,
   * re-anchor it against a timestamp that belongs to a different sample.
   */
  lastStats: TeleSample | null;
  /** The most recent `library` packet — the clip index and download progress. */
  library: TeleSample | null;
  /** The most recent error packet, kept separately so it does not scroll away. */
  lastError: TeleSample | null;
  /**
   * The last hardware report the display sent in answer to `requestDiag`,
   * reassembled from its chunks, with the moment the LAST chunk landed.
   *
   * `at` is load-bearing rather than decorative: the Diagnostics card compares
   * it against the moment the request went out, because a report that predates
   * the request is a stale answer from a previous pull and rendering it as the
   * reply would make a dead display look healthy.
   */
  diagReport: { report: DiagReport; at: number } | null;
  /** The live ring's feed: active module, panel geometry, monitoring readings. */
  monitor: MonitorSample | null;
  /**
   * The picture the display last shipped, reassembled from its chunks.
   *
   * Held across reconnects on purpose: the display sends a thumbnail ONCE per
   * distinct image (it caches by hash and never re-sends an unchanged one), so
   * dropping it on a transport blip would leave the ring blank until the source
   * happened to change.
   */
  ringThumb: RingThumb | null;
  topicId: string | null;
  /**
   * Every `tele` body, as it lands, before React sees any of it.
   *
   * `lastTele` is a rendered SNAPSHOT: React coalesces state updates, so two
   * packets arriving in one tick leave one behind. For a position sample or a
   * frame-rate reading that is exactly right — the newest is the only one that
   * matters. For a HANDSHAKE it is fatal: an answer and a candidate list landing
   * together would lose one of them, and a WebRTC offer that is never answered
   * looks precisely like a network that cannot carry it.
   *
   * So the file-transfer sender subscribes to the raw stream instead. The
   * callback identity is stable for the life of the hook, so a subscriber does
   * not resubscribe on every packet.
   */
  subscribeTele: (cb: (body: Record<string, unknown>) => void) => () => void;
  sendCmd: (op: CmdOp, arg?: unknown) => void;
  /** Publish a snapshot immediately, bypassing the 5 Hz coalescing window. */
  publishNow: (state: AppState) => void;
}

export interface UseSyncOptions {
  /**
   * Whether this call may own the page's ONE sync connection. Defaults to true.
   *
   * `ConfigApp` mounts this hook at the app root so CAM's Home screen — where
   * the module chips, the looks and every setting live — publishes to the room
   * like every other surface does. About, Library and Remote each call it too,
   * and two calls would open two connections to the same topic (see
   * `AboutView`'s note), so the root call stands down whenever the route on
   * screen is one of theirs. Disabled behaves exactly like an unpaired page:
   * nothing starts, nothing is reported, and the sync chunk is never fetched.
   */
  enabled?: boolean;
}

export function useSync(runtime: ConfigRuntime, opts: UseSyncOptions = {}): SyncHandle {
  const enabled = opts.enabled ?? true;
  const state = runtime.store.getSnapshot();
  const room = enabled && state.sync.enabled ? state.sync.roomCode : null;
  const transport = state.sync.transport;
  const mqttUrl = state.sync.mqttUrl;
  const ntfyBase = state.sync.ntfyBase;

  const syncRef = useRef<AppSync | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [lastTele, setLastTele] = useState<TeleSample | null>(null);
  const [lastVideo, setLastVideo] = useState<TeleSample | null>(null);
  const [lastStats, setLastStats] = useState<TeleSample | null>(null);
  const [library, setLibrary] = useState<TeleSample | null>(null);
  const [lastError, setLastError] = useState<TeleSample | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [diagReport, setDiagReport] = useState<{ report: DiagReport; at: number } | null>(null);
  const [monitor, setMonitor] = useState<MonitorSample | null>(null);
  const [ringThumb, setRingThumb] = useState<RingThumb | null>(null);

  /**
   * One assembler for the life of the hook, not one per connection.
   *
   * A report is chunked across several `tele` messages, and a transport
   * failover between two of them must not lose the parts already collected: the
   * buffer belongs to the conversation, not to the socket carrying it.
   */
  const diagAssembler = useRef(createDiagAssembler());
  /**
   * The ring thumbnail's assembler, for the same reason: a 6 KB WebP is one or
   * two chunks, and a failover between them must not lose the first one.
   */
  const thumbAssembler = useRef(createChunkAssembler('thumb'));
  /**
   * The library's assembler, for a shelf too big for one 8 KB envelope.
   *
   * Same reasoning as the other two: the buffer belongs to the conversation, not
   * to the socket carrying it. `library` and `libraryPart` are one conversation
   * with two shapes on the wire — a shelf that fits arrives whole, a shelf that
   * does not arrives in parts — and both land in `library` below, so nothing
   * downstream has a "was it chunked?" branch to get wrong.
   */
  const libraryAssembler = useRef(createChunkAssembler(LIBRARY_CHUNK_KIND));

  /**
   * Raw `tele` listeners — see `SyncHandle.subscribeTele`.
   *
   * A ref rather than state: adding a listener must not render, and the set has
   * to survive the effect re-run that restarts the transport, because a transfer
   * in flight outlives a failover.
   */
  const teleSubs = useRef(new Set<(body: Record<string, unknown>) => void>());
  const subscribeTele = useCallback((cb: (body: Record<string, unknown>) => void) => {
    const subs = teleSubs.current;
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  }, []);

  useEffect(() => {
    // No room means nothing to start; the cleanup of the previous run has
    // already stopped any live handle, and everything this hook reports is
    // gated on `room` at the return below.
    if (room === null) return undefined;
    let disposed = false;
    // Read through a function so TypeScript cannot narrow it across an await —
    // the same trick ModuleHost uses for its teardown flag.
    const isDisposed = (): boolean => disposed;

    void (async () => {
      const { startAppSync } = await import('../../sync/appSync');
      const { readState } = await import('../../state/storage');
      const current = runtime.store.getSnapshot();
      /*
       * The persisted layer, re-read on EVERY re-resolve.
       *
       * `appSync` re-resolves `persisted < remote < url` on every remote state
       * frame and `replace()`s the snapshot with the result, so whatever it
       * reads here is the floor under this whole session. `runtime.persisted`
       * is the document as it looked when the page booted, which silently
       * discards anything committed since.
       *
       * Measured, not feared: the phone remote auto-joins from the pairing link
       * by committing `sync.roomCode`, and the first state frame the display
       * sent re-resolved against a boot-time document with no room in it,
       * unpairing the phone about a second after it connected. Passing a
       * *function* rather than one snapshot is what stops the same trap from
       * being re-armed for every other key — a boot-time read would fix the
       * room and leave the next setting to be discovered the same way.
       */
      const handle = await startAppSync({
        role: runtime.role,
        clientId: clientId(),
        store: runtime.store,
        persisted: () => readState().state,
        url: runtime.url,
        settings: { ...current.sync, roomCode: room, transport, mqttUrl, ntfyBase },
        onStatus: (s) => {
          if (!isDisposed()) setStatus(s);
        },
        onTele: (body, meta) => {
          if (isDisposed()) return;
          const sample: TeleSample = {
            body: body as unknown as Record<string, unknown>,
            meta,
            at: Date.now(),
          };
          // The raw stream first, and outside React's batching: a handshake
          // cannot afford to be coalesced into "the most recent packet".
          for (const cb of teleSubs.current) {
            try {
              cb(sample.body);
            } catch (err) {
              log.warn('a telemetry listener threw', err);
            }
          }
          setLastTele(sample);
          if (carriesVideoTelemetry(sample.body)) setLastVideo(sample);
          if (typeof sample.body['stats'] === 'object' && sample.body['stats'] !== null) {
            setLastStats(sample);
          }
          if (sample.body['kind'] === 'library') setLibrary(sample);
          // Returns non-null only on the part that completes a shelf.
          const shelf = libraryAssembler.current.accept(sample.body);
          if (shelf !== null) {
            try {
              const parsed: unknown = JSON.parse(shelf.payload);
              if (typeof parsed === 'object' && parsed !== null) {
                setLibrary({ ...sample, body: parsed as Record<string, unknown> });
              }
            } catch {
              /* a shelf that does not parse is a dropped packet, not a crash */
            }
          }
          if (sample.body['severity'] === 'error') setLastError(sample);
          // Returns non-null only on the part that completes a report, so this
          // is a no-op for every other packet on the channel.
          const report = diagAssembler.current.accept(sample.body);
          if (report !== null) setDiagReport({ report, at: sample.at });

          if (sample.body['kind'] === 'monitor') {
            const display = sample.body['display'];
            setMonitor({
              module: typeof sample.body['module'] === 'string' ? sample.body['module'] : null,
              display: isDisplayInfo(display) ? display : null,
              // `null` when the packet carried no readings, which is a real
              // state: the stats replica then shows its own "waiting" card.
              snapshot: decodeMonitorSnapshot(sample.body['mon']),
              at: typeof sample.body['ts'] === 'number' ? sample.body['ts'] : sample.at,
            });
          }

          // Returns non-null only on the part that completes a thumbnail.
          const thumb = thumbAssembler.current.accept(sample.body);
          if (thumb !== null) setRingThumb({ id: thumb.id, dataUrl: thumb.payload });
        },
      });
      if (isDisposed()) {
        void handle.stop();
        return;
      }
      syncRef.current = handle;
      setTopicId(handle.service.topicId());
      setStatus(handle.service.status());
      // Announce our current snapshot the moment the channel is usable, so a
      // display that was already listening converges without waiting for the
      // user to touch a control.
      handle.service.publishState(stateToSyncBody(runtime.store.getSnapshot()), {
        rev: runtime.store.getSnapshot().rev,
        immediate: true,
      });
    })();

    return () => {
      disposed = true;
      const handle = syncRef.current;
      syncRef.current = null;
      void handle?.stop();
    };
  }, [room, transport, mqttUrl, ntfyBase, runtime]);

  /*
   * The flush-before-close path.
   *
   * `MqttTransport.disconnect()` deliberately uses `end(false, …)` with a
   * 1.5 s ceiling so the last state change before a reload is not lost — but
   * that code was unreachable on a real tab close, because `stop()` only ran
   * from the effect cleanup below, which a browser tearing the page down never
   * runs. `pagehide` is the listener the spec actually guarantees here
   * (`beforeunload` is skipped for bfcache-eligible pages and is ignored
   * outright on mobile Safari, which is where the remote lives). Its delivery
   * inside CAM's Electron webview is unverified — hardware checklist **H23**.
   *
   * `AppSync.stop()` memoises its promise, so this racing the unmount cleanup
   * is a no-op rather than two competing disconnects.
   */
  useEffect(() => {
    const flush = (): void => {
      void syncRef.current?.stop();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  /*
   * Every local edit is a full snapshot on the wire. `SyncService` coalesces at
   * 5 Hz, so dragging a slider produces four or five messages a second, not one
   * per pixel.
   *
   * Every notification, repeats included, and that is deliberate rather than
   * unexamined. An idempotent gate here — "say nothing if the body matches the
   * last one I sent" — reaches full quiescence and was measured and removed
   * twice, and so were the two other places it can be written. This wire has no
   * acknowledgements: the re-announcement a routine save provokes is the only
   * thing that lands a frame which lost a race, and a phone that taps while its
   * screen is locked recovers that tap by saying it again. See the note in
   * `src/sync/quiescence.dom.test.ts`, which counts what the repetition costs
   * and lists what silencing it cost instead.
   */
  useEffect(
    () =>
      runtime.store.subscribe(() => {
        const next = runtime.store.getSnapshot();
        syncRef.current?.service.publishState(stateToSyncBody(next), { rev: next.rev });
      }),
    [runtime],
  );

  const sendCmd = useCallback((op: CmdOp, arg?: unknown) => {
    syncRef.current?.service.sendCmd(op, arg);
  }, []);

  /*
   * ── The cold pull ────────────────────────────────────────────────────────
   *
   * `tele` publishes UNRETAINED and the display re-announces its library every
   * five minutes, so a phone unlocked at the wrong moment had a genuinely empty
   * shelf for most of five minutes, with nothing on screen to say it was
   * waiting for anything. That is the "no pull, no retain" defect, and it is
   * what made every other library fix untrustworthy: a shelf that is sometimes
   * blank teaches the user it is not the real one.
   *
   * So the moment this page has a live channel and no shelf, it ASKS — and
   * keeps asking on a slow beat until an answer lands, because the request is
   * imperative and unretained too, and a display that was still booting when the
   * first one went out never saw it. `sendCmd` throttles per-op at 200 ms, so
   * the interval is comfortably clear of it; the retry stops dead on the first
   * packet, so a room with no display in it costs one small command every three
   * seconds and nothing else.
   */
  const online = status?.network === 'online' || status?.local === 'online';
  const haveLibrary = library !== null;
  useEffect(() => {
    if (room === null || !online || haveLibrary) return undefined;
    sendCmd('requestLibrary');
    const timer = setInterval(() => {
      sendCmd('requestLibrary');
    }, LIBRARY_PULL_RETRY_MS);
    return () => {
      clearInterval(timer);
    };
  }, [room, online, haveLibrary, sendCmd]);

  const publishNow = useCallback((next: AppState) => {
    syncRef.current?.service.publishState(stateToSyncBody(next), {
      rev: next.rev,
      immediate: true,
    });
  }, []);

  /*
   * Everything is gated on there BEING a room, derived rather than cleared.
   *
   * Stopping the service does not erase what the last one told us, and React
   * state survives the effect re-run that stopped it — so after "Forget this
   * Kraken" the transport was genuinely down while the UI still read
   * `mqtt — online` off a `SyncStatus` belonging to the room the user had just
   * left. A stale "connected" is worse than no reading at all: it is the one
   * thing somebody checks to decide whether the app is broken.
   *
   * Derived at the boundary rather than reset in an effect, because a reset is
   * a second render of state React can already compute from `room`.
   */
  const live = room !== null;
  /*
   * Memoised, and it is not micro-optimisation.
   *
   * A fresh object literal here is a NEW `SyncHandle` on every render, and a
   * telemetry packet renders this hook's owner two or three times a second. Any
   * child given the whole handle as a prop therefore re-rendered on every
   * packet no matter how stable its own inputs were, and `React.memo` on those
   * children was silently useless. That is the "everything repaints" half of
   * the report: the identity changed, so the reconciler had to walk the tree.
   *
   * The dependency list is every field, so the identity still changes the
   * instant any of them actually does — this makes the object honest about
   * change, it does not make it stale.
   */
  return useMemo(
    () => ({
      status: live ? status : null,
      lastTele: live ? lastTele : null,
      lastVideo: live ? lastVideo : null,
      lastStats: live ? lastStats : null,
      library: live ? library : null,
      lastError: live ? lastError : null,
      diagReport: live ? diagReport : null,
      monitor: live ? monitor : null,
      ringThumb: live ? ringThumb : null,
      topicId: live ? topicId : null,
      subscribeTele,
      sendCmd,
      publishNow,
    }),
    [
      live,
      status,
      lastTele,
      lastVideo,
      lastStats,
      library,
      lastError,
      diagReport,
      monitor,
      ringThumb,
      topicId,
      subscribeTele,
      sendCmd,
      publishNow,
    ],
  );
}
