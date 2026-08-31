import { expect, test, type Page } from '@playwright/test';

/**
 * The single most important e2e in the project.
 *
 * CAM opens two Chromium browsers on the SAME origin, so localStorage plus the
 * `storage` event is the sanctioned config→display channel. It is unverified
 * whether that event fires reliably inside the CAM webview (H14), which is why
 * a 1 s poll runs unconditionally — and why the second case here proves the app
 * still converges with `storage` events suppressed entirely.
 */
const STATE_KEY = 'kraken-hub:v1:state';

async function commitBackground(page: Page, color: string): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      const raw = localStorage.getItem(key);
      const state: Record<string, unknown> =
        raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const render = (state['render'] ?? {}) as Record<string, unknown>;
      const next = {
        ...state,
        schema: 1,
        rev: typeof state['rev'] === 'number' ? state['rev'] + 1 : 1,
        updatedAt: Date.now(),
        writerId: 'e2e-config-1',
        writerRole: 'config',
        activeModuleId: state['activeModuleId'] ?? 'clock',
        render: { ...render, background: value },
      };
      localStorage.setItem(key, JSON.stringify(next));
    },
    [STATE_KEY, color] as const,
  );
}

test('a config write reaches the display through the storage event', async ({ context }) => {
  const config = await context.newPage();
  await config.goto('/');
  await expect(config.locator('.kh-app')).toBeVisible();

  const display = await context.newPage();
  await display.goto('/?kraken=1&sim=elite');
  await expect(display.locator('.kh-stage')).toBeVisible();

  await commitBackground(config, 'rgb(18, 52, 86)');

  await expect(display.locator('.kh-stage')).toHaveCSS('background-color', 'rgb(18, 52, 86)', {
    timeout: 1500,
  });
});

test('the poll fallback converges when storage events never fire', async ({ context }) => {
  const display = await context.newPage();
  // Swallow every `storage` listener registration before any app code runs.
  await display.addInitScript(() => {
    const original = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'storage') return;
      (original as (t: string, ...r: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
  });
  await display.goto('/?kraken=1&sim=elite');
  await expect(display.locator('.kh-stage')).toBeVisible();

  const config = await context.newPage();
  await config.goto('/');
  await commitBackground(config, 'rgb(86, 52, 18)');

  await expect(display.locator('.kh-stage')).toHaveCSS('background-color', 'rgb(86, 52, 18)', {
    timeout: 3000,
  });
});
