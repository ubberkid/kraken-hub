import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - `unit` — pure logic (geometry math, state migrations, room codes) in node.
 *  - `dom`  — anything that needs a document: React components and the
 *            localStorage / IndexedDB harnesses.
 *
 * Live transport tests are opt-in: KRAKEN_HUB_LIVE defaults to '0' here so PR CI
 * never contacts a public broker.
 */
export default defineConfig({
  test: {
    // Passed THROUGH rather than pinned: hard-coding '0' here would override
    // the flag `npm run test:live` sets and the live suite could never run.
    // Unset still means off, so PR CI still never contacts a public broker.
    env: { KRAKEN_HUB_LIVE: process.env['KRAKEN_HUB_LIVE'] ?? '0' },
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.dom.test.ts'],
        },
      },
      {
        // Opt-in only: every test inside is `describe.skipIf(!LIVE)`, so this
        // project runs and skips in ordinary `npm test`.
        test: {
          name: 'live',
          environment: 'node',
          include: ['tests/live/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.ts', 'src/**/*.test.tsx'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/types/**'],
      thresholds: {
        lines: 60,
        'src/platform/**': { lines: 90, branches: 85 },
        'src/state/**': { lines: 95, branches: 90 },
        'src/sync/**': { lines: 90, branches: 85 },
        'src/validation/**': { lines: 100, branches: 95 },
      },
    },
  },
});
