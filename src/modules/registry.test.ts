import { describe, expect, it } from 'vitest';

import { MODULE_ID_PATTERN } from './defineModule';
import { DEFAULT_MODULE_ID, MODULES, getModule, resolveModule } from './registry';

const MAX_DEFAULTS_BYTES = 4096;

/**
 * Conformance suite — runs over every registered module automatically, so a
 * contributor who adds one gets these guarantees without writing a test.
 */
describe('module registry', () => {
  it('registers the default module', () => {
    expect(getModule(DEFAULT_MODULE_ID)).not.toBeNull();
    expect(resolveModule('no-such-module').id).toBe(DEFAULT_MODULE_ID);
  });

  it.each(MODULES.map((m) => [m.id, m] as const))('%s conforms', (_id, mod) => {
    expect(mod.id).toMatch(MODULE_ID_PATTERN);
    expect(mod.name.length).toBeGreaterThan(0);
    expect(mod.summary.length).toBeGreaterThan(0);
    expect(mod.icon.length).toBeGreaterThan(0);
    expect(mod.configVersion).toBeGreaterThanOrEqual(1);
    // configVersion > 1 requires a migration path; v1 modules must not need one.
    expect(mod.configVersion > 1 ? typeof mod.migrateConfig : 'function').toBe('function');

    // validate() is idempotent on its own defaults.
    expect(mod.validate(mod.defaults)).toEqual(mod.defaults);
    expect(mod.validate(mod.validate(mod.defaults))).toEqual(mod.defaults);

    // validate() never throws, whatever garbage storage hands it.
    for (const junk of [undefined, null, 0, '', [], {}, { deeply: { wrong: [1, 2] } }]) {
      expect(() => mod.validate(junk)).not.toThrow();
    }

    expect(JSON.stringify(mod.defaults).length).toBeLessThan(MAX_DEFAULTS_BYTES);
  });

  it('has unique ids', () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
