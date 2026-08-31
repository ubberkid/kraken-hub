#!/usr/bin/env node
/**
 * The source-text half of the platform invariants.
 *
 * ESLint enforces seven of the eight invariants from CONTRIBUTING.md as lint
 * rules. **Invariant 5 — "no hardcoded device sizes" — is the one it can only
 * half enforce.** `no-magic-numbers` catches a bare `640` in an expression, but
 * it says nothing about a *named* constant (`const PANEL = 640`, which is
 * exactly the shape the invariant exists to prevent), it is scoped to
 * `src/modules/**` and `src/app/display/**` only, and it never sees CSS or JSX
 * text at all. This script closes that: a grep for the three device dimensions
 * across every source file, with an explicit allowlist and an explicit,
 * documented escape hatch.
 *
 * Why it matters: 640 is one device. A Kraken Z is 320 and a Kraken 2023 is 240,
 * and every one of those numbers reaches the code through `Geometry`, read from
 * `window.nzxt.v1`. A literal that slips in produces a layout that is silently
 * wrong on two of the four supported panels — and nobody notices, because
 * almost every contributor is developing against an Elite.
 *
 * ## What counts as a violation
 *
 * A `640`, `320` or `240` token in a source file, after comments are stripped,
 * outside the allowlist, without a marker.
 *
 * ## The escape hatch
 *
 * Some of these numbers are genuinely not device dimensions — a YouTube quality
 * ladder rung, a thumbnail edge, prose in the config UI. Mark those with
 *
 *     // device-size-ok: <why this is not a panel dimension>
 *
 * on the same line or the line above. The marker is the point: it forces the
 * next person to write down why, and a new unexplained 640 still fails.
 *
 * Usage: node scripts/check-invariants.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

/** The two files whose whole job is to KNOW the device table. */
const ALLOWLIST = new Set(['src/platform/devicePresets.ts', 'src/platform/geometry.ts']);

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css'];
const DEVICE_SIZE_RE = /\b(?:640|320|240)\b/;
const MARKER = 'device-size-ok';

/** Tests reproduce the design docs' worked examples; the literals ARE the test. */
function isScanned(rel) {
  if (!SCANNED_EXTENSIONS.some((ext) => rel.endsWith(ext))) return false;
  if (rel.endsWith('.d.ts')) return false;
  if (/\.test\.tsx?$/.test(rel)) return false;
  return !ALLOWLIST.has(rel);
}

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/**
 * Blanks out comments while preserving line count and column positions, so a
 * hit still reports the line it is really on.
 *
 * `//` is only treated as a comment when it is not preceded by `:` — otherwise
 * every `https://` in a string would swallow the rest of its line, and a device
 * size hiding after one would go unreported.
 */
function stripComments(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blanked
    .split('\n')
    .map((line) => {
      const at = line.search(/(?<!:)\/\//);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

const violations = [];
let scanned = 0;
let marked = 0;

for (const abs of files(srcDir)) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (!isScanned(rel)) continue;
  scanned += 1;

  const raw = readFileSync(abs, 'utf8').split('\n');
  const code = stripComments(raw.join('\n')).split('\n');

  for (let i = 0; i < code.length; i += 1) {
    if (!DEVICE_SIZE_RE.test(code[i])) continue;
    const here = raw[i] ?? '';
    const above = raw[i - 1] ?? '';
    if (here.includes(MARKER) || above.includes(MARKER)) {
      marked += 1;
      continue;
    }
    violations.push(`${rel}:${i + 1}  ${here.trim()}`);
  }
}

console.log('');
if (violations.length > 0) {
  console.error(
    `[invariants] Invariant 5 (no hardcoded device sizes): ${violations.length} unexplained literal(s).\n`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    [
      '',
      '640 is one device: a Kraken Z is 320 and a Kraken (2023) is 240. Read the',
      'number from `Geometry` (`window.nzxt.v1`) instead of writing it down.',
      '',
      'If it genuinely is not a panel dimension, say so on the line or the one above:',
      '',
      `    // ${MARKER}: <why this is not a panel dimension>`,
      '',
      'See CONTRIBUTING.md "The platform invariants", row 5.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `[invariants] ok  Invariant 5 (no hardcoded device sizes) — ${String(scanned)} files scanned, ` +
    `${String(marked)} documented exception(s), 0 violations.`,
);
console.log('');
