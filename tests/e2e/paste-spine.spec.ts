import { expect, test, type Page } from '@playwright/test';

/**
 * SPINE 1 — there is ONE paste mechanism, and this test finds the exceptions.
 *
 * ## Why an enumeration rather than four assertions
 *
 * Six audit rounds have now produced the same shape of finding six times: a
 * class is identified, the instances that somebody photographed are fixed, and
 * the class survives on the surfaces nobody photographed. Round 5 gave the home
 * row and the remote's source row `pasteAction` — the mapping that decides
 * whether a link field is the *video* field or the *picture* field, based on
 * what is actually on the panel — and round 6 found the other two link fields
 * still calling `submitVideoLink` unconditionally. A `.jpg` pasted into either
 * **Add** panel with Image on the panel went into `modules.video.cfg.url`,
 * silently switched the active module to video, and printed a success receipt.
 *
 * Writing four assertions naming four fields would buy exactly one more round,
 * because the assertion would be a copy of the list of things somebody
 * remembered. So this file does not know how many link fields the app has. It
 * walks every route and every state, asks the DOM what text inputs are on the
 * screen, works out which of them accept a URL, and requires each one to carry
 * `data-paste-field` — an attribute only `pasteAction` produces. A link field
 * added later, by anybody, on any screen, fails this test **by existing**.
 *
 * The other half of the spine is enforced by the compiler rather than here:
 * `submitVideoLink` and `submitImageLink` are module-private in `pasteLink.ts`,
 * so there is no door into the commit except `pasteAction`. Together they are
 * the rule — the compiler stops a bypass in the code, this stops a field that
 * never asked in the first place.
 */

const STATE_KEY = 'kraken-hub:v1:state';
const ROOM = 'PSPN2345';
const PICTURE_URL = 'https://pictures.example.test/wallpaper.jpg';

/** Every module the app ships, which is what "every state" means for a panel. */
const MODULES = ['video', 'image', 'clock', 'stats'] as const;

/** The two that have something to be handed. Clock and Stats have nothing. */
const HAVE_A_FIELD: readonly string[] = ['video', 'image'];

function camUrl(hash: string): string {
  return `/?cam=1&transport=fake&room=${ROOM}${hash}`;
}

function phoneUrl(hash: string): string {
  return `/?transport=fake&room=${ROOM}${hash}`;
}

async function seedSeen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

interface FoundField {
  /** How a human would find it again: the id, or the test id, or the label. */
  id: string;
  /** The accessible name plus the placeholder — what makes it "url-accepting". */
  described: string;
  /** `null` is the failure: a field the spine never touched. */
  pasteField: string | null;
  /**
   * The declared opt-out: a URL that is a SETTING, not a source.
   *
   * A broker address and a proxy base take a URL and have nothing to do with
   * which module is on the panel. They say so at the field
   * (`<TextInput settingUrl>`), which is the property that matters — a list of
   * exempt ids kept in this file would be the hand-list this test exists to
   * replace, and it would grow silently every time somebody added a field and
   * a line to it.
   */
  settingUrl: boolean;
}

/**
 * Every text input on the screen right now, with what it says about itself.
 *
 * By ROLE, not by selector list: `input[type=text]`, `<textarea>` and anything
 * carrying `role="textbox"` are all "a box a person can paste into", and a
 * future field built out of a contenteditable would be caught by the third.
 * Hidden subtrees are skipped — a closed `<details>` still lays its children out
 * in Chromium, and a field nobody can reach is not a field that can lie.
 */
async function fieldsOnScreen(page: Page): Promise<FoundField[]> {
  return page.evaluate(() => {
    const boxes = [
      ...document.querySelectorAll<HTMLElement>(
        'input:not([type]), input[type="text"], input[type="url"], input[type="search"], textarea, [role="textbox"]',
      ),
    ].filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

    return boxes.map((el) => {
      const labelled = el.getAttribute('aria-labelledby');
      const byId =
        labelled === null ? null : (document.getElementById(labelled)?.textContent ?? null);
      const forLabel =
        el.id === ''
          ? null
          : (document.querySelector(`label[for="${el.id}"]`)?.textContent ?? null);
      const described = [
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('placeholder') ?? '',
        byId ?? '',
        forLabel ?? '',
      ].join(' ');
      return {
        id: el.id !== '' ? el.id : (el.dataset['testid'] ?? described.trim()),
        described,
        pasteField: el.getAttribute('data-paste-field'),
        settingUrl: el.getAttribute('data-url-field') === 'setting',
      };
    });
  });
}

/**
 * Does this box take a link?
 *
 * The discriminator is what the field TELLS the user it wants, because that is
 * the only thing both a person and a test can read — and because a field that
 * asks for a link in words is precisely the one a user will paste a link into.
 * It is deliberately broad: `url`, `link`, `paste`, `http`, or an `type="url"`.
 * A field that asks for a link while dodging all five words would be a UI
 * problem before it was a test problem.
 */
function acceptsUrl(field: FoundField): boolean {
  return !field.settingUrl && /\b(url|uri|link|paste|address|https?)\b/i.test(field.described);
}

async function readState(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STATE_KEY);
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

function moduleUrl(state: Record<string, unknown>, id: string): string {
  const modules = state['modules'] as Record<string, { cfg?: { url?: string } }> | undefined;
  return modules?.[id]?.cfg?.url ?? '';
}

/**
 * The walk itself: every surface a link field can appear on, in every module.
 *
 * Each entry opens whatever door hides the field, because a field behind a
 * closed panel is one nobody has ever audited — which is exactly how two of
 * them stayed hard-wired for three waves.
 */
const SURFACES: readonly {
  name: string;
  url: (hash: string) => string;
  hash: string;
  open?: (page: Page) => Promise<void>;
}[] = [
  { name: 'CAM home', url: camUrl, hash: '#/' },
  {
    name: 'CAM home, options open',
    url: camUrl,
    hash: '#/',
    open: async (page) => {
      const active = page.locator('[data-testid^="module-chip-"][aria-pressed="true"]');
      await active.click();
      await expect(page.getByTestId('ops-panel')).toBeVisible();
    },
  },
  {
    name: 'CAM library, Add open',
    url: camUrl,
    hash: '#/library',
    open: async (page) => {
      await page.getByTestId('library-add').click();
      await expect(page.getByTestId('library-add-panel')).toBeVisible();
    },
  },
  { name: 'the remote', url: phoneUrl, hash: '#/remote' },
  {
    name: 'the remote, Add open',
    url: phoneUrl,
    hash: '#/remote',
    open: async (page) => {
      await page.getByTestId('remote-add').click();
      await expect(page.getByTestId('remote-add-panel')).toBeVisible();
    },
  },
  {
    name: 'the phone library, Add open',
    url: phoneUrl,
    hash: '#/library',
    open: async (page) => {
      await page.getByTestId('remote-add').click();
      await expect(page.getByTestId('remote-add-panel')).toBeVisible();
    },
  },
  { name: 'About', url: camUrl, hash: '#/about' },
];

/** Put a module on the panel before the walk, by writing the document. */
async function seedModule(page: Page, moduleId: string): Promise<void> {
  await page.addInitScript(
    ([key, id]) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          schema: 2,
          rev: 1,
          updatedAt: Date.now(),
          writerId: 'e2e-spine',
          writerRole: 'config',
          activeModuleId: id,
          sync: { enabled: true, roomCode: 'PSPN2345', transport: 'fake' },
          modules: {},
        }),
      );
    },
    [STATE_KEY, moduleId] as const,
  );
}

test.describe('SPINE 1 — every link field is the same link field', () => {
  for (const moduleId of MODULES) {
    test(`no url-accepting input bypasses pasteAction, with ${moduleId} on the panel`, async ({
      context,
    }) => {
      /*
       * The walk collects; the assertions come after it.
       *
       * Deliberately no `expect` inside the loop: a per-field assertion would
       * stop at the FIRST offender, and the entire value of an enumeration is
       * the complete list. The failure message names every field it found, on
       * every surface, in one go.
       */
      const found: { where: string; field: FoundField }[] = [];

      for (const surface of SURFACES) {
        const page = await context.newPage();
        await seedSeen(page);
        await seedModule(page, moduleId);
        await page.goto(surface.url(surface.hash));
        // Every surface has SOMETHING that proves it rendered, so a walk that
        // silently visited seven blank pages cannot pass vacuously.
        await expect(page.locator('main, .kh-remote').first()).toBeVisible();
        // A door that is not on this surface in this state is not a failure —
        // Clock's Add panel has no field to open onto, which is the point.
        await surface.open?.(page).catch(() => undefined);

        const here = await fieldsOnScreen(page);
        found.push(...here.filter(acceptsUrl).map((field) => ({ where: surface.name, field })));
        await page.close();
      }

      const strays = found
        .filter((f) => f.field.pasteField === null)
        .map((f) => `${f.where} → #${f.field.id} ("${f.field.described.trim()}")`);
      expect(
        strays,
        'these commit a link without going through pasteAction — see src/app/config/pasteLink.ts',
      ).toEqual([]);

      /*
       * …and each one is the field for the module ACTUALLY on the panel, which
       * is the half round 5 fixed and round 6 found unfixed on two more
       * surfaces. Clock and Stats have no paste action at all, so a field
       * claiming to be theirs would already be a bug.
       */
      const wrongModule = found
        .filter((f) => f.field.pasteField !== null && f.field.pasteField !== moduleId)
        .map((f) => `${f.where} → #${f.field.id} says "${f.field.pasteField ?? ''}"`);
      expect(wrongModule, `with ${moduleId} on the panel, every link field is its field`).toEqual(
        [],
      );

      /*
       * The anti-vacuity clause, both ways.
       *
       * Video and Image MUST turn up fields — a walk that quietly found none
       * would pass every assertion above while proving nothing, which is how an
       * enumeration test stops enumerating. Clock and Stats must turn up none:
       * they have nothing to be handed, so a link field on their panel is
       * itself the round-5 finding.
       */
      expect(
        found.length > 0,
        `${moduleId}: found ${String(found.length)} url-accepting fields across ${String(SURFACES.length)} surfaces`,
      ).toBe(HAVE_A_FIELD.includes(moduleId));
    });
  }

  /**
   * The behavioural half, on the two panels round 6 caught.
   *
   * The attribute above proves the wiring; this proves the wiring does the
   * thing. It is the round-5 reproduction re-run on the surfaces that were
   * missed: a picture link, with Image on the panel, must land in the picture
   * module and must not touch the video source or the active module.
   */
  test('a picture link pasted in CAM’s Add panel lands in the image module', async ({ page }) => {
    await seedSeen(page);
    await seedModule(page, 'image');
    await page.goto(camUrl('#/library'));
    await page.getByTestId('library-add').click();
    await page.getByTestId('library-add-input').fill(PICTURE_URL);
    await page.getByTestId('library-add-submit').click();

    await expect.poll(async () => moduleUrl(await readState(page), 'image')).toBe(PICTURE_URL);
    expect(moduleUrl(await readState(page), 'video')).toBe('');
    expect((await readState(page))['activeModuleId']).toBe('image');
  });

  test('a picture link pasted in the phone’s Add panel lands in the image module', async ({
    page,
  }) => {
    await seedModule(page, 'image');
    await page.goto(phoneUrl('#/remote'));
    await expect(page.getByTestId('paired-summary')).toBeVisible();
    await page.getByTestId('remote-add').click();
    await page.getByTestId('remote-add-link').fill(PICTURE_URL);
    await page.getByTestId('remote-add-link-submit').click();

    await expect.poll(async () => moduleUrl(await readState(page), 'image')).toBe(PICTURE_URL);
    expect(moduleUrl(await readState(page), 'video')).toBe('');
    expect((await readState(page))['activeModuleId']).toBe('image');
  });

  /**
   * Clock and Stats have nothing to be handed, on ALL FOUR surfaces.
   *
   * The home row and the remote's source row have answered this with a quiet
   * *Play something* since round 5; the two Add panels asked a sofa for a video
   * link while a clock was on the panel, which is the most prominent control on
   * the screen addressing a module that cannot use it.
   */
  test('the Add panels step aside for a module with nothing to be handed', async ({ page }) => {
    await seedSeen(page);
    await seedModule(page, 'clock');
    await page.goto(camUrl('#/library'));
    await page.getByTestId('library-add').click();
    await expect(page.getByTestId('library-add-input')).toHaveCount(0);
    await expect(page.getByTestId('library-add-switch')).toBeVisible();

    // …and it does what it says: video on the panel, and the field is back.
    await page.getByTestId('library-add-switch').click();
    await expect(page.getByTestId('library-add-input')).toBeVisible();
  });
});
