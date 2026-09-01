/**
 * The display's half of the sync layer.
 *
 * Loaded lazily, and ONLY when a room is actually configured — everything it
 * touches (the sync core, mqtt.js, the clip index, the telemetry mirror) is
 * behind a dynamic import, so a display with no room downloads none of it.
 *
 * Role rules from design-architecture.md §5.5, which is what prevents a
 * three-way feedback loop:
 *
 *   display  publishes `tele`            subscribes `state`, `cmd`
 *   config   publishes `state`, `cmd`    subscribes `state`, `tele`
 *   remote   publishes `state`, `cmd`    subscribes `state`, `tele`
 *
 * The display NEVER publishes state. When it persists remote state (the
 * `persistRemote` default), that write goes only to localStorage — which
 * reaches the CAM Configuration Browser over the shared origin anyway, so all
 * three surfaces converge without anyone echoing state back onto the network.
 */

import { createLogger } from '../../lib/log';
import { clientId } from '../../platform/env';
import { anchorPosition } from '../../sync/position';

import type { DisplayRuntime } from './runtime';
import type { AppState, DeepPartial, PlaybackState } from '../../state/schema';
import type { CmdBody } from '../../sync/types';

const log = createLogger('display/sync');

/** The clip index and download progress are re-announced this often. */
export const LIBRARY_REPUBLISH_MS = 300_000;

/**
 * How long an arriving `playback` waits for a module to exist.
 *
 * A retained snapshot is delivered the instant the transport connects, which on
 * a cold boot is routinely *before* `ModuleHost` has finished its dynamic
 * import — so `runtime.onCommand.current` is still `null` and a seek issued
 * then would simply vanish. Commands are dropped when no module is mounted for
 * good reason (replaying a seek at mount is a bug), but this is not a replay:
 * it is the FIRST delivery of a position the display has never applied, and it
 * carries its own timestamp, so re-anchoring on each attempt keeps it honest.
 */
export const PLAYBACK_RETRY_MS = 250;
export const PLAYBACK_RETRY_LIMIT = 60;

/** Debounce for library changes, so a download's progress ticks do not flood. */
const LIBRARY_DEBOUNCE_MS = 1000;

/**
 * Guard on the diagnostics pull.
 *
 * A double tap on the phone, or a command redelivered by two transports at
 * once, must not start two five-second probe runs on one channel. One in-flight
 * run at a time; the extra request is dropped, not queued.
 *
 * `diagRunning` covers the probe run itself, not the chunk-timer tail: the
 * parts are spaced 250 ms apart, so a report of more than eight parts is still
 * publishing when this 2 s floor expires and a fresh request can begin. That
 * interleave is HARMLESS, not impossible — the receiver keys its buffer on the
 * capture timestamp, so the newer capture discards the older one's stragglers
 * and reassembles cleanly. Nothing here needs to prevent it; the guard exists
 * to stop two concurrent five-second probe runs, and it does.
 */
const DIAG_MIN_INTERVAL_MS = 2000;

export interface DisplaySyncOptions {
  runtime: DisplayRuntime;
  state: AppState;
  /**
   * The persisted layer, as a getter.
   *
   * Re-read on every re-resolve rather than captured at boot: the display
   * persists remote state to localStorage, and the CAM configuration window
   * writes to the same document, so a layer frozen at start-up would let a
   * stale remote echo roll back anything either of them changed since.
   */
  persisted: () => DeepPartial<AppState>;
  url: DeepPartial<AppState>;
}

export interface DisplaySyncHandle {
  stop(): Promise<void>;
}

/**
 * A machine-readable mirror of what sync has actually applied, on
 * `<html data-kh-sync="…">`.
 *
 * It exists because you cannot read text off a 640 px round LCD and you cannot
 * copy anything off it either — the same reason `#/diag` publishes its report
 * through localStorage. The e2e suite asserts against it, the debug overlay
 * renders it, and a user with CAM's devtools open can see in one line which
 * transport won and which revision is live.
 */
const readout: Record<string, unknown> = {};

function writeReadout(fields: Record<string, unknown>): void {
  // Merged, not replaced: the status callback and the state callback each know
  // half of the picture, and a status change must not erase the record of what
  // was last applied.
  Object.assign(readout, fields);
  try {
    document.documentElement.dataset['khSync'] = JSON.stringify(readout);
  } catch {
    /* a readout that cannot be written must never break playback */
  }
}

/** The active module's loop span, if it has one. Readout only. */
function loopOf(state: AppState): { start: number; end: number | null } | null {
  const slot = state.modules[state.activeModuleId];
  const cfg = slot?.cfg;
  if (typeof cfg !== 'object' || cfg === null) return null;
  const loop = (cfg as Record<string, unknown>)['loop'];
  if (typeof loop !== 'object' || loop === null) return null;
  const o = loop as Record<string, unknown>;
  const start = typeof o['start'] === 'number' ? o['start'] : 0;
  const end = typeof o['end'] === 'number' ? o['end'] : null;
  return { start, end };
}

export async function startDisplaySync(o: DisplaySyncOptions): Promise<DisplaySyncHandle> {
  const { runtime } = o;
  const { startAppSync } = await import('../../sync/appSync');

  let stopTele: (() => void) | null = null;
  let stopDownloads: (() => void) | null = null;
  let stopReplica: (() => void) | null = null;
  let libraryTimer: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let seekTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The applied-marker: the `posAtTs` of the last seek this page acted on.
   *
   * The retained snapshot is re-delivered on every reconnect and re-published
   * by the 5-minute keepalive, and the display persists remote state to
   * localStorage — from where the config browser echoes it back. Every one of
   * those carries the SAME `posAtTs`, and every one of them would otherwise
   * yank playback back to a seek the user made ten minutes ago. Deduping on the
   * sample's own timestamp is what makes "apply it once" true. It is cleared on
   * `stop()`, so a sync layer that is restarted applies the current position
   * again rather than assuming the display never moved.
   */
  let appliedPosAtTs: number | null = null;

  function applyPlayback(p: PlaybackState): void {
    // Monotonic, not merely different. Two seeks half a second apart produce two
    // snapshots, and the state channel is coalesced and retried while the `cmd`
    // channel is not — so the older snapshot can genuinely land last. Comparing
    // the samples' own timestamps (both stamped by the same peer, so no clock
    // skew is involved) is what stops a late arrival from undoing a newer seek.
    if (appliedPosAtTs !== null && p.posAtTs <= appliedPosAtTs) return;
    if (seekTimer !== null) clearTimeout(seekTimer);

    const deliver = (attempt: number): void => {
      seekTimer = null;
      const command = runtime.onCommand.current;
      if (command === null) {
        if (attempt >= PLAYBACK_RETRY_LIMIT) return;
        seekTimer = setTimeout(() => {
          deliver(attempt + 1);
        }, PLAYBACK_RETRY_MS);
        return;
      }
      // Marked applied even when the sample is too old to act on: a stale
      // position does not become fresh by being retried, and re-examining it on
      // every keepalive would be pure noise.
      appliedPosAtTs = p.posAtTs;
      const anchored = anchorPosition(
        { posSec: p.posSec, posAtTs: p.posAtTs, paused: p.paused, rate: p.rate },
        Date.now(),
        p.durationSec,
      );
      if (anchored.stale) {
        log.warn(`ignoring a playback position ${String(Math.round(anchored.staleSec))}s old`);
        return;
      }
      writeReadout({ pos: Number(anchored.posSec.toFixed(1)), posAtTs: p.posAtTs });
      command('seekTo', anchored.posSec);
    };

    deliver(0);
  }

  /*
   * ── The remote diagnostics pull ──────────────────────────────────────────
   *
   * The localStorage hand-off in `src/diag/report.ts` gets a report off the LCD
   * and no further: CAM's two browsers share a storage partition, and a laptop
   * on the other side of the room shares nothing at all. Somebody running CAM on
   * a Windows PC and working on a Mac cannot read the JSON by any means the app
   * offered before this.
   *
   * So the display answers `requestDiag` on the wire. Three things make that
   * safe and honest:
   *
   *  - **It is a seam, not a feature.** Everything below the dynamic `import()`
   *    is in the diag chunk, exactly like `DiagOverlay`. The LCD's critical path
   *    does not grow by a byte, and `npm run size` proves it on every build.
   *  - **`?diag=1` is NOT required.** That is the entire point: nobody can edit
   *    a URL on a hidden Kraken Browser window from another machine. A display
   *    booted normally answers.
   *  - **Only a peer holding the room key can ask.** The command arrived
   *    decrypted, which means it came from inside the room.
   */
  let publishTele: ((body: { ts: number; kind: string }) => void) | null = null;
  let diagRunning = false;
  let lastDiagAt = 0;
  const diagTimers = new Set<ReturnType<typeof setTimeout>>();

  async function publishDiagReport(): Promise<void> {
    const publish = publishTele;
    if (publish === null || diagRunning) return;
    if (lastDiagAt !== 0 && Date.now() - lastDiagAt < DIAG_MIN_INTERVAL_MS) return;
    diagRunning = true;
    try {
      const [collect, wire] = await Promise.all([
        import('../../diag/collect'),
        import('../../diag/wire'),
      ]);
      const stats = runtime.frameClock.stats();
      const report = await collect.collectQuickReport({
        geometry: runtime.geometry.get(),
        achievedFps: stats.achievedFps,
        longFrames: stats.longFrames,
      });
      lastDiagAt = Date.now();
      const chunks = wire.toDiagChunks(report);
      writeReadout({ diag: chunks.length });
      chunks.forEach((chunk, index) => {
        // `publishTele` throttles at 5 Hz and DROPS what lands inside the
        // window, so parts have to be spaced rather than looped out.
        if (index === 0) {
          publish(chunk);
          return;
        }
        const timer = setTimeout(() => {
          diagTimers.delete(timer);
          publish(chunk);
        }, index * wire.DIAG_CHUNK_SPACING_MS);
        diagTimers.add(timer);
      });
    } catch (err) {
      log.warn('could not answer a diagnostics request', err);
    } finally {
      diagRunning = false;
    }
  }

  const handle = await startAppSync({
    role: 'display',
    clientId: clientId(),
    store: runtime.store,
    persisted: () => o.persisted(),
    url: o.url,
    settings: o.state.sync,

    onRemoteState: (next, meta) => {
      writeReadout({
        t: meta.via,
        rev: meta.rev,
        retained: meta.retained,
        module: next.activeModuleId,
        loop: loopOf(next),
        bg: next.render.background,
      });
      if (next.playback !== null) applyPlayback(next.playback);
    },

    onCmd: (body: CmdBody) => {
      switch (body.op) {
        case 'reinit':
        case 'reload':
          // NOT a page load: the Kraken Browser never follows a navigation
          // (invariant 2), so "reload" means "re-initialise the renderer".
          runtime.onReinit.current?.('manual');
          break;
        case 'requestDiag':
          void publishDiagReport();
          break;
        case 'identify':
        case 'ping':
          // Answered on the tele channel by the next telemetry packet; there is
          // nothing visible to do on a panel nobody is looking at.
          break;
        default:
          runtime.onCommand.current?.(body.op, body.arg);
          break;
      }
    },

    onStatus: (status) => {
      writeReadout({
        t: status.networkTransport,
        net: status.network,
        local: status.local,
        failedOver: status.failedOver,
        err: status.lastError,
      });
    },
  });

  const { service } = handle;

  /*
   * Wired unconditionally, unlike the telemetry sink below.
   *
   * `publishTelemetry` governs the CONTINUOUS stream a display volunteers —
   * position, frame rate, the clip index — and turning it off is a privacy
   * choice about being watched. A diagnostics report is the opposite: it exists
   * only because a person in the room just asked for it, once, by pressing a
   * button. Gating the answer on the passive toggle would make the button
   * silently do nothing, which is the failure mode this whole feature exists to
   * remove.
   */
  publishTele = (body) => {
    service.publishTele(body);
  };

  if (o.state.sync.publishTelemetry) {
    // ── The M1 seam, now connected. `videoTelemetry` keeps its local emitter
    // and its localStorage mirror; this only adds the encrypted third sink.
    try {
      const tele = await import('../../modules/video/telemetry/videoTelemetry');
      stopTele = tele.registerTeleSink((packet) => {
        service.publishTele(packet);
      });
    } catch (err) {
      log.warn('could not attach the telemetry sink', err);
    }

    /**
     * The clip library and download progress, published as telemetry.
     *
     * They go on `tele` rather than `state` for a reason: they are FACTS ABOUT
     * THIS MACHINE, not desired configuration. The clip library lives in the
     * CAM browser profile's IndexedDB and a phone can never write to it — the
     * remote can only pick from what is announced here, which is exactly why
     * the remote UI explains that local clips live in CAM.
     *
     * Capped at 40 entries with no thumbnails, because the whole envelope has
     * to fit in 8 KB.
     */
    const publishLibrary = (): void => {
      void (async () => {
        try {
          const [clips, downloads] = await Promise.all([
            import('../../modules/video/local/clipStore'),
            import('../../modules/video/local/downloadManager'),
          ]);
          service.publishTele({
            ts: Date.now(),
            kind: 'library',
            clips: clips.readClipIndex(),
            downloads: downloads.listDownloads(),
          } as unknown as { ts: number; kind: string });
        } catch (err) {
          log.warn('could not publish the clip library', err);
        }
      })();
    };

    const schedule = (): void => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(publishLibrary, LIBRARY_DEBOUNCE_MS);
    };

    try {
      const downloads = await import('../../modules/video/local/downloadManager');
      stopDownloads = downloads.subscribeDownloads(schedule);
    } catch (err) {
      log.warn('could not subscribe to download progress', err);
    }
    libraryTimer = setInterval(publishLibrary, LIBRARY_REPUBLISH_MS);
    publishLibrary();

    /*
     * ── The remote's live ring ────────────────────────────────────────────
     *
     * The phone renders the REAL module — the actual clock renderer, the actual
     * stats renderer — from synced state rather than from streamed pixels. Two
     * facts a replica cannot compute for itself come from here: the 0.5 Hz
     * monitoring snapshot, and a ≤6 KB WebP thumbnail of whatever picture is on
     * the panel, chunked over the same channel the diagnostics report uses.
     *
     * Gated on `publishTelemetry` along with everything else in this block,
     * because that toggle means "your Kraken reports back to this page" and
     * this is precisely that.
     */
    try {
      const replica = await import('./replicaFeed');
      const thumbs = await import('../../modules/replicaThumb');
      const feed = replica.startReplicaFeed({
        runtime,
        publish: (body) => {
          service.publishTele(body);
        },
      });
      // Whatever is already on the panel: the module mounted before sync did,
      // so without this the ring stays empty until the next source change.
      feed.publishThumb(thumbs.currentReplicaThumb());
      const off = thumbs.subscribeReplicaThumb((blob) => {
        feed.publishThumb(blob);
      });
      stopReplica = () => {
        off();
        feed.stop();
      };
    } catch (err) {
      log.warn('could not start the replica feed', err);
    }
  }

  writeReadout({
    t: service.status().networkTransport,
    net: service.status().network,
    topic: service.topicId(),
  });

  let stopped: Promise<void> | null = null;

  const stop = async (): Promise<void> => {
    // Idempotent by construction: `pagehide` and the caller's own teardown can
    // both land for one page load, and the second one must not race the first
    // one's broker flush window.
    stopped ??= (async () => {
      window.removeEventListener('pagehide', onPagehide);
      stopTele?.();
      stopDownloads?.();
      stopReplica?.();
      if (libraryTimer !== null) clearInterval(libraryTimer);
      if (debounce !== null) clearTimeout(debounce);
      if (seekTimer !== null) clearTimeout(seekTimer);
      seekTimer = null;
      for (const timer of diagTimers) clearTimeout(timer);
      diagTimers.clear();
      publishTele = null;
      appliedPosAtTs = null;
      await handle.stop();
    })();
    return stopped;
  };

  /*
   * The flush-before-close path (the display half).
   *
   * `MqttTransport.disconnect()` ends the client with `end(false, …)` and a
   * 1.5 s ceiling precisely so a last message is flushed rather than dropped,
   * and until now nothing on a real tab close ever reached it. `pagehide` is
   * the event that still fires for a bfcache-eligible page, which
   * `beforeunload` does not. Whether CAM's Electron webview delivers it when it
   * tears down the LCD window is unverified — hardware checklist **H23** — which
   * is why nothing depends on it: `publish()` already awaits the broker
   * callback, so the outbound queue is normally empty anyway.
   */
  function onPagehide(): void {
    void stop();
  }
  window.addEventListener('pagehide', onPagehide);

  return { stop };
}
