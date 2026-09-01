import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * "It switches, then reverts on its own."
 *
 * A user reported picking Clock in the CAM window, watching it work for about a
 * second, and watching it flip back to Video. The cause was precedence, not the
 * module picker: the sync layer's `remote` layer outranks anything this page
 * saves and it is *sticky*, so once any peer had said `activeModuleId: 'video'`
 * every later re-resolve put it back — and a retained snapshot redelivered on a
 * reconnect is enough to cause a re-resolve.
 *
 * These tests are the regression guard, and they are deliberately about the
 * BUG CLASS rather than about `activeModuleId`: any setting a user changes
 * locally has to survive a stale echo, so a module switch and a module-config
 * field are both checked, paired and unpaired.
 *
 * Everything runs against the in-repo broker simulator (`?transport=fake`).
 */

const STATE_KEY = 'kraken-hub:v1:state';
const ROOM = 'VWXY6789';

/** Long enough to cover the store's 1 s storage poll and the 2 s persist throttle. */
const SETTLE_MS = 4000;

function configUrl(paired: boolean): string {
  return paired ? `/?room=${ROOM}&transport=fake#/` : '/#/';
}

function displayUrl(): string {
  return `/?kraken=1&sim=elite&room=${ROOM}&transport=fake`;
}

async function storedModule(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as { activeModuleId?: string };
    return doc.activeModuleId ?? null;
  }, STATE_KEY);
}

/** The video module's own framing, which is module CONFIG, not app render. */
async function storedFit(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const doc = JSON.parse(raw) as {
      modules?: Record<string, { cfg?: { render?: { fit?: string } } }>;
    };
    return doc.modules?.['video']?.cfg?.render?.fit ?? null;
  }, STATE_KEY);
}

/**
 * Asserts a value holds for `SETTLE_MS` rather than merely being true once.
 *
 * The bug was a REVERT, so a single assertion right after the click passes on
 * the broken build — it took about a second. Sampling across the window is the
 * only shape of test that would have caught it.
 */
async function holdsFor(read: () => Promise<string | null>, expected: string): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    expect(await read()).toBe(expected);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

test.describe('a local change is not rolled back', () => {
  test('unpaired: the module switch sticks', async ({ page }) => {
    await page.goto(configUrl(false));
    await page.getByTestId('module-chip-clock').click();
    await expect(page.getByTestId('module-chip-clock')).toHaveAttribute('aria-pressed', 'true');
    await holdsFor(async () => storedModule(page), 'clock');
    await expect(page.getByTestId('module-chip-clock')).toHaveAttribute('aria-pressed', 'true');
  });

  test('paired: the module switch sticks, and the display follows', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    const display = await context.newPage();
    await display.goto(displayUrl());

    const config = await context.newPage();
    await config.goto(configUrl(true));
    await expect(config.getByTestId('module-chip-clock')).toBeVisible();

    await config.getByTestId('module-chip-clock').click();

    // 1. It stays chosen for longer than the revert used to take.
    await holdsFor(async () => storedModule(config), 'clock');
    await expect(config.getByTestId('module-chip-clock')).toHaveAttribute('aria-pressed', 'true');

    // 2. …and the choice really converged on the other side of the room, so
    //    this is not a page that merely refuses to listen.
    await expect
      .poll(async () => display.locator('[data-module]').getAttribute('data-module'), {
        timeout: 10_000,
      })
      .toBe('clock');
  });

  test('paired: a module-config field sticks too', async ({
    context,
  }: {
    context: BrowserContext;
  }) => {
    // The same bug class, on a different key: the fix is a precedence layer,
    // not a special case for the active module.
    const display = await context.newPage();
    await display.goto(displayUrl());

    const config = await context.newPage();
    // `#/module/video` is a redirect now — options are contextual, so it lands
    // on home with the video panel already open (design audit, F1).
    await config.goto(`/?room=${ROOM}&transport=fake#/module/video`);
    // The strip's Fit control, which is now the ONLY one: the module panel asked
    // the same question again four inches lower, and round 2 deleted the copy.
    const contain = config.getByTestId('home-video-fit-contain');
    await expect(contain).toBeVisible();

    await contain.click();
    await holdsFor(async () => storedFit(config), 'contain');
    await expect(contain).toHaveAttribute('aria-checked', 'true');
  });
});
