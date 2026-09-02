import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MACHINE_NOUNS, RETIRED_PHRASES } from '../../config/vocabulary';

/**
 * The vocabulary spine, applied to the two kinds this wave adds.
 *
 * `src/config/vocabulary.test.ts` already greps the whole tree for the retired
 * spellings, and that is the rule of record. This suite exists because a module
 * is the surface most likely to reintroduce one *by accident*: it is written in
 * its own directory, months after the audit that killed the phrase, by somebody
 * who has never read `vocabulary.ts`. Failing here names the file and the
 * phrase in one line instead of failing a global scan that names neither.
 *
 * It also pins the two other conventions a new panel is most likely to drop:
 * the round-2 control vocabulary (no native picker but the colour well), and
 * invariant 5 (no device dimension written down anywhere).
 */

const MODULE_DIRS = [
  new URL('.', import.meta.url).pathname,
  new URL('../shape/', import.meta.url).pathname,
];

/** Prose only: a comment may name the phrase it removed, a rendered string may not. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

function sources(dir: string): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...sources(abs));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push({ rel: abs.slice(abs.lastIndexOf('/src/') + 1), text: readFileSync(abs, 'utf8') });
  }
  return out;
}

const FILES = MODULE_DIRS.flatMap(sources).map((f) => ({
  rel: f.rel,
  raw: f.text,
  text: withoutComments(f.text),
}));

const PANELS = FILES.filter((f) => f.rel.endsWith('.tsx'));

describe('the two new kinds speak the app’s vocabulary', () => {
  it('finds the files to check at all', () => {
    // A renamed directory would make every assertion below vacuously true —
    // the one way an enumeration quietly stops enumerating.
    expect(FILES.length).toBeGreaterThan(8);
    expect(PANELS.length).toBe(2);
  });

  it.each(RETIRED_PHRASES)('does not bring back "%s"', (dead) => {
    const offenders = FILES.filter((f) => f.text.includes(dead)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it.each(MACHINE_NOUNS)('does not name "%s" — a layer knows nothing about one', (noun) => {
    const offenders = FILES.filter((f) => f.text.includes(noun)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  /**
   * Round 2 removed `Select` and `Toggle` from `src/ui/` outright, because the
   * only version of that rule a codebase can keep is the one where you cannot
   * reach for what is not there. A panel that hand-rolls one puts it back.
   */
  it.each(['<select', 'type="checkbox"', 'type="radio"'])('renders no native %s', (banned) => {
    const offenders = PANELS.filter((f) => f.text.includes(banned)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('reaches for the house slider rather than a bare range input', () => {
    const offenders = PANELS.filter((f) => f.text.includes('type="range"')).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  /**
   * Invariant 5, scoped to the files this wave adds. `scripts/check-invariants.mjs`
   * is the rule of record and it skips `.test.ts` files — this runs in the unit
   * suite, where a contributor sees it before they open a PR.
   */
  it('writes down no panel dimension', () => {
    const offenders = FILES.filter((f) => /\b(?:640|320|240)\b/.test(withoutComments(f.raw))).map(
      (f) => f.rel,
    );
    expect(offenders).toEqual([]);
  });
});
