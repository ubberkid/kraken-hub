/**
 * The monitoring snapshot that rides the telemetry channel.
 *
 * The phone remote's mini-halo renders the **real** stats module — the same
 * renderer the LCD runs — and a renderer needs readings. Those readings exist
 * only on the machine running CAM, so a few of them have to cross the wire.
 *
 * Two constraints decide the shape, and neither is negotiable:
 *
 *  1. **Invariant I6: 8 KB per envelope**, shared with everything else on the
 *     packet. A full `NormalizedMonitoring` carries names, frequencies, power,
 *     core counts and a RAM pair — several hundred bytes of things no dial on a
 *     132 px halo can show. So this is five numbers and nothing else, keyed as
 *     tersely as JSON allows: about sixty bytes on the wire.
 *  2. **`undefined` is a real value here.** Every field of CAM's feed is
 *     `number | undefined`, and a module must render `--` rather than `0` when
 *     a sensor is absent. So an absent reading is an ABSENT KEY, never a zero —
 *     `decodeMonitorSnapshot` puts `undefined` back, and the stats renderer's
 *     existing "draw the track only" path does the rest.
 *
 * This file is in `src/sync` on purpose: it is wire format, both ends need it,
 * and `src/sync` must not import `src/modules`. It takes the platform's
 * normalised shape as a plain structural type rather than importing it, so
 * nothing here depends on the module layer either.
 */

/** Exactly what the remote's replica can render, and nothing more. */
export interface MonitorSnapshot {
  cpu: { tempC?: number; load?: number };
  gpu: { tempC?: number; load?: number };
  /** `kraken.liquidTemperature` — the only cooler field CAM exposes. */
  liquidC?: number;
}

/**
 * The wire form: one flat object with two-character keys.
 *
 * Flat rather than nested because nesting costs eight bytes per group for
 * nothing — this is never read by a human, and `decode` is the only reader.
 */
interface WireSnapshot {
  ct?: number;
  cl?: number;
  gt?: number;
  gl?: number;
  lq?: number;
}

/** Readings are rounded to one decimal: a dial cannot show more, and it halves the digits. */
const DECIMALS = 1;

function round(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(DECIMALS));
}

/** Only defined values become keys — see rule 2 above. */
function put(target: WireSnapshot, key: keyof WireSnapshot, value: number | undefined): void {
  const rounded = round(value);
  if (rounded !== undefined) target[key] = rounded;
}

/**
 * The platform shape this reads, structurally.
 *
 * Declared here rather than imported so `src/sync` keeps knowing nothing about
 * `src/platform`'s module graph; `NormalizedMonitoring` satisfies it.
 */
export interface MonitorSource {
  cpu: { load?: number; tempC?: number };
  gpu: { load?: number; tempC?: number };
  kraken: { liquidTempC?: number };
}

export function encodeMonitorSnapshot(n: MonitorSource): Record<string, number> {
  const out: WireSnapshot = {};
  put(out, 'ct', n.cpu.tempC);
  put(out, 'cl', n.cpu.load);
  put(out, 'gt', n.gpu.tempC);
  put(out, 'gl', n.gpu.load);
  put(out, 'lq', n.kraken.liquidTempC);
  return out as Record<string, number>;
}

function num(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Anything that is not a usable snapshot decodes to `null`, and a `null`
 * snapshot is what makes the replica render `--` instead of inventing a zero.
 */
export function decodeMonitorSnapshot(raw: unknown): MonitorSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const cpuTemp = num(o['ct']);
  const cpuLoad = num(o['cl']);
  const gpuTemp = num(o['gt']);
  const gpuLoad = num(o['gl']);
  const liquid = num(o['lq']);
  if (
    cpuTemp === undefined &&
    cpuLoad === undefined &&
    gpuTemp === undefined &&
    gpuLoad === undefined &&
    liquid === undefined
  ) {
    // An object with none of our keys is not an empty reading, it is somebody
    // else's payload. Saying `null` keeps the "waiting for CAM data" card up,
    // which is the truthful answer.
    return null;
  }
  return {
    cpu: {
      ...(cpuTemp === undefined ? {} : { tempC: cpuTemp }),
      ...(cpuLoad === undefined ? {} : { load: cpuLoad }),
    },
    gpu: {
      ...(gpuTemp === undefined ? {} : { tempC: gpuTemp }),
      ...(gpuLoad === undefined ? {} : { load: gpuLoad }),
    },
    ...(liquid === undefined ? {} : { liquidC: liquid }),
  };
}

/**
 * Back into the platform's normalised shape, so the REAL stats renderer can be
 * fed it without knowing it came off a wire.
 *
 * The fields this snapshot does not carry stay absent, which is exactly right:
 * `format.ts` turns an absent reading into `--` and a `null` dial fraction, so
 * a remote replica showing CPU load and liquid temperature but no RAM figure is
 * self-describing rather than wrong.
 */
export function snapshotToMonitoring(
  snap: MonitorSnapshot,
  at: number,
): {
  cpu: { load?: number; tempC?: number };
  gpu: { load?: number; tempC?: number };
  ram: Record<string, never>;
  kraken: { liquidTempC?: number };
  at: number;
  simulated: boolean;
} {
  return {
    cpu: { ...snap.cpu },
    gpu: { ...snap.gpu },
    ram: {},
    kraken: snap.liquidC === undefined ? {} : { liquidTempC: snap.liquidC },
    at,
    // Not simulated: these are real readings from a real machine, they just
    // arrived by radio. Claiming otherwise would put a "simulated" badge on a
    // genuine temperature.
    simulated: false,
  };
}
