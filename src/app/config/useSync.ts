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

import { useCallback, useEffect, useRef, useState } from 'react';

import { createDiagAssembler } from '../../diag/wire';
import { clientId } from '../../platform/env';
import { stateToSyncBody } from '../../sync/appSync';

import type { ConfigRuntime } from './runtime';
import type { DiagReport } from '../../diag/report';
import type { AppState } from '../../state/schema';
import type { AppSync } from '../../sync/appSync';
import type { CmdOp, RecvMeta, SyncStatus } from '../../sync/types';

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

export interface SyncHandle {
  status: SyncStatus | null;
  /** The most recent packet of any kind. */
  lastTele: TeleSample | null;
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
  topicId: string | null;
  sendCmd: (op: CmdOp, arg?: unknown) => void;
  /** Publish a snapshot immediately, bypassing the 5 Hz coalescing window. */
  publishNow: (state: AppState) => void;
}

export function useSync(runtime: ConfigRuntime): SyncHandle {
  const state = runtime.store.getSnapshot();
  const room = state.sync.enabled ? state.sync.roomCode : null;
  const transport = state.sync.transport;
  const mqttUrl = state.sync.mqttUrl;
  const ntfyBase = state.sync.ntfyBase;

  const syncRef = useRef<AppSync | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [lastTele, setLastTele] = useState<TeleSample | null>(null);
  const [lastStats, setLastStats] = useState<TeleSample | null>(null);
  const [library, setLibrary] = useState<TeleSample | null>(null);
  const [lastError, setLastError] = useState<TeleSample | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);
  const [diagReport, setDiagReport] = useState<{ report: DiagReport; at: number } | null>(null);

  /**
   * One assembler for the life of the hook, not one per connection.
   *
   * A report is chunked across several `tele` messages, and a transport
   * failover between two of them must not lose the parts already collected: the
   * buffer belongs to the conversation, not to the socket carrying it.
   */
  const diagAssembler = useRef(createDiagAssembler());

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
       * The persisted layer, read NOW rather than at boot.
       *
       * `appSync` re-resolves `persisted < remote < url` on every remote state
       * frame and `replace()`s the snapshot with the result, so whatever it is
       * handed here is the floor under this whole session. `runtime.persisted`
       * is the document as it looked when the page booted, which silently
       * discards anything committed since — and `sync.*` is exactly the family
       * of settings that never travels on the wire, so nothing puts it back.
       *
       * Measured, not feared: the phone remote auto-joins from the pairing link
       * by committing `sync.roomCode`, and the first state frame the display
       * sent re-resolved against a boot-time document with no room in it,
       * unpairing the phone about a second after it connected.
       */
      const persisted = readState().state;
      const handle = await startAppSync({
        role: runtime.role,
        clientId: clientId(),
        store: runtime.store,
        persisted,
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
          setLastTele(sample);
          if (typeof sample.body['stats'] === 'object' && sample.body['stats'] !== null) {
            setLastStats(sample);
          }
          if (sample.body['kind'] === 'library') setLibrary(sample);
          if (sample.body['severity'] === 'error') setLastError(sample);
          // Returns non-null only on the part that completes a report, so this
          // is a no-op for every other packet on the channel.
          const report = diagAssembler.current.accept(sample.body);
          if (report !== null) setDiagReport({ report, at: sample.at });
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

  // Every local edit is a full snapshot on the wire. `SyncService` coalesces at
  // 5 Hz, so dragging a slider produces four or five messages a second, not one
  // per pixel.
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
  return {
    status: live ? status : null,
    lastTele: live ? lastTele : null,
    lastStats: live ? lastStats : null,
    library: live ? library : null,
    lastError: live ? lastError : null,
    diagReport: live ? diagReport : null,
    topicId: live ? topicId : null,
    sendCmd,
    publishNow,
  };
}
