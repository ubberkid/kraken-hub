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
import { MEDIA_MIRROR_SUFFIXES } from '../../platform/mediaStore';
import { onStorageEvent } from '../../platform/storage';
import { anchorPosition } from '../../sync/position';

import type { DisplayRuntime } from './runtime';
import type { AppState, DeepPartial, PlaybackState } from '../../state/schema';
import type { CmdBody } from '../../sync/types';

const log = createLogger('display/sync');

/**
 * The library and download progress are re-announced this often.
 *
 * Five minutes, and it stays five minutes: this is a KEEPALIVE, not the
 * cold-start path. Treating it as the cold-start path is what made "no pull, no
 * retain" a headline defect rather than a polish item — `tele` publishes
 * unretained, so a phone that unlocked one second after a republish waited the
 * best part of five minutes staring at an empty shelf, with nothing on screen to
 * say it was waiting. `requestLibrary` (B3) is the fix: a cold remote ASKS the
 * moment its transport comes up and gets an answer in one round trip. Shortening
 * this interval would only have narrowed the window while spending a peer's
 * radio every thirty seconds for a list that changes when a user adds a file.
 *
 * And a list that changes when a user adds a file is now ANNOUNCED when a user
 * adds a file: the display watches the two library mirrors for a `storage` event
 * (see the subscription below `schedule`), so a change made in CAM reaches an
 * already-open remote in about a second rather than whenever this timer next
 * happens to fire. That is what stops this constant being read as the cold-start
 * path a second time.
 */
export const LIBRARY_REPUBLISH_MS = 300_000;

/**
 * How long an arriving `playback` waits for a module to exist.
 *
 * A retained snapshot is delivered the instant the transport connects, which on
 * a cold boot is routinely *before* the compositor has finished its dynamic
 * import — so the base module has no renderer yet and a seek issued then would
 * simply vanish. Commands are dropped when nothing is mounted for good reason
 * (replaying a seek at mount is a bug), but this is not a replay: it is the
 * FIRST delivery of a position the display has never applied, and it carries
 * its own timestamp, so re-anchoring on each attempt keeps it honest.
 *
 * What is waited ON changed with the compositor. The single-module host
 * registered `runtime.onCommand` only once its renderer was mounted, so a
 * non-null handler was the readiness signal; the compositor's handler is
 * installed with the stage and outlives every renderer, so the signal is now
 * the handler's RETURN — `false` until a live renderer takes the command.
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
  let stopMirror: (() => void) | null = null;
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

    function retry(attempt: number): void {
      if (attempt >= PLAYBACK_RETRY_LIMIT) return;
      seekTimer = setTimeout(() => {
        deliver(attempt + 1);
      }, PLAYBACK_RETRY_MS);
    }

    function deliver(attempt: number): void {
      seekTimer = null;
      const command = runtime.onCommand.current;
      if (command === null) {
        retry(attempt);
        return;
      }
      const anchored = anchorPosition(
        { posSec: p.posSec, posAtTs: p.posAtTs, paused: p.paused, rate: p.rate },
        Date.now(),
        p.durationSec,
      );
      if (anchored.stale) {
        // Marked applied even though nothing was acted on: a stale position does
        // not become fresh by being retried, and re-examining it on every
        // keepalive would be pure noise.
        appliedPosAtTs = p.posAtTs;
        log.warn(`ignoring a playback position ${String(Math.round(anchored.staleSec))}s old`);
        return;
      }
      // The handler exists for the whole life of the compositor, so its ANSWER
      // is what says a renderer was there to take the seek — on a cold boot the
      // base module's chunk is routinely still in flight. Keep asking, and
      // re-anchor every time, so the position that finally lands is the position
      // as of the moment it lands rather than the one this snapshot arrived with.
      if (!command('seekTo', anchored.posSec)) {
        retry(attempt);
        return;
      }
      appliedPosAtTs = p.posAtTs;
      writeReadout({ pos: Number(anchored.posSec.toFixed(1)), posAtTs: p.posAtTs });
    }

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
  let publishTele:
    ((body: { ts: number; kind: string }, opts?: { immediate?: boolean }) => void) | null = null;
  let diagRunning = false;
  const libraryTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Announce the whole shelf — clips AND pictures — as one packet.
   *
   * Defined out here, ABOVE the `publishTelemetry` gate, because `requestLibrary`
   * has to be able to call it. See the `onCmd` switch for why that is not a hole
   * in the privacy toggle.
   *
   * Pictures were never on the wire at all before wave 1 (B2): `publishImageIndex`
   * wrote to localStorage, which reaches CAM's own configuration window over the
   * shared origin and reaches a phone never — so the remote's shelf was half the
   * collection and had no way to know it. They ride the same packet, under one
   * shared item budget, because they are one shelf.
   *
   * ## It reads the STORE, not the mirrors
   *
   * Until this round it built the packet from `readClipIndex()` +
   * `readImageIndex()` — the two localStorage mirrors — while CAM's grid built
   * its shelf from `listMedia()`, the merged IndexedDB store with its legacy
   * fallback. Two readers, two sources, nothing reconciling them: a row that
   * reached IndexedDB while the mirror write degraded to memory (`writeRaw` does
   * that silently, and an in-memory mirror in one window's JS context is
   * invisible to every other window) was a row the phone could never be told
   * about, permanently. Reproduced, not feared. One reader now, of the store the
   * bytes are actually in — which also means the shelf on the wire is the shelf
   * CAM is looking at, by construction rather than by two writers agreeing.
   */
  const publishLibrary = (opts: { immediate?: boolean } = {}): void => {
    void (async () => {
      const publish = publishTele;
      if (publish === null) return;
      try {
        const [media, downloads, packet] = await Promise.all([
          import('../../platform/mediaStore'),
          import('../../modules/video/local/downloadManager'),
          import('../../lib/libraryPacket'),
        ]);
        const built = packet.buildLibraryPacket({
          ts: Date.now(),
          // ONE list, from one store, ordered and cut once (C2) — with `kind` on
          // the row, because kind is a property and not a place.
          items: packet.toMediaSummaries(await media.listMedia()),
          downloads: downloads.listDownloads(),
        });
        if (built.chunks === null) {
          publish(built.body, opts);
          return;
        }
        /*
         * Spaced, and every part `immediate`.
         *
         * Exactly the diagnostics report's reasoning: `publishTele` throttles at
         * 5 Hz and DROPS what lands inside the window, so a loop would publish
         * one part of a library and nothing else — and `immediate` is what stops
         * a routine `videoStats` packet landing 180 ms later from eating the
         * next part.
         */
        const { CHUNK_SPACING_MS } = await import('../../lib/chunkedTele');
        built.chunks.forEach((chunk, index) => {
          if (index === 0) {
            publish(chunk, { immediate: true });
            return;
          }
          const timer = setTimeout(() => {
            libraryTimers.delete(timer);
            publish(chunk, { immediate: true });
          }, index * CHUNK_SPACING_MS);
          libraryTimers.add(timer);
        });
      } catch (err) {
        log.warn('could not publish the library', err);
      }
    })();
  };

  /*
   * ── Curation: the shelf's three ACTS, applied where the bytes are ────────
   *
   * `setPinned`, `renameMedia` and `deleteMedia` arrive from a window that can
   * see every row and reach none of them. They are applied against the merged
   * media store — one call each, by id, in a batch — and the shelf is then
   * re-announced immediately, which is the only "ack" this protocol has and the
   * only one it needs: the remote removed the tile optimistically and is waiting
   * to be told what is actually true.
   *
   * Deliberately OUTSIDE the `publishTelemetry` gate, on exactly the argument
   * `requestDiag` and `requestLibrary` already make. That toggle is about the
   * continuous stream a display volunteers; this is a person in the room pressing
   * a button, and the command arrived decrypted, so it came from inside the room.
   * Silently ignoring a delete because telemetry was once switched off would be a
   * button that does nothing with nothing anywhere to explain why.
   *
   * `curations` is on the readout so a test can prove the batching claim: three
   * tiles deleted together must arrive as ONE command, because `sendCmd` throttles
   * per-op at 200 ms and DROPS the rest of a loop.
   */
  let curations = 0;

  async function applyCuration(body: CmdBody): Promise<void> {
    const [curation, media, clips, images] = await Promise.all([
      import('../../lib/curation'),
      import('../../platform/mediaStore'),
      import('../../modules/video/local/clipStore'),
      import('../../modules/image/imageStore'),
    ]);

    if (body.op === 'setPinned') {
      const arg = curation.parseSetPinned(body.arg);
      if (arg === null) return;
      for (const id of arg.ids) await media.patchMedia(id, { pinned: arg.pinned });
    } else if (body.op === 'renameMedia') {
      const arg = curation.parseRenameMedia(body.arg);
      if (arg === null) return;
      await media.patchMedia(arg.id, { name: arg.name });
    } else if (body.op === 'deleteMedia') {
      const arg = curation.parseDeleteMedia(body.arg);
      if (arg === null) return;
      // Idempotent by construction, and it removes the legacy row too — the
      // fallback read would otherwise put the item straight back on the shelf.
      await media.deleteMedia(arg.ids);
    } else {
      return;
    }

    // Both localStorage mirrors, because the CAM configuration window reads the
    // shelf from them over the shared origin and would otherwise show the old
    // row until something else happened to write.
    await clips.publishClipIndex();
    await images.publishImageIndex();
    curations += 1;
    writeReadout({ cur: curations });
    publishLibrary({ immediate: true });
  }

  /*
   * ── The LAN file transfer's receiving end ────────────────────────────────
   *
   * Lazily imported on the FIRST offer, exactly the seam `requestDiag` uses:
   * everything below the dynamic import is in the transfer chunk, so the LCD's
   * critical path does not grow by a byte for a feature that only ever fires
   * when somebody points a phone at it, and `npm run size` proves that on every
   * build.
   *
   * An offer that lands while the chunk is still downloading is DROPPED rather
   * than queued, and that is safe because the sender repeats its offer on a
   * 700 ms beat until it is answered — the signalling channel is a last-value
   * slot, so every message in this protocol is repeatable by construction.
   */
  let receiver: { accept: (b: { op: string; arg?: unknown }) => void; stop: () => void } | null =
    null;
  let receiverLoading = false;

  function routeTransfer(body: CmdBody): void {
    if (receiver !== null) {
      receiver.accept(body);
      return;
    }
    if (body.op !== 'transferOffer' || receiverLoading) return;
    receiverLoading = true;
    void (async () => {
      try {
        const mod = await import('../../transfer/receive');
        const made = mod.createTransferReceiver({
          publish: (packet) => {
            // `immediate`, for the reason every answer on this channel is: the
            // routine telemetry stream throttles at 5 Hz and DROPS what lands
            // inside its window, and a handshake message that is silently eaten
            // is fifteen seconds of a progress spinner and then a lie about the
            // network.
            publishTele?.(packet, { immediate: true });
          },
          onStored: () => {
            publishLibrary({ immediate: true });
          },
        });
        receiver = made;
        made.accept(body);
      } catch (err) {
        log.warn('could not start a file transfer', err);
      } finally {
        receiverLoading = false;
      }
    })();
  }

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
        /*
         * Spaced AND immediate.
         *
         * The spacing is for the chunks' own sake — `publishTele` throttles at
         * 5 Hz and a loop would emit them all inside one window. `immediate` is
         * for the routine stream's: a `videoStats` or `monitor` packet landing
         * 180 ms before the report silently ate it, so the button a person had
         * just pressed on another machine did nothing and the card timed out
         * twenty seconds later. Reproducible, and the reason round 2's Report
         * section can promise "ask your Kraken" and mean it.
         */
        if (index === 0) {
          publish(chunk, { immediate: true });
          return;
        }
        const timer = setTimeout(() => {
          diagTimers.delete(timer);
          publish(chunk, { immediate: true });
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
        /*
         * "Tell me what is on the shelf" — and, like `requestDiag`, deliberately
         * OUTSIDE the `publishTelemetry` gate.
         *
         * That toggle governs the CONTINUOUS stream a display volunteers about
         * itself — position, frame rate, a library republish every five minutes —
         * and turning it off is a privacy choice about being watched. This is the
         * opposite: a person in the room just opened the remote and is looking at
         * an empty shelf. Gating the answer on the passive toggle would make the
         * library permanently blank on a phone whose owner had once turned
         * telemetry off, with nothing anywhere to explain why. The command
         * arrived decrypted, so it came from inside the room; the repo already
         * makes exactly this argument for `requestDiag`.
         */
        case 'requestLibrary':
          publishLibrary({ immediate: true });
          break;
        /*
         * The shelf's three acts, and the file transfer's handshake.
         *
         * Both sit beside `requestLibrary` above the telemetry gate for the same
         * reason: they are answers to a person who just pressed something, not
         * the passive stream that toggle governs.
         */
        case 'setPinned':
        case 'renameMedia':
        case 'deleteMedia':
          void applyCuration(body).catch((err: unknown) => {
            log.warn('could not apply a library change', err);
          });
          break;
        case 'transferOffer':
        case 'transferIce':
          routeTransfer(body);
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
  publishTele = (body, opts) => {
    service.publishTele(body, opts);
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

    /*
     * The shelf, published as telemetry.
     *
     * It goes on `tele` rather than `state` for a reason: it is a FACT ABOUT
     * THIS MACHINE, not desired configuration. The bytes live in the CAM browser
     * profile's IndexedDB and a phone can never write to them — but it can see
     * every one of them and play any of them, which is the whole model:
     * visibility is a property of the Kraken, capability is a property of the
     * window.
     *
     * `publishLibrary` itself is defined above this gate so `requestLibrary` can
     * reach it. What is gated here is the CONTINUOUS half — the download
     * subscription and the five-minute keepalive — which is exactly the passive
     * stream the toggle is about.
     */
    /*
     * Debounced, and then `immediate` — which are not the same knob.
     *
     * The debounce is this file's: a multi-file add republishes the index once
     * per file, and a download ticks progress several times a second, so the
     * coalescing happens here, once a second at most.
     *
     * `immediate` is the SERVICE's: `publishTele` throttles at 5 Hz and DROPS
     * what lands inside the window rather than queueing it, and the replica feed
     * is publishing a monitoring snapshot and a panel thumbnail on the same
     * channel the whole time. A dropped `videoStats` packet costs 200 ms of a
     * stale frame counter and the next one repairs it; a dropped library packet
     * is a shelf that stays wrong until the five-minute keepalive, which is the
     * defect this trigger was added to fix, arriving by a third door. Measured,
     * not feared: without this the new two-page e2e failed six times out of six
     * under a loaded machine, and passed alone.
     *
     * It cannot flood: at most one of these per `LIBRARY_DEBOUNCE_MS`.
     */
    const schedule = (): void => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        publishLibrary({ immediate: true });
      }, LIBRARY_DEBOUNCE_MS);
    };

    try {
      const downloads = await import('../../modules/video/local/downloadManager');
      stopDownloads = downloads.subscribeDownloads(schedule);
    } catch (err) {
      log.warn('could not subscribe to download progress', err);
    }

    /*
     * ── The trigger that was missing ─────────────────────────────────────────
     *
     * Before this, the shelf was re-announced on exactly four events: boot, the
     * five-minute keepalive, this page's OWN downloader, and a command from a
     * remote. Every one of them is something the display itself did. A file
     * added, renamed, pinned or deleted in CAM's configuration window — the
     * window that actually owns the bytes, and the one a person is most likely
     * to be using — was none of them. So a phone that was already open kept
     * showing the shelf as it stood up to five minutes ago: missing the clip
     * just added, and still offering a tile for a row that had been deleted,
     * which plays nothing when pressed. Reloading the phone fixed it instantly,
     * because `requestLibrary` on connect always worked — which is the shape of
     * the bug: the cold path was right and the live path did not exist.
     *
     * The two mirrors are what make the fix free. Every write in CAM publishes
     * them, and a `localStorage` write fires a `storage` event in every OTHER
     * document on the origin — CAM's own grid has listened for exactly this
     * since the beginning. The display listens too now, and the event carries no
     * data we trust: it is a nudge to re-read `listMedia()`, through the same
     * `schedule()` debounce the downloader uses, so a batch of writes (a
     * multi-file add publishes the index once per file) is one packet.
     *
     * Gated with the rest of the continuous stream, deliberately. A remote that
     * has telemetry switched off still gets an answer to `requestLibrary`, which
     * is the button-press path and outside the gate; what this adds is the
     * volunteered half, which is precisely what the toggle governs.
     */
    stopMirror = onStorageEvent((e) => {
      // `null` is a whole-origin `clear()` — treat it as "everything changed",
      // exactly as `watchState` does.
      if (e.suffix !== null && !MEDIA_MIRROR_SUFFIXES.includes(e.suffix)) return;
      schedule();
    });
    libraryTimer = setInterval(() => {
      publishLibrary();
    }, LIBRARY_REPUBLISH_MS);
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
      stopMirror?.();
      stopReplica?.();
      if (libraryTimer !== null) clearInterval(libraryTimer);
      if (debounce !== null) clearTimeout(debounce);
      if (seekTimer !== null) clearTimeout(seekTimer);
      seekTimer = null;
      for (const timer of diagTimers) clearTimeout(timer);
      diagTimers.clear();
      for (const timer of libraryTimers) clearTimeout(timer);
      libraryTimers.clear();
      receiver?.stop();
      receiver = null;
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
