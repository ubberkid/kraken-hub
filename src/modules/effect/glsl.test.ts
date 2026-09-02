import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRAGMENT_LOADERS, loadFragment } from './effects';
import { EFFECT_COLOUR_SLOTS, EFFECT_IDS, MAX_COLOUR_SLOTS } from './schema';

/**
 * The uniform contract, checked from BOTH ends.
 *
 * `docs/design/effects-ports/PORTS.md` states it once as prose; twelve files
 * declare it and one file sets it. The failure this suite exists for is silent:
 * a fragment source that declares a uniform nobody writes renders with a zero in
 * it — a black effect, or a still one — and a runner that writes a uniform
 * nobody declares gets `null` back from `getUniformLocation` and no error at
 * all. Neither shows up as an exception, on a panel nobody is looking at.
 */
const displaySource = readFileSync(fileURLToPath(new URL('./display.ts', import.meta.url)), 'utf8');

/** Every `uniform` declared by a fragment source, in declaration order. */
function declaredUniforms(frag: string): string[] {
  return [...frag.matchAll(/\buniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1] ?? '');
}

/** The scalar uniforms `display.ts` actually looks up. */
function runnerUniforms(): string[] {
  const found = [...displaySource.matchAll(/getUniformLocation\(prog,\s*'(\w+)'\)/g)].map(
    (m) => m[1] ?? '',
  );
  // The colour slots are looked up in a loop, by index.
  if (/getUniformLocation\(prog,\s*`uColor\$\{String\(i\)\}`\)/.test(displaySource)) {
    for (let i = 0; i < MAX_COLOUR_SLOTS; i += 1) found.push(`uColor${String(i)}`);
  }
  return found;
}

describe('the runner and the sources agree on the uniforms', () => {
  const RUNNER = runnerUniforms();

  it('finds the runner uniforms at all — the regex is load-bearing', () => {
    expect(RUNNER).toContain('uTime');
    expect(RUNNER).toContain('uColor0');
    expect(RUNNER.length).toBeGreaterThan(MAX_COLOUR_SLOTS);
  });

  it('registers a loader for every id, and only those', () => {
    expect(Object.keys(FRAGMENT_LOADERS).sort()).toEqual([...EFFECT_IDS].sort());
  });

  it.each(EFFECT_IDS)('%s declares exactly what the runner sets', async (id) => {
    const frag = await loadFragment(id);
    const declared = declaredUniforms(frag);
    const expected = ['uTime', 'uResolution', 'uTemp', 'uScale', 'uBright'];
    for (let i = 0; i < EFFECT_COLOUR_SLOTS[id]; i += 1) expected.push(`uColor${String(i)}`);

    expect([...declared].sort()).toEqual([...expected].sort());
    // …and every one of them is something the runner writes.
    for (const name of declared) expect(RUNNER).toContain(name);
  });

  it.each(EFFECT_IDS)('%s declares each uniform exactly once', async (id) => {
    const declared = declaredUniforms(await loadFragment(id));
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe('every fragment source is shaped like the others', () => {
  it.each(EFFECT_IDS)('%s opens with the version pragma and one output', async (id) => {
    const frag = await loadFragment(id);
    // The WebGL1 fallback strips exactly these two tokens; if either moves, the
    // downgrade silently produces a source that will not compile on WebGL1.
    expect(frag.startsWith('#version 300 es\n')).toBe(true);
    expect(frag).toContain('out vec4 o;');
    expect(frag.split('out vec4 o;').length - 1).toBe(1);
  });

  it.each(EFFECT_IDS)('%s reads its coordinates through khCoord()', async (id) => {
    const frag = await loadFragment(id);
    // Anything reading `gl_FragCoord` directly would ignore the scale control
    // AND zoom about the bottom-left corner instead of the centre.
    expect(frag).toContain('vec2 khCoord()');
    const helper = 'vec2 khCoord() { return (gl_FragCoord.xy - 0.5 * uResolution)';
    expect(frag.replace(helper, '')).not.toContain('gl_FragCoord');
  });

  it.each(EFFECT_IDS)('%s ends by multiplying the frame by uBright', async (id) => {
    expect(await loadFragment(id)).toContain(', uTemp) * uBright, 1.0);');
  });

  it.each(EFFECT_IDS)('%s carries no comments and no device-size literal', async (id) => {
    const frag = await loadFragment(id);
    // Comments are stripped at authoring time: they are ~40 % of the ports and
    // every byte of them would be downloaded by the panel.
    expect(frag).not.toContain('//');
    expect(frag).not.toContain('/*');
    // Invariant 5, inside a string the invariants script cannot read as code.
    expect(frag).not.toMatch(/\b(?:640|320|240)\b/);
  });

  it('keeps each source small enough to be worth its own chunk', async () => {
    const MAX_BYTES = 4096;
    for (const id of EFFECT_IDS) {
      expect((await loadFragment(id)).length).toBeLessThan(MAX_BYTES);
    }
  });
});
