import { describe, expect, it } from 'vitest';

import { qrMatrix, qrSvgPath, remoteLinkUrl } from './qr';
import { hashQuery, parseRoute } from './router';

const APP = 'https://example.test/kraken-hub/';
const ROOM = 'ABCD1234';

/**
 * The room code is the only secret in the sync design — it derives both the
 * topic (`SHA-256(code)`) and the AES-GCM key — and there is no server of ours
 * that could revoke one that leaked. A fragment never leaves the browser; a
 * query string is written into every access log, CDN log, proxy and `Referer`
 * between the phone and the static host. These tests are the guard rail on that
 * distinction, because the two URLs look almost identical in a diff.
 */
describe('remoteLinkUrl', () => {
  it('puts the room code in the fragment and nowhere else', () => {
    const url = new URL(remoteLinkUrl(APP, ROOM));
    expect(url.search).toBe('');
    expect(url.searchParams.get('room')).toBeNull();
    expect(url.hash).toContain(ROOM);
    // Belt and braces: the code must not appear before the '#' at all.
    const [beforeHash] = remoteLinkUrl(APP, ROOM).split('#');
    expect(beforeHash).not.toContain(ROOM);
  });

  it('lands on the remote route, with the code readable from the fragment', () => {
    const link = remoteLinkUrl(APP, ROOM);
    const hash = `#${link.split('#')[1] ?? ''}`;
    expect(parseRoute(hash)).toEqual({ name: 'remote' });
    expect(new URLSearchParams(hashQuery(hash)).get('room')).toBe(ROOM);
  });

  it('keeps the fork’s own origin and trailing slash', () => {
    expect(remoteLinkUrl(APP, ROOM)).toBe(`${APP}#/remote?room=${ROOM}`);
    expect(remoteLinkUrl('https://user.github.io/fork/', ROOM)).toBe(
      `https://user.github.io/fork/#/remote?room=${ROOM}`,
    );
  });

  it('encodes a code that could not be a room code rather than breaking the URL', () => {
    // `normalizeRoomCode` never produces one of these, but a fork calling this
    // with something else must not emit a URL that reparses differently.
    const url = new URL(remoteLinkUrl(APP, 'A B&c=1'));
    expect(url.search).toBe('');
    expect(new URLSearchParams(hashQuery(url.hash)).get('room')).toBe('A B&c=1');
  });
});

describe('qrMatrix', () => {
  it('encodes the pairing link and renders a drawable path', () => {
    const matrix = qrMatrix(remoteLinkUrl(APP, ROOM));
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix.length).toBe(matrix[0]?.length);
    const path = qrSvgPath(matrix);
    expect(path.side).toBe(matrix.length + 8);
    expect(path.d.length).toBeGreaterThan(0);
  });
});
