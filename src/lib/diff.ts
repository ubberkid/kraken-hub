/** Structural diff, reported as dot paths — the `UpdateReason.changed` list. */

import { isPlainObject } from './clamp';

const MAX_DEPTH = 8;

/**
 * Dot paths whose value differs between `a` and `b`. Arrays are compared
 * wholesale (a reordered playlist is one change, not n), matching the merge
 * semantics in `state/precedence.ts`.
 */
export function diffPaths(a: unknown, b: unknown, prefix = '', depth = 0): string[] {
  if (Object.is(a, b)) return [];
  if (depth >= MAX_DEPTH || !isPlainObject(a) || !isPlainObject(b)) {
    return prefix.length > 0 ? [prefix] : ['$'];
  }
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    out.push(...diffPaths(a[key], b[key], path, depth + 1));
  }
  return out;
}
