/** Numeric helpers shared by the state validators and the platform layer. */

/** Clamp `n` into `[min, max]`. Non-finite input returns `min`. */
export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Narrow `unknown` to a finite number (rejects `NaN`, `Infinity`, numeric strings). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Narrow `unknown` to a plain (non-array, non-null) object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
