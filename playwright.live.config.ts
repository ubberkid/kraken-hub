import { defineConfig, devices } from '@playwright/test';

/**
 * The opt-in LIVE suite (`npm run test:e2e:live`), NEVER run in CI.
 *
 * `tests/e2e/` proves everything that is a claim about *kraken-hub*: the element
 * we mount, the transform we write, the calls we make, the mask we raise. Those
 * run against a stubbed player and are hermetic.
 *
 * This config runs the handful of assertions that are claims about *YouTube* —
 * that a 1920-wide element really does elicit ≥720p, and that a real embed
 * loads at all from this origin. They need the public internet, they are subject
 * to rate limits, ads and player rollouts, and a failure here is information
 * about the world rather than a regression in this repo. Making CI depend on
 * that would train everyone to ignore a red build.
 */
export default defineConfig({
  testDir: './tests/e2e-live',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    viewport: { width: 640, height: 640 },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
