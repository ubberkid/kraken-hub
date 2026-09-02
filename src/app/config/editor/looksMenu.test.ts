import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOOK_TEMPLATES } from '../../../state/look/templates';

import { lookMenuLabel, normaliseLookName, templateEntries, UNTITLED_LOOK } from './looksMenu';

describe('the Looks menu', () => {
  it('names an unnamed Look rather than showing a blank button', () => {
    expect(lookMenuLabel(null)).toBe(UNTITLED_LOOK);
    expect(lookMenuLabel('   ')).toBe(UNTITLED_LOOK);
    expect(lookMenuLabel(' Slow tide ')).toBe('Slow tide');
  });

  it('treats an empty typed name as no name', () => {
    expect(normaliseLookName('   ')).toBeNull();
    expect(normaliseLookName('Slow tide')).toBe('Slow tide');
  });

  it('shows the Looks the app ships, with the words from the files themselves', () => {
    const entries = templateEntries(LOOK_TEMPLATES);
    expect(entries).toHaveLength(LOOK_TEMPLATES.length);
    expect(entries.every((e) => e.source === 'template')).toBe(true);
    for (const entry of entries) {
      expect(entry.name).not.toBe('');
      expect(entry.summary).not.toBe('');
      expect(entry.file.format).toBe('kraken-hub-look');
    }
  });
});

/**
 * ── The byte-budget rule, as a grep ───────────────────────────────────────────
 *
 * `src/state/look/templates.ts` is ~9 kB of designed Looks and it lives under
 * `src/state/`, which vite's `core` group claims by path — and `core` is what
 * the hidden Kraken Browser downloads before it can paint, with under two
 * kilobytes of headroom against the gate.
 *
 * Two mechanisms keep it off that path and this test pins the half a reviewer
 * can break by accident: **nothing under `src/app` may STATICALLY import the
 * table.** The other half — the `looks` chunk group and the matching lookahead
 * in `core`'s test — is checked by `npm run size`, which fails on the byte count
 * itself.
 *
 * The same shape as the display-graph rule and the vocabulary spine: it finds
 * violations rather than listing them, so a file added next month is covered
 * without anybody remembering to add it.
 */
const APP = new URL('../..', import.meta.url).pathname;

/**
 * The one file allowed to name the module at all — and it does so lazily.
 *
 * Tests are exempt, and only tests, for the reason `switchBase.test.ts` gives:
 * a fixture importing the table is describing DATA, and a test ships nothing.
 */
const ALLOWED = new Set(['config/editor/looksMenu.ts']);

const STATIC_IMPORT = /^\s*import\s[^;]*from\s+['"][^'"]*state\/look\/templates['"]/m;

function sourceFiles(dir: string, rel = ''): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const here = rel === '' ? name : `${rel}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs, here));
    else if (/\.tsx?$/.test(name)) out.push({ rel: here, text: readFileSync(abs, 'utf8') });
  }
  return out;
}

const FILES = sourceFiles(APP);

describe('the templates table stays off the display’s first download', () => {
  it('finds source files to check at all', () => {
    // A walk that silently found nothing would make the rule below vacuous.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('is never imported statically from src/app', () => {
    const offenders = FILES.filter(
      (f) => !ALLOWED.has(f.rel) && !/\.test\.tsx?$/.test(f.rel) && STATIC_IMPORT.test(f.text),
    ).map((f) => f.rel);
    expect(
      offenders,
      'use `await import(...)` — see looksMenu.loadTemplates and the `looks` chunk group',
    ).toEqual([]);
  });

  it('reaches the table through a dynamic import, in one place', () => {
    const menu = FILES.find((f) => f.rel === 'config/editor/looksMenu.ts');
    expect(menu?.text).toContain("await import('../../../state/look/templates')");
  });
});
