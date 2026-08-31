import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium only. The target is a Chromium webview inside CAM; Firefox/WebKit
 * runs would be misleading and would triple CI time.
 *
 * The 640x640 viewport is the Kraken Elite panel; specs that need another
 * device preset override it per-test.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  ...(process.env['CI'] ? { workers: 1 } : {}),
  reporter: [['html', { open: 'never' }], ['github'], ['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    viewport: { width: 640, height: 640 },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
