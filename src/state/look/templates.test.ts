import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateClock } from '../../modules/clock/schema';
import { matchPreset } from '../../modules/effect/catalog';
import { validateEffect } from '../../modules/effect/schema';
import { validateImageConfig } from '../../modules/image/schema';
import { validateShape } from '../../modules/shape/schema';
import { validateStatsConfig } from '../../modules/stats/schema';
import { validateText } from '../../modules/text/schema';
import { validateVideoConfig } from '../../modules/video/types';
import { SCHEMA_VERSION } from '../schema';

import { parseLookFile, serializeLookFile, type LookFile } from './file';
import { LOOK_TEMPLATES, TEMPLATE_AUTHOR, templateById } from './templates';
import { MAX_LAYERS, MAX_LOOK_BYTES, lookBytes } from './types';
import { validateLook } from './validate';

/** The repo root, from this file. */
const ROOT = new URL('../../../', import.meta.url).pathname;
/**
 * The gallery folder is under `public/` because that is the only directory Vite
 * copies next to the built page: the app fetches `looks/index.json` relative to
 * the document, so the files have to be served at `<base>/looks/…` for the
 * Gallery to be anything other than the honest "not in this build" card.
 */
const LOOKS_DIR = join(ROOT, 'public', 'looks');

/**
 * Every module's validator, by the kind whose config it shapes.
 *
 * The table is the drift guard's whole mechanism: a new base or overlay kind in
 * a template with no entry here fails the "every kind is covered" test, so a
 * template can never carry a config nobody checks.
 */
const VALIDATORS: Record<string, (raw: unknown) => unknown> = {
  clock: validateClock,
  effect: validateEffect,
  image: validateImageConfig,
  shape: validateShape,
  stats: validateStatsConfig,
  text: validateText,
  video: validateVideoConfig,
};

/** Every config a template carries, base and overlay, with a label for the failure message. */
function configsOf(
  t: (typeof LOOK_TEMPLATES)[number],
): { where: string; kind: string; cfg: unknown }[] {
  const out: { where: string; kind: string; cfg: unknown }[] = [];
  for (const [kind, cfg] of Object.entries(t.file.configs)) {
    out.push({ where: `${t.id} base ${kind}`, kind, cfg });
  }
  for (const layer of t.file.look.layers.slice(1)) {
    out.push({
      where: `${t.id} layer ${layer.id} (${layer.kind})`,
      kind: layer.kind,
      cfg: layer.cfg,
    });
  }
  return out;
}

describe('the shipped templates', () => {
  it('meets the parity floor of eight', () => {
    expect(LOOK_TEMPLATES.length).toBeGreaterThanOrEqual(8);
  });

  it('has stable, unique, tpl-prefixed ids', () => {
    const ids = LOOK_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^tpl-[a-z0-9-]+$/);
    expect(templateById('tpl-single')?.file.name).toBe('Single');
    expect(templateById('tpl-nothing')).toBeNull();
  });

  it('carries the same author and the format the app writes', () => {
    for (const t of LOOK_TEMPLATES) {
      expect(t.file.author).toBe(TEMPLATE_AUTHOR);
      expect(t.file.version).toBe(SCHEMA_VERSION);
      expect(t.file.name).not.toBe('');
      expect(t.file.description).toBeTruthy();
      // One line, and a sentence rather than a label.
      expect(t.file.description ?? '').not.toContain('\n');
      expect((t.file.description ?? '').length).toBeLessThanOrEqual(120);
    }
  });

  it('ships no media, so no template can rot with a link', () => {
    for (const t of LOOK_TEMPLATES) expect(t.file.media).toEqual([]);
  });

  it.each(LOOK_TEMPLATES.map((t) => [t.id, t] as const))('%s parses with zero notes', (_id, t) => {
    const parsed = parseLookFile(serializeLookFile(t.file));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.notes).toEqual([]);
    // …and survives the trip unchanged, byte for byte.
    expect(serializeLookFile(parsed.file)).toBe(serializeLookFile(t.file));
  });

  it.each(LOOK_TEMPLATES.map((t) => [t.id, t] as const))('%s fits the wire', (_id, t) => {
    expect(t.file.look.layers.length).toBeLessThanOrEqual(MAX_LAYERS);
    expect(t.file.look.layers.length).toBeGreaterThanOrEqual(1);
    expect(lookBytes(t.file.look)).toBeLessThanOrEqual(MAX_LOOK_BYTES);
    expect(validateLook(t.file.look).notes).toEqual([]);
  });
});

/**
 * The drift guard.
 *
 * A template's config is PARTIAL by design (see the file header): it names the
 * settings the template is about and lets each module's `validate()` fill the
 * rest. So the assertion is not "validate returns the same object" — it is
 * "validate did not change a single thing the template asked for". A layout
 * that gets renamed, a preset that stops being legal for its effect, a hex in
 * the wrong case: each one is a coerced field, and each one fails here with the
 * template's name in the message.
 */
describe('template configs survive their module validators', () => {
  it('covers every kind a template uses', () => {
    const uncovered = LOOK_TEMPLATES.flatMap(configsOf)
      .filter(({ kind }) => !Object.hasOwn(VALIDATORS, kind))
      .map(({ where }) => where);
    expect(uncovered).toEqual([]);
  });

  it.each(LOOK_TEMPLATES.map((t) => [t.id, t] as const))('%s is unchanged', (_id, t) => {
    const coerced: string[] = [];
    for (const { where, kind, cfg } of configsOf(t)) {
      const validate = VALIDATORS[kind];
      if (validate === undefined) continue;
      const validated = validate(cfg) as Record<string, unknown>;
      const asked = cfg as Record<string, unknown>;
      for (const key of Object.keys(asked)) {
        if (JSON.stringify(validated[key]) !== JSON.stringify(asked[key])) {
          coerced.push(
            `${where}.${key}: asked ${JSON.stringify(asked[key])}, got ${JSON.stringify(validated[key])}`,
          );
        }
      }
      // Idempotent too, which is what the registry asserts of every module.
      if (JSON.stringify(validate(validated)) !== JSON.stringify(validated)) {
        coerced.push(`${where}: not idempotent`);
      }
    }
    expect(coerced).toEqual([]);
  });

  it('borrows real palettes: every effect colour set IS the preset it names', () => {
    const wrong = LOOK_TEMPLATES.flatMap(configsOf)
      .filter(({ kind }) => kind === 'effect')
      .filter(({ cfg }) => {
        const e = validateEffect(cfg);
        return matchPreset(e.effect, e.colors) !== e.preset;
      })
      .map(({ where }) => where);
    expect(wrong).toEqual([]);
  });
});

/**
 * The gallery's data, checked against the app's.
 *
 * `public/looks/` is the curated gallery (§9) and it is also, unavoidably, a second
 * copy of the templates: the app renders them from `templates.ts` and a
 * contributor reads them as files. A copy nobody checks drifts, so this is the
 * check — and it is a byte comparison rather than a deep-equal, because the
 * files are diffed in pull requests and a re-serialisation that changed the
 * bytes would bury a real edit.
 */
describe('public/looks/ on disk', () => {
  const files = readdirSync(LOOKS_DIR);
  const krakenlooks = files.filter((f) => f.endsWith('.krakenlook')).sort();

  it.each(LOOK_TEMPLATES.map((t) => [t.id, t] as const))(
    'public/looks/%s.krakenlook is the template, byte for byte',
    (id, t) => {
      const text = readFileSync(join(LOOKS_DIR, `${id}.krakenlook`), 'utf8');
      expect(text).toBe(serializeLookFile(t.file));
    },
  );

  it('holds exactly the templates — no orphans, no missing files', () => {
    expect(krakenlooks).toEqual(LOOK_TEMPLATES.map((t) => `${t.id}.krakenlook`).sort());
  });

  it('has an index that lists exactly the files present', () => {
    const raw: unknown = JSON.parse(readFileSync(join(LOOKS_DIR, 'index.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    const index = raw as {
      id: string;
      name: string;
      author: string;
      description: string;
      file: string;
    }[];
    expect(index.map((e) => e.file).sort()).toEqual(krakenlooks);
    expect(index).toEqual(
      index.map((entry) => {
        const t = templateById(entry.id);
        return {
          id: entry.id,
          name: t?.file.name,
          author: t?.file.author,
          description: t?.file.description,
          file: `${entry.id}.krakenlook`,
        };
      }),
    );
  });

  it('every file on disk is a look file this build can read', () => {
    const bad = krakenlooks.filter((name) => {
      const parsed = parseLookFile(readFileSync(join(LOOKS_DIR, name), 'utf8'));
      if (!parsed.ok) return true;
      const file: LookFile = parsed.file;
      return parsed.notes.length > 0 || !file.author || !file.description;
    });
    expect(bad).toEqual([]);
  });

  it('carries the contributor guide next to the data', () => {
    expect(files).toContain('README.md');
  });
});
