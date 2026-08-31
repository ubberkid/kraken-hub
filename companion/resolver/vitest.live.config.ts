import { defineConfig } from 'vitest/config';

/**
 * The OPT-IN live suite. Never collected by `npm test`, `npm run check` or CI.
 *
 * `vitest.config.ts` includes `test/**` and nothing else, so these files are
 * not merely skipped in the ordinary run — they are never even loaded. That
 * matters here in a way it does not for a pure-logic test: everything in this
 * directory spawns a real extractor and pulls real bytes off the public
 * internet, and a suite that can only be reached through its own config file
 * cannot be switched on by accident.
 *
 *     npm run test:live            # from the repo root, or this workspace
 */
export default defineConfig({
  test: {
    name: 'companion-live',
    environment: 'node',
    include: ['test-live/**/*.test.ts'],
    // The default reporter hides a skip's reason, and here the reason IS the
    // output: "yt-dlp is not installed" has to be readable, or somebody will
    // read `2 skipped` as `2 passed`.
    reporters: ['verbose'],
    // One real download, one real remux. The default 5 s would be absurd.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // A live download is not a thing to run four of at once on somebody's
    // laptop, and yt-dlp is polite about rate limits only if we are.
    fileParallelism: false,
  },
});
