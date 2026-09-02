import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEVICE_PRESETS } from '../platform/devicePresets';

import {
  CAM_FRAME_RATE_INSTRUCTION,
  CAM_FRAME_RATE_LEAD,
  CAM_FRAME_RATE_LEAD_SENTENCE,
  CAM_FRAME_RATE_TAIL,
  CAM_PATH_CONFIGURE,
  CAM_PATH_FRAME_RATE,
  fpsAdvisoryBody,
} from './camPaths';

/**
 * The instruction is exported in pieces so JSX can bold the path, and as one
 * string for surfaces that build plain text. Two spellings of one sentence is
 * exactly the drift this file exists to end, so the pieces are pinned to the
 * whole.
 */
describe('the CAM frame-rate instruction', () => {
  it('composes from its own parts', () => {
    expect(`${CAM_FRAME_RATE_LEAD} ${CAM_PATH_FRAME_RATE} ${CAM_FRAME_RATE_TAIL}`).toBe(
      CAM_FRAME_RATE_INSTRUCTION,
    );
  });

  it('names the maximum for the panel actually attached, never Elite’s', () => {
    // The number the copy used to hardcode, and the two panels it was wrong for.
    expect(fpsAdvisoryBody(DEVICE_PRESETS.elite.targetFps)).toContain('40 FPS on this panel');
    expect(fpsAdvisoryBody(DEVICE_PRESETS.z.targetFps)).toContain('1 FPS on this panel');
    expect(fpsAdvisoryBody(DEVICE_PRESETS.kraken2023.targetFps)).toContain('25 FPS on this panel');
    expect(fpsAdvisoryBody(DEVICE_PRESETS.z.targetFps)).not.toContain('Elite');
  });

  it('says nothing about a ceiling it cannot name', () => {
    for (const unknown of [null, 0, Number.NaN]) {
      const body = fpsAdvisoryBody(unknown);
      expect(body).toBe(`${CAM_FRAME_RATE_INSTRUCTION}.`);
      expect(body).not.toContain('FPS');
    }
  });

  it('always carries the one spelling of the path', () => {
    expect(fpsAdvisoryBody(40)).toContain(CAM_PATH_FRAME_RATE);
  });

  /*
   * Round 13, M2. The instruction is used two ways: as the tail of a longer
   * sentence (About, CamSetupCard — *"Point CAM at this page, then drag …"*)
   * and as a paragraph of its own (the display's advisory card, the config
   * home banner). It shipped only in the first form, so the paragraph surfaces
   * started on a lowercase verb, which §6.3 named as a defect. One function
   * owns both, and the two differ in exactly one character.
   */
  describe('and the sentence-start variant', () => {
    it('capitalises the verb and nothing else', () => {
      const mid = fpsAdvisoryBody(40);
      const start = fpsAdvisoryBody(40, { leadIn: true });
      expect(start.charAt(0)).toBe(CAM_FRAME_RATE_LEAD.charAt(0).toUpperCase());
      expect(start.slice(1)).toBe(mid.slice(1));
      expect(start).toBe(
        `${CAM_FRAME_RATE_LEAD_SENTENCE} ${CAM_PATH_FRAME_RATE} to maximum (40 FPS on this panel).`,
      );
    });

    it('is still the same instruction, path and ceiling included', () => {
      const start = fpsAdvisoryBody(25, { leadIn: true });
      expect(start).toContain(CAM_PATH_FRAME_RATE);
      expect(start).toContain(CAM_FRAME_RATE_TAIL);
      expect(start).toContain('25 FPS on this panel');
    });

    it('leaves the mid-sentence form lowercase, for the surfaces that continue a sentence', () => {
      expect(fpsAdvisoryBody(40).startsWith(CAM_FRAME_RATE_LEAD)).toBe(true);
      expect(CAM_FRAME_RATE_LEAD.charAt(0)).toBe(CAM_FRAME_RATE_LEAD.charAt(0).toLowerCase());
    });

    it('derives the capitalised verb rather than retyping it', () => {
      expect(CAM_FRAME_RATE_LEAD_SENTENCE.toLowerCase()).toBe(CAM_FRAME_RATE_LEAD.toLowerCase());
      expect(CAM_FRAME_RATE_LEAD_SENTENCE).not.toBe(CAM_FRAME_RATE_LEAD);
    });
  });
});

// ---------------------------------------------------------------------------
// The class assertion (round 4, F6)
// ---------------------------------------------------------------------------

/**
 * Round 2 replaced five spellings with two constants and pinned the two
 * constants to each other. Round 4 found the sixth spelling still shipping — on
 * the LCD, in `modules/image/display.ts`, in a file that **imports
 * `CAM_PATH_CONFIGURE` twelve lines further up**. Pinning the constants was
 * never the rule; the rule is that a menu route may not be typed out at all.
 *
 * So this greps the source tree, with comments stripped, for anything that
 * looks like a CAM menu route — the arrow, or either constant's tail — and
 * fails on any file that is not `camPaths.ts`. A surface that needs the path
 * imports it, which is the only way to be sure it is the current one.
 */
const SRC = new URL('..', import.meta.url).pathname;

/** The definition, this test, and the docs' own prose are the exceptions. */
const PATH_ALLOWED = new Set(['config/camPaths.ts', 'config/camPaths.test.ts']);

/**
 * A menu route, as it looks in text.
 *
 * A bare arrow is not enough — Windows' own SmartScreen dialog reads *"More
 * info → Run anyway"* and a right-click hint reads *"the picture → Copy image
 * address"*, and neither is a CAM route. What identifies one is the arrow
 * ADJACENT to a CAM landmark: the app's name at the head, or either
 * destination at the tail, or the menu level both routes pass through.
 */
const PATH_LIKE: readonly RegExp[] = [
  /\bCAM\s*→/,
  /→\s*Configure\b/,
  /→\s*Frame Rate\b/,
  /\bWeb Integration\b/,
];

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

function walk(dir: string, rel = ''): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const here = rel === '' ? name : `${rel}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, here));
    else if (/\.tsx?$/.test(name))
      out.push({ rel: here, text: stripComments(readFileSync(abs, 'utf8')) });
  }
  return out;
}

const SOURCES = walk(SRC).filter((f) => !PATH_ALLOWED.has(f.rel));

describe('nobody types a CAM menu route', () => {
  it('finds source files to check at all', () => {
    // A walk that silently found nothing would make the rule below vacuous.
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it('pins both constants, so neither can drift', () => {
    expect(CAM_PATH_FRAME_RATE).toBe('CAM → Lighting → your Kraken → Web Integration → Frame Rate');
    expect(CAM_PATH_CONFIGURE).toBe(
      'CAM → Lighting → your Kraken → your kraken-hub card → Configure',
    );
  });

  for (const pattern of PATH_LIKE) {
    it(`no literal matching ${pattern.source} survives outside camPaths.ts`, () => {
      const offenders = SOURCES.filter((f) => pattern.test(f.text)).map((f) => f.rel);
      expect(offenders, 'import CAM_PATH_* from src/config/camPaths.ts instead').toEqual([]);
    });
  }
});
