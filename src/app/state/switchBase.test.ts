import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_MODULE_ID } from '../../modules/registry';
import { baseLook, IDENTITY, type Look } from '../../state/look/types';

import { withBaseKind } from './switchBase';

import type { AppState } from '../../state/schema';

/**
 * The class assertion behind the base-kind write path.
 *
 * `activeModuleId` and `look.layers[0].kind` are two spellings of one fact, and
 * the validator currently rewrites the second from the first (§4.2). A commit
 * that sets only one of them is therefore either wrong now or wrong the moment
 * the mirror retires — and there were twenty-one places making that commit.
 *
 * Fixing them once buys one wave. So the rule is mechanical, in the shape
 * `config/vocabulary.test.ts` established: nothing under `src/app/**` may write
 * `activeModuleId` at all. The only legal appearances are a TYPE — a parameter
 * or a prop declared `activeModuleId: string` — and the helper itself.
 */

const APP = new URL('..', import.meta.url).pathname;

/** The helper is the one place allowed to write the field. */
const ALLOWED = new Set(['state/switchBase.ts']);

/**
 * Commentary is exempt, for the same reason the vocabulary spine exempts it:
 * the rule is about what the CODE does, and a comment explaining why the field
 * is written in exactly one place has to be able to name the field.
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
      continue;
    }
    /*
     * Tests are exempt, and only tests.
     *
     * A fixture that says `{ ...defaultAppState(), activeModuleId: 'image' }`
     * is DESCRIBING a stored document — including, deliberately, documents no
     * commit in this app would ever produce, which is most of what a validator
     * test is for. The rule is about commits, and a test makes none.
     */
    if (/\.test\.tsx?$/.test(name)) continue;
    if (/\.tsx?$/.test(name)) {
      out.push({ rel: here, text: withoutComments(readFileSync(abs, 'utf8')) });
    }
  }
  return out;
}

/**
 * `activeModuleId:` in any position other than a type annotation.
 *
 * `activeModuleId: string` is a parameter or a prop — a READ path, and those
 * are fine and numerous. Anything else (`activeModuleId: videoModule.id`,
 * `activeModuleId: m.id`, `activeModuleId: openModule`) is a write.
 */
const WRITE_RE = /activeModuleId\s*:(?!\s*string\b)/;

const FILES = sourceFiles(APP);

describe('there is one write path for the base kind', () => {
  it('finds source files to check at all', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it.each(FILES.map((f) => [f.rel, f.text] as const))(
    '%s writes activeModuleId only through withBaseKind',
    (rel, text) => {
      if (ALLOWED.has(rel)) return;
      const offending = text
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => WRITE_RE.test(line));
      expect(
        offending.map(([n, line]) => `${rel}:${String(n)} ${line.trim()}`),
        `${rel} writes activeModuleId directly — use withBaseKind() from src/app/state/switchBase.ts`,
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// …and the helper itself does both halves
// ---------------------------------------------------------------------------

function stateWith(look: Look): AppState {
  return { look, modules: {}, activeModuleId: look.layers[0]?.kind ?? '' } as unknown as AppState;
}

describe('withBaseKind', () => {
  it('writes the look and the mirrored field in one commit', () => {
    const next = withBaseKind(stateWith(baseLook('clock')), 'video');
    expect(next.look.layers[0]?.kind).toBe('video');
    expect(next.activeModuleId).toBe('video');
  });

  it('keeps the overlays standing, which is the difference from starting again', () => {
    const before = stateWith({
      layers: [
        ...baseLook('video').layers,
        {
          id: 'lclock01',
          kind: 'clock',
          on: true,
          frame: { w: 1, h: 0.5, shape: 'square' },
          t: { ...IDENTITY, y: 0.55 },
          cfg: {},
        },
      ],
    });
    const after = withBaseKind(before, 'effect');
    expect(after.look.layers.map((l) => l.kind)).toEqual(['effect', 'clock']);
    // The base carries no cfg: it wears the bank (§4.1).
    expect(after.look.layers[0]?.cfg).toBeUndefined();
  });

  it('leaves the default module reachable', () => {
    const next = withBaseKind(stateWith(baseLook('clock')), DEFAULT_MODULE_ID);
    expect(next.activeModuleId).toBe(DEFAULT_MODULE_ID);
    expect(next.look.layers[0]?.kind).toBe(DEFAULT_MODULE_ID);
  });
});
