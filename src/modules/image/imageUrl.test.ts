import { describe, expect, it } from 'vitest';

import { primaryImageIssue, validateImageUrl } from './imageUrl';

const codes = (url: string, opts?: Parameters<typeof validateImageUrl>[1]): string[] =>
  validateImageUrl(url, opts).issues.map((i) => i.code);

describe('validateImageUrl', () => {
  it('treats an empty url as "nothing chosen", not an error', () => {
    const r = validateImageUrl('   ');
    expect(r.kind).toBe('empty');
    expect(r.blocking).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('upgrades http to https and says so — the same rule the video router applies', () => {
    const r = validateImageUrl('http://example.com/a.jpg');
    expect(r.url).toBe('https://example.com/a.jpg');
    expect(codes('http://example.com/a.jpg')).toContain('mixed-content-http');
    // An auto-fix never blocks.
    expect(r.blocking).toBe(false);
  });

  it('leaves loopback http alone — it is a potentially trustworthy origin', () => {
    const r = validateImageUrl('http://127.0.0.1:8976/a.png');
    expect(r.url).toBe('http://127.0.0.1:8976/a.png');
    expect(r.issues.map((i) => i.code)).not.toContain('mixed-content-http');
    expect(r.blocking).toBe(false);
  });

  it('rejects a scheme nothing can open', () => {
    for (const url of ['file:///Users/me/a.png', 'data:image/png;base64,AAAA', 'nonsense']) {
      const r = validateImageUrl(url);
      expect(r.blocking).toBe(true);
      expect(r.issues.map((i) => i.code)).toContain('unsupported-scheme');
    }
  });

  it('warns — never blocks — on a link that does not look like an image file', () => {
    const r = validateImageUrl('https://example.com/gallery/photos');
    expect(r.issues.map((i) => i.code)).toContain('unsupported-format');
    expect(r.blocking).toBe(false);
  });

  it('does not warn about extensionless URLs on hosts that never use one', () => {
    expect(codes('https://i.redd.it/abc123')).not.toContain('unsupported-format');
    expect(codes('https://pbs.twimg.com/media/abc?format=jpg')).not.toContain('unsupported-format');
  });

  it('flags an animated source with the capture-FPS explanation', () => {
    const r = validateImageUrl('https://example.com/loop.gif');
    expect(r.animated).toBe(true);
    const issue = r.issues.find((i) => i.code === 'animated-capture-fps');
    expect(issue?.severity).toBe('warn');
    expect(issue?.message).toContain('Frame Rate');
  });

  it('accepts a library reference and reports its id', () => {
    const r = validateImageUrl('kraken-hub-image:abc-123', { knownImageIds: ['abc-123'] });
    expect(r.kind).toBe('local');
    expect(r.localId).toBe('abc-123');
    expect(r.blocking).toBe(false);
  });

  it('blocks a library reference the context cannot reach', () => {
    expect(codes('kraken-hub-image:abc-123', { knownImageIds: [] })).toContain(
      'local-image-missing',
    );
    // The phone remote is a different storage partition and never has the bytes.
    expect(codes('kraken-hub-image:abc-123', { context: 'remote' })).toContain(
      'local-image-missing',
    );
  });

  it('surfaces errors ahead of warnings', () => {
    const r = validateImageUrl('kraken-hub-image:nope', { knownImageIds: [] });
    expect(primaryImageIssue(r)?.code).toBe('local-image-missing');
    expect(primaryImageIssue(validateImageUrl('https://example.com/x'))?.severity).toBe('warn');
  });
});
