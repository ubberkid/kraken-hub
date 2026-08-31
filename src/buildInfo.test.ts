import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { RESOLVER_WINDOWS_ASSET, buildLabel, normalizeRepoUrl, releaseAssetUrl } from './buildInfo';

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

/**
 * The download button on the guided connect panel.
 *
 * The link has to survive two things this repo cares about: invariant I4 (no
 * hardcoded origins — a fork must offer ITS build, not ours), and every release
 * after this one, which is why it points at GitHub's `latest` redirect rather
 * than at a version.
 */
describe('releaseAssetUrl', () => {
  it('derives the link from package.json, however the manifest spells the url', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      repository?: { url?: string };
    };
    const repo = normalizeRepoUrl(pkg.repository?.url ?? '');
    expect(repo).toBe('https://github.com/ubberkid/kraken-hub');
    expect(releaseAssetUrl(RESOLVER_WINDOWS_ASSET, repo)).toBe(
      'https://github.com/ubberkid/kraken-hub/releases/latest/download/kraken-hub-resolver-win-x64.exe',
    );
  });

  it('normalizes the three spellings npm allows', () => {
    expect(normalizeRepoUrl('git+https://github.com/o/r.git')).toBe('https://github.com/o/r');
    expect(normalizeRepoUrl('git://github.com/o/r.git')).toBe('https://github.com/o/r');
    expect(normalizeRepoUrl('https://github.com/o/r')).toBe('https://github.com/o/r');
  });

  it('is null with no repository, so a fork renders nothing rather than a dead link', () => {
    expect(releaseAssetUrl(RESOLVER_WINDOWS_ASSET, '')).toBeNull();
  });
});
