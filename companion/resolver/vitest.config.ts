import { defineConfig } from 'vitest/config';

/**
 * Node only, no browser, and — deliberately — no network. Every test in here
 * runs the *real* HTTP server on an ephemeral port with the extractor injected
 * as a stub, so the contract is asserted against the program that ships rather
 * than against a mock of it.
 */
export default defineConfig({
  test: {
    name: 'companion',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A hung server test should fail, not hang CI.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
