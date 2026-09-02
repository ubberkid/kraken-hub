/**
 * The global URL-parameter table (design-ossDx.md §4.6).
 *
 * Parsing rules that matter on a device with no input: an unparseable value
 * means the parameter is IGNORED — never a crash, never a partial apply — and
 * the reason is recorded as a `ParamNote` that the diagnostics view renders.
 * Unknown parameters are ignored and listed, so a fork can add its own.
 *
 * Module-scoped keys (handed raw to the ACTIVE module's `applyUrlParams`):
 * `src` (video, image), `loop`, `mute` (video), `face` (clock), `layout`
 * (stats), `effect` (effect). Everything else in `KNOWN_KEYS` is global and
 * patches `AppState`.
 *
 * `?module=` selects the BASE kind and takes any registered id, so the W7 kinds
 * — `text`, `shape`, `effect` — need nothing here beyond their own display
 * params. `text` and `shape` have none: every field of either is a string, a
 * colour or a number with no short spelling worth putting in a URL, and a kind
 * with no `applyUrlParams` is simply never asked.
 *
 * There is deliberately no `?preset=`. A preset is a PALETTE, and the palette
 * table (`src/modules/effect/catalog.ts`) is lazy on purpose — the eager
 * manifest that would have to honour the parameter cannot resolve one without
 * putting twelve palettes on the LCD's 90 kB critical path. A key this table
 * accepts and no module can act on is worse than one it reports as unknown, so
 * it reports it as unknown.
 */

import { isDevicePresetId, type DevicePresetId } from '../platform/devicePresets';
import { normalizeRoomCode } from '../sync/roomCode';

import { MODULE_ID_RE } from './validate';

import type { DeepPartial, AppState } from './schema';
import type { MonitorProfile } from '../platform/simulator';

export interface ParamNote {
  key: string;
  raw: string;
  reason: string;
}

export type DiagPattern = 'flat' | 'rings' | 'video' | 'youtube' | 'stack';

/**
 * `?stack=` — which W0 layer stack `&pattern=stack` composes.
 *
 * THROWAWAY, with the spike it drives (`src/render/compositor.spike.ts`):
 * remove both when the real compositor lands.
 */
export type StackId = 'a' | 'b' | 'c' | 'd' | 'e';

export interface RuntimeFlags {
  /** CAM-injected. Selects the display boot path. */
  kraken: boolean;
  diag: boolean;
  demo: boolean;
  /** `?pin=1` promotes URL params above persisted state for this load only. */
  pin: boolean;
  sim: DevicePresetId | null;
  /** `?fps=` — simulator/fallback frame rate override. */
  fps: number | null;
  monitor: MonitorProfile | null;
  inject: 'late' | null;
  pattern: DiagPattern | null;
  /** Only read by `&pattern=stack` (W0 spike). */
  stack: StackId | null;
  page: number | null;
  /**
   * `?cam=1` / `?cam=0` — the CAM-window simulator.
   *
   * Whether this page is CAM's own Configuration Browser is a property of the
   * BROWSER (`window.nzxt`, or an Electron UA), and wave 1 makes that property
   * the gate on every piece of UI that owns bytes. Which leaves no way at all to
   * exercise either side of the gate from an automated run, or from a
   * contributor's laptop with no CAM on it — the same reason `?sim=` exists for
   * the panel geometry. `null` means "detect it honestly", which is what a real
   * user always gets.
   */
  cam: boolean | null;
  /**
   * `?phone=1` / `?phone=0` — the phone-class simulator.
   *
   * Whether this window is a phone is a property of the DEVICE (a coarse
   * pointer on a narrow viewport), and it now decides which of the two apps a
   * non-CAM visitor gets at all. Same seam, and the same reason, as `?cam=`:
   * without it neither side of the gate can be exercised from a run that has no
   * touchscreen. `null` means "measure it honestly", which is what every real
   * visitor gets.
   */
  phone: boolean | null;
}

export interface ParsedUrlParams {
  /** Overrides for the global state document. */
  patch: DeepPartial<AppState>;
  /** Raw values destined for the ACTIVE module's own config (`src`, `loop`, `mute`). */
  moduleParams: Record<string, string>;
  flags: RuntimeFlags;
  notes: ParamNote[];
  /** Every key present in the query string, for the diagnostics readout. */
  seen: string[];
}

const KNOWN_KEYS = new Set([
  'kraken',
  'module',
  'src',
  'fit',
  'loop',
  'mute',
  'face',
  'layout',
  'effect',
  'room',
  'transport',
  'demo',
  'diag',
  'pin',
  'sim',
  'fps',
  'monitor',
  'inject',
  'pattern',
  'stack',
  'page',
  'cam',
  'phone',
]);

function isOne(raw: string): boolean {
  return raw === '1' || raw === 'true';
}

function parseBoolParam(raw: string): boolean | undefined {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return undefined;
}

function parseIntParam(raw: string, min: number, max: number): number | undefined {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

/**
 * Parse a query string into a state patch, module params and runtime flags.
 * Accepts `location.search`, a full URL's search, or a bare `a=b&c=d`.
 */
export function parseUrlParams(search: string): ParsedUrlParams {
  const q = new URLSearchParams(search);
  const notes: ParamNote[] = [];
  const seen: string[] = [];
  const patch: DeepPartial<AppState> = {};
  const moduleParams: Record<string, string> = {};
  const flags: RuntimeFlags = {
    kraken: false,
    diag: false,
    demo: false,
    pin: false,
    sim: null,
    fps: null,
    monitor: null,
    inject: null,
    pattern: null,
    stack: null,
    page: null,
    cam: null,
    phone: null,
  };

  const reject = (key: string, raw: string, reason: string): void => {
    notes.push({ key, raw, reason });
  };

  for (const [key, raw] of q) {
    seen.push(key);
    if (!KNOWN_KEYS.has(key)) {
      reject(key, raw, 'unknown parameter (ignored)');
      continue;
    }

    switch (key) {
      case 'kraken':
        flags.kraken = isOne(raw);
        break;
      case 'diag':
        flags.diag = isOne(raw);
        break;
      case 'demo':
        flags.demo = isOne(raw);
        // Also handed to the active module: `?demo=1` is a module-level
        // instruction ("play your bundled sample"), not just a boot flag.
        if (flags.demo) moduleParams['demo'] = '1';
        break;
      case 'pin':
        flags.pin = isOne(raw);
        break;
      case 'cam': {
        const cam = parseBoolParam(raw);
        if (cam === undefined) {
          reject(key, raw, 'expected 0|1');
          break;
        }
        flags.cam = cam;
        break;
      }
      case 'phone': {
        const phone = parseBoolParam(raw);
        if (phone === undefined) {
          reject(key, raw, 'expected 0|1');
          break;
        }
        flags.phone = phone;
        break;
      }

      case 'module': {
        if (!MODULE_ID_RE.test(raw)) {
          reject(key, raw, 'not a kebab-case module id');
          break;
        }
        patch.activeModuleId = raw;
        break;
      }

      case 'fit': {
        if (raw !== 'cover' && raw !== 'contain' && raw !== 'fill') {
          reject(key, raw, 'expected cover|contain|fill');
          break;
        }
        patch.render = { ...patch.render, fit: raw };
        break;
      }

      case 'room': {
        const code = normalizeRoomCode(raw);
        if (code === null) {
          reject(key, raw, 'expected an 8-character Crockford base32 room code');
          break;
        }
        // NOTE: applied to the resolved state but never auto-persisted from the
        // display page — a shared link must not silently repoint someone's LCD.
        patch.sync = { ...patch.sync, roomCode: code, enabled: true };
        break;
      }

      case 'transport': {
        // `fake` is the in-repo broker simulator, reachable only from here.
        if (raw !== 'auto' && raw !== 'mqtt' && raw !== 'ntfy' && raw !== 'off' && raw !== 'fake') {
          reject(key, raw, 'expected auto|mqtt|ntfy|off');
          break;
        }
        patch.sync = { ...patch.sync, transport: raw };
        break;
      }

      case 'fps': {
        const fps = parseIntParam(raw, 1, 60);
        if (fps === undefined) {
          reject(key, raw, 'expected an integer 1-60');
          break;
        }
        flags.fps = fps;
        patch.platform = { ...patch.platform, fallbackTargetFps: fps };
        break;
      }

      case 'sim': {
        if (!isDevicePresetId(raw)) {
          reject(key, raw, 'expected elite|plus|z|kraken2023');
          break;
        }
        flags.sim = raw;
        break;
      }

      case 'monitor': {
        if (raw !== 'idle' && raw !== 'load' && raw !== 'spike' && raw !== 'missing') {
          reject(key, raw, 'expected idle|load|spike|missing');
          break;
        }
        flags.monitor = raw;
        break;
      }

      case 'inject': {
        if (raw !== 'late') {
          reject(key, raw, 'expected late');
          break;
        }
        flags.inject = 'late';
        break;
      }

      case 'pattern': {
        if (
          raw !== 'flat' &&
          raw !== 'rings' &&
          raw !== 'video' &&
          raw !== 'youtube' &&
          raw !== 'stack'
        ) {
          reject(key, raw, 'expected flat|rings|video|youtube|stack');
          break;
        }
        flags.pattern = raw;
        break;
      }

      case 'stack': {
        if (raw !== 'a' && raw !== 'b' && raw !== 'c' && raw !== 'd' && raw !== 'e') {
          reject(key, raw, 'expected a|b|c|d|e');
          break;
        }
        flags.stack = raw;
        break;
      }

      case 'page': {
        const page = parseIntParam(raw, 1, 8);
        if (page === undefined) {
          reject(key, raw, 'expected an integer 1-8');
          break;
        }
        flags.page = page;
        break;
      }

      // Module-scoped parameters. Kept raw: only the active module knows how to
      // interpret them, and it validates them against its own schema.
      case 'src': {
        if (raw.length === 0) {
          reject(key, raw, 'empty source');
          break;
        }
        moduleParams['src'] = raw;
        break;
      }
      case 'loop':
      case 'mute': {
        const value = parseBoolParam(raw);
        if (value === undefined) {
          reject(key, raw, 'expected 0|1');
          break;
        }
        moduleParams[key] = value ? '1' : '0';
        break;
      }
      /*
       * `face` (clock), `layout` (stats) and `effect` (effect) are module-scoped
       * like `src`: kept raw, because only the active module knows the legal
       * values, and it validates them against its own schema. A value this table
       * does not recognise is therefore not rejected HERE — the module drops it
       * and the host re-runs `validate()`, which is the documented contract in
       * docs/modules.md §9.
       */
      case 'face':
      case 'layout':
      case 'effect': {
        if (raw.length === 0) {
          reject(key, raw, 'empty value');
          break;
        }
        moduleParams[key] = raw;
        break;
      }
    }
  }

  return { patch, moduleParams, flags, notes, seen };
}
