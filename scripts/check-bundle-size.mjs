#!/usr/bin/env node
/**
 * Bundle budget gate + the invariant-I8 display-graph gate.
 *
 * Reads `dist/.vite/manifest.json`, gzips every emitted JS chunk, groups the
 * chunks into the budget categories declared in `budgets.json`, prints a table
 * (also appended to $GITHUB_STEP_SUMMARY in CI) and exits 1 on any breach.
 *
 * The budget that actually matters is `displayCriticalPath`: what the hidden
 * Kraken Browser must download before the LCD shows anything.
 *
 * The *check* that matters even more is `displayGraph` (invariant I8): the
 * budget alone cannot catch a config-UI leak, because a chunk that is not named
 * in `displayCriticalPath.chunks` is not weighed even when the display entry
 * statically imports it. So we walk the manifest's import graph transitively
 * from the display roots and fail on any reached chunk that contains a module
 * from `src/ui/` or `src/app/config/`.
 *
 * Usage: npm run build && npm run size
 */
import { readFileSync, readdirSync, statSync, appendFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const manifestPath = join(distDir, '.vite', 'manifest.json');
const KB = 1024;
const MB = 1024 * 1024;

if (!existsSync(manifestPath)) {
  console.error(
    `[size] ${manifestPath} not found.\n[size] Run \`npm run build\` first (build.manifest must be true in vite.config.ts).`,
  );
  process.exit(1);
}

const budgets = JSON.parse(readFileSync(join(root, 'budgets.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/**
 * `assets/vendor-react-D3aF1xQ_.js` → `vendor-react`.
 *
 * The manifest usually carries the logical name outright; the regex is only the
 * fallback, and deliberately excludes `-` from the hash character class so that
 * a hyphenated chunk name is not eaten from the right.
 */
function logicalName(file, name) {
  if (typeof name === 'string' && name.length > 0) return name;
  const base = basename(file, extname(file));
  return base.replace(/-[A-Za-z0-9_$]{8,}$/, '');
}

function gzipKb(file) {
  return gzipSync(readFileSync(join(distDir, file)), { level: 9 }).length / KB;
}

// Collect every JS chunk the manifest knows about, de-duplicated by file path.
const chunks = new Map();
for (const entry of Object.values(manifest)) {
  const file = entry?.file;
  if (typeof file !== 'string' || !file.endsWith('.js')) continue;
  if (chunks.has(file)) continue;
  chunks.set(file, { file, name: logicalName(file, entry?.name), gzipKb: gzipKb(file) });
}

/**
 * Every source module baked into a chunk, from its sourcemap, normalised to
 * repo-relative POSIX paths (`../../src/ui/index.tsx` → `src/ui/index.tsx`).
 * Returns null when the chunk has no sourcemap — the caller then falls back to
 * matching on the chunk's logical name.
 */
function modulesOf(file) {
  const mapPath = join(distDir, `${file}.map`);
  if (!existsSync(mapPath)) return null;
  try {
    const sources = JSON.parse(readFileSync(mapPath, 'utf8')).sources;
    if (!Array.isArray(sources)) return null;
    return sources.map((s) =>
      String(s)
        .replace(/\\/g, '/')
        .replace(/^(?:\.\.\/|\.\/)+/, ''),
    );
  } catch {
    return null;
  }
}

/**
 * Invariant I8: nothing from `src/ui/` or `src/app/config/` may be reachable
 * from the display entry.
 *
 * Static imports are followed everywhere — they are what the Kraken Browser
 * downloads before it renders. Dynamic imports are followed only out of
 * display-owned chunks: `index` lazily importing `config-ui` IS the mode split,
 * and the shared `core` chunk lazily importing a module's config panel is how
 * panels stay off the LCD. A *display* chunk lazily importing the config UI is
 * still a violation, because it still ships config code to the LCD build path.
 */
function checkDisplayGraph() {
  const cfg = budgets.displayGraph;
  if (!cfg) return null;
  const forbidden = cfg.forbidden ?? [];

  // Manifest keys are hashed (`_display-shell-DaKUjvUY.js`), so resolve by the
  // logical chunk name and never by the key or the emitted filename.
  const byKey = new Map();
  for (const [key, entry] of Object.entries(manifest)) {
    if (typeof entry?.file !== 'string' || !entry.file.endsWith('.js')) continue;
    byKey.set(key, { key, entry, name: logicalName(entry.file, entry.name) });
  }

  const roots = [];
  for (const wanted of cfg.roots) {
    const hit = [...byKey.values()].filter((c) => c.name === wanted);
    if (hit.length === 0) {
      return { ok: false, detail: `display root chunk "${wanted}" is not in the manifest` };
    }
    roots.push(...hit);
  }

  const visited = new Set();
  const violations = [];
  const queue = [...roots];

  while (queue.length > 0) {
    const node = queue.shift();
    if (visited.has(node.key)) continue;
    visited.add(node.key);

    const modules = modulesOf(node.entry.file);
    for (const bad of forbidden) {
      const hits = modules
        ? modules.filter((m) => m.includes(bad))
        : // No sourcemap: fall back to the chunk name the vite groups assign.
          /^config(-|$)/.test(node.name)
          ? [`${node.name} (by chunk name; no sourcemap)`]
          : [];
      if (hits.length > 0) {
        violations.push(
          `${node.name} (${node.entry.file}) contains ${hits.slice(0, 3).join(', ')}`,
        );
      }
    }

    const displayOwned = modules?.some((m) => m.includes('src/app/display/')) ?? false;
    const edges = [
      ...(node.entry.imports ?? []),
      ...(displayOwned ? (node.entry.dynamicImports ?? []) : []),
    ];
    for (const key of edges) {
      const next = byKey.get(key);
      if (next) queue.push(next);
    }
  }

  const reached = [...visited].map((k) => byKey.get(k).name).sort();
  return violations.length > 0
    ? { ok: false, detail: violations.join(' | ') }
    : { ok: true, detail: `reached: ${reached.join(', ')}` };
}

function walk(dir) {
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    bytes += s.isDirectory() ? walk(p) : s.size;
  }
  return bytes;
}

const rows = [];
let failed = false;

function record(label, actual, limit, unit, detail) {
  const ok = actual <= limit;
  if (!ok) failed = true;
  rows.push({
    ok,
    label,
    actual: `${actual.toFixed(actual < 10 ? 2 : 1)} ${unit}`,
    limit: `${limit} ${unit}`,
    detail: detail ?? '',
  });
}

// --- displayCriticalPath: the sum of the named chunks -----------------------
{
  const wanted = budgets.displayCriticalPath.chunks;
  const present = [...chunks.values()].filter((c) => wanted.includes(c.name));
  const missing = wanted.filter((w) => !present.some((c) => c.name === w));
  const total = present.reduce((n, c) => n + c.gzipKb, 0);
  record(
    'displayCriticalPath',
    total,
    budgets.displayCriticalPath.gzipKb,
    'kB gzip',
    [
      present.length ? present.map((c) => c.name).join(' + ') : 'nothing matched',
      missing.length ? `(not emitted yet: ${missing.join(', ')})` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

// --- displayGraph: invariant I8, enforced on the built graph -----------------
{
  const result = checkDisplayGraph();
  if (result !== null) {
    if (!result.ok) failed = true;
    rows.push({
      ok: result.ok,
      label: 'displayGraph (I8)',
      actual: result.ok ? 'clean' : 'LEAK',
      limit: 'no src/ui, src/app/config',
      detail: result.detail,
    });
  }
}

// --- per-chunk category budgets --------------------------------------------
const categories = [
  ['perModuleChunk', /^module-/, budgets.perModuleChunk],
  ['perProviderChunk', /^provider-/, budgets.perProviderChunk],
  ['configUi', /^config(-|$)/, budgets.configUi],
  ['syncMqtt', /mqtt/i, budgets.syncMqtt],
];

for (const [label, pattern, budget] of categories) {
  const base = budget?.gzipKb;
  if (typeof base !== 'number') continue;
  const matched = [...chunks.values()].filter((c) => pattern.test(c.name));
  if (matched.length === 0) {
    rows.push({
      ok: true,
      label,
      actual: '—',
      limit: `${base} kB gzip`,
      detail: 'no such chunk yet',
    });
    continue;
  }
  for (const c of matched) {
    /*
     * A per-chunk override exists for exactly one reason: a chunk whose weight
     * is a THIRD-PARTY LIBRARY, where the number is a fact about hls.js or
     * dash.js rather than about our code. The base limit still governs every
     * chunk we actually write, and none of these are on the display critical
     * path — they are lazily imported and only ever fetched when a URL of that
     * kind is played.
     */
    const override = budget.overrides?.[c.name];
    const limit = typeof override === 'number' ? override : base;
    const note = typeof override === 'number' ? `${c.file} (vendored-library override)` : c.file;
    record(`${label}: ${c.name}`, c.gzipKb, limit, 'kB gzip', note);
  }
}

// --- total dist size --------------------------------------------------------
record('totalDist', walk(distDir) / MB, budgets.totalDistMb.mb, 'MB', 'includes sourcemaps');

// --- output -----------------------------------------------------------------
const header = ['', 'Budget', 'Actual', 'Limit', 'Notes'];
const table = rows.map((r) => [r.ok ? 'ok' : 'OVER', r.label, r.actual, r.limit, r.detail]);
const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const line = (cells) =>
  cells
    .map((c, i) => c.padEnd(widths[i]))
    .join('  ')
    .trimEnd();

console.log('');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const row of table) console.log(line(row));
console.log('');

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  const md = [
    '### Bundle budgets',
    '',
    `| | Budget | Actual | Limit | Notes |`,
    `|---|---|---|---|---|`,
    ...table.map(
      (r) => `| ${r[0] === 'ok' ? '✅' : '❌'} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`,
    ),
    '',
  ].join('\n');
  appendFileSync(summaryFile, md);
}

if (failed) {
  console.error(
    '[size] Bundle budget or invariant I8 violated. See docs/design/design-ossDx.md §4.4.',
  );
  process.exit(1);
}
console.log('[size] All bundle budgets respected.');
