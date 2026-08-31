import { describe, expect, it } from 'vitest';

import * as companion from '../src/contract.js';

// The web app's copy of the frozen contract, imported ACROSS the workspace.
// This is the whole point of the file: the two halves of the wire cannot drift
// without this test going red, and the published package still has no
// dependency on the app's source tree.
import * as app from '../../../src/modules/video/resolver/resolverTypes.js';

describe('the frozen v1 contract stays in lockstep with the web app', () => {
  it('speaks the same api revision', () => {
    expect(companion.RESOLVER_API_VERSION).toBe(app.RESOLVER_API_VERSION);
  });

  it('has the identical closed error enum, in the same order', () => {
    expect([...companion.RESOLVER_ERROR_CODES]).toEqual([...app.RESOLVER_ERROR_CODES]);
  });

  it('agrees on the kinds a stream can be', () => {
    expect([...companion.RESOLVER_KINDS]).toEqual([...app.RESOLVER_KINDS]);
  });

  it('spells the token header the same way', () => {
    expect(companion.RESOLVER_TOKEN_HEADER).toBe(app.RESOLVER_TOKEN_HEADER);
  });

  it('uses the same default poll interval', () => {
    expect(companion.DEFAULT_RETRY_AFTER_MS).toBe(app.DEFAULT_RETRY_AFTER_MS);
  });

  it('maps a status onto every code the client can receive', () => {
    for (const code of app.RESOLVER_ERROR_CODES) {
      expect(companion.STATUS_FOR_CODE[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('never invents a code the client would have to downgrade to internal', () => {
    for (const code of companion.RESOLVER_ERROR_CODES) {
      expect(app.isResolverErrorCode(code)).toBe(true);
    }
  });
});
