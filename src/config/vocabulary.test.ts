import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COPY_HOME,
  KEEPING_A_COPY,
  KEEPING_A_COPY_NOW,
  KEEP_A_COPY,
  KEEP_A_COPY_LABEL,
  KEPT_A_COPY,
  RETIRED_PHRASES,
  STREAM_ONLY,
} from './vocabulary';

/**
 * The class assertion behind F7.
 *
 * Round 1 and round 2 each fixed the vocabulary on the screen the audit had
 * photographed, and each time the drift reappeared one file over — round 3
 * found `LibraryView` still saying *"Saving to your Kraken…"*, the exact phrase
 * `HomeView` documents as killed. Fixing the string again would buy one more
 * round.
 *
 * So the rule is mechanical: a term in `vocabulary.ts` may appear in the source
 * tree exactly once — in `vocabulary.ts` — and every surface that says it must
 * import it. A retired spelling may not appear at all. Adding a second literal
 * copy of either is a failing test rather than an audit finding.
 */

const SRC = new URL('..', import.meta.url).pathname;

/** Files that are allowed to hold the literals: the definition, and this test. */
const ALLOWED = new Set(['config/vocabulary.ts', 'config/vocabulary.test.ts']);

/**
 * The file with its commentary removed.
 *
 * The rule is about what the APP says, not about what the code is allowed to
 * discuss: a comment explaining that "Saved locally ✓" was deleted has to be
 * able to name the thing it deleted, and a doc-comment recording why the
 * vocabulary exists is the most useful place the old spelling can appear. What
 * must not survive is a second *rendered* copy.
 */
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

function sourceFiles(dir: string, rel = ''): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const here = rel === '' ? name : `${rel}/${name}`;
    if (statSync(abs).isDirectory()) {
      out.push(...sourceFiles(abs, here));
    } else if (/\.tsx?$/.test(name)) {
      out.push({ rel: here, text: withoutComments(readFileSync(abs, 'utf8')) });
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).filter((f) => !ALLOWED.has(f.rel));

/**
 * The terms every surface must import rather than retype.
 *
 * `KEEP_A_COPY_LABEL` and `COPY_HOME` are deliberately absent: "On this PC" and
 * "on this PC" are substrings of the composed constants above them, and a term
 * that cannot fail independently is a test that only looks like one.
 */
const SINGLE_SOURCE: readonly string[] = [
  KEEP_A_COPY,
  KEEPING_A_COPY,
  STREAM_ONLY,
  KEEPING_A_COPY_NOW,
  KEPT_A_COPY,
];

describe('the app has one vocabulary', () => {
  it('finds source files to check at all', () => {
    // A directory walk that silently found nothing would make every assertion
    // below vacuously true, which is the one way this file could lie.
    expect(FILES.length).toBeGreaterThan(100);
  });

  for (const term of SINGLE_SOURCE) {
    it(`"${term}" is written once, in vocabulary.ts`, () => {
      const offenders = FILES.filter((f) => f.text.includes(term)).map((f) => f.rel);
      expect(offenders, `import it from src/config/vocabulary.ts instead`).toEqual([]);
    });
  }

  for (const dead of RETIRED_PHRASES) {
    it(`"${dead}" is retired and does not come back`, () => {
      const offenders = FILES.filter((f) => f.text.includes(dead)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  it('composes the destination into every phrase that names one', () => {
    expect(KEEPING_A_COPY_NOW).toContain(COPY_HOME);
    expect(KEPT_A_COPY).toContain(COPY_HOME);
    // The row label is the destination, sentence-cased — not a second wording.
    expect(KEEP_A_COPY_LABEL.toLowerCase()).toBe(COPY_HOME.toLowerCase());
  });
});
