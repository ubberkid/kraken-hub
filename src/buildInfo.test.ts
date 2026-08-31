import { describe, expect, it } from 'vitest';

import { buildLabel } from './buildInfo';

describe('buildLabel', () => {
  it('renders version, sha and the build date', () => {
    expect(
      buildLabel({ version: '0.1.0', gitSha: 'a1b2c3d', buildTime: '2026-08-30T12:34:56.000Z' }),
    ).toBe('kraken-hub v0.1.0 · a1b2c3d · built 2026-08-30');
  });

  it('does not leak the time of day into the label', () => {
    const label = buildLabel({
      version: '1.2.3',
      gitSha: 'dev',
      buildTime: '2026-01-02T23:59:59.999Z',
    });
    expect(label).not.toContain('23:59');
    expect(label).toContain('2026-01-02');
  });
});
