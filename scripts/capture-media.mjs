#!/usr/bin/env node
/**
 * Captures every screenshot the documentation ships with.
 *
 * The screenshots in `README.md` and `docs/` are not hand-cropped artefacts that
 * rot the moment a panel is renamed: they are *generated* from the built app by
 * this script, against the real display boot path running inside the hardware
 * simulator. Re-run it after a UI change and commit the diff.
 *
 * ## What it writes
 *
 * | File                     | What it is                                                    |
 * | ------------------------ | ------------------------------------------------------------- |
 * | `docs/assets/hero.gif`   | the panel itself, moving — the README's hero (needs ffmpeg)   |
 * | `docs/assets/hero.png`   | the home screen's halo, running the real display page         |
 * | `docs/assets/config-ui.png` | the configuration UI a CAM Configuration Browser opens      |
 * | `docs/assets/remote.png` | the phone remote, at a phone viewport                         |
 * | `docs/assets/diag.png`   | the merged About & diagnostics page                           |
 * | `public/preview-640.png` | exactly 640x640 of the display surface (NZXT submission spec) |
 *
 * `public/preview-640.png` is the one with a hard external contract: NZXT's
 * community-integration list wants a 640x640 image of the integration. This
 * script produces a **simulator capture**, which is honest but is not a photo of
 * a panel; `docs/nzxt-submission.md` says so and gates submission on replacing
 * it. The size is asserted, not assumed — a capture that comes out any other
 * size fails the run rather than shipping a file NZXT would reject.
 *
 * ## Why it is not part of `npm run check`
 *
 * It builds, boots a preview server, drives a real browser and writes binary
 * files into the working tree. None of that belongs in a check that must be
 * deterministic and read-only. `npm run capture` runs it deliberately.
 *
 * ## Usage
 *
 *     npm run capture                 # build, boot, capture everything
 *     npm run capture -- --no-build   # reuse the existing dist/
 *     npm run capture -- --no-gif     # PNGs only, skip the ~40 s of frame grabbing
 *     npm run capture -- --port 4180  # if 4179 is taken
 *
 * The hero GIF needs `ffmpeg` on PATH. When ffmpeg is missing the run says so
 * and finishes the PNGs: it never fails for the want of an optional asset, and
 * the README's static hero is unaffected either way.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const assetsDir = join(root, 'docs', 'assets');
const publicDir = join(root, 'public');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const wantsGif = !argv.includes('--no-gif');
const skipBuild = argv.includes('--no-build');
const portArg = argv.indexOf('--port');
const PORT = portArg === -1 ? 4179 : Number(argv[portArg + 1]);
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

/** The Elite panel. Everything the LCD-facing captures do is sized from this. */
const PANEL = 640; // device-size-ok: the NZXT submission image spec, not app layout.

/** Deliberately 2x for the config/remote/diag pages: crisp on a HiDPI reader. */
const DOC_SCALE = 2;

/** The demo hint fades after 15 s (src/modules/video/display.ts). */
const HINT_FADE_MS = 15_000;

const log = (msg) => {
  console.log(`[capture] ${msg}`);
};

// ---------------------------------------------------------------------------
// Preview server
// ---------------------------------------------------------------------------

/**
 * Boots `vite preview` on the built `dist/` and resolves once it answers.
 *
 * `vite preview` rather than `vite dev` on purpose: the docs should show what a
 * visitor to the deployed Pages site sees, including the production chunk graph
 * and the real build-time `define`s in the version footer.
 */
async function startPreview() {
  const child = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', () => {
    /* drained so the pipe never fills; vite's banner is noise here */
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('vite preview exited before it served anything');
    try {
      const res = await fetch(`${ORIGIN}/`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`vite preview never answered on ${ORIGIN}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`preview server on ${ORIGIN}`);
  return child;
}

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

/**
 * A page with a clean slate.
 *
 * Every capture starts from a fresh context, so no earlier capture's stored
 * state leaks in — the hero in particular depends on booting with *no* state,
 * which is what puts the display into demo mode.
 */
async function freshPage(browser, viewport, scale = 1) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    console.error(`[capture] page error: ${err.message}`);
  });
  return { context, page };
}

/** Waits for the demo hint overlay to expire, so the hero shows the clip alone. */
async function waitForHintToFade(frame) {
  const hint = frame.locator('.kh-video__hint');
  if ((await hint.count()) === 0) return;
  log(`waiting ${String(HINT_FADE_MS / 1000)} s for the demo hint to fade`);
  await hint.waitFor({ state: 'detached', timeout: HINT_FADE_MS + 10_000 });
}

/** Asserts an emitted PNG really is the size its contract says it is. */
function assertSize(file, expected) {
  // PNG IHDR: 8-byte signature, 4-byte length, 4-byte type, then w and h as BE u32.
  const buf = readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expected || height !== expected) {
    throw new Error(
      `${file} is ${String(width)}x${String(height)}, expected ${String(expected)}px square`,
    );
  }
}

function reportSize(file) {
  log(`wrote ${file.replace(root, '')} (${(statSync(file).size / 1024).toFixed(1)} kB)`);
}

// ---------------------------------------------------------------------------
// The five captures
// ---------------------------------------------------------------------------

/**
 * Pretends a Kraken has already connected to this installation.
 *
 * `displaySeen.ts` puts the CAM install card at the top of the home screen until
 * something the DISPLAY published has been seen on the origin — correct for a
 * first run, and not what the README is documenting. Setting the same latch the
 * app sets is how these captures show the steady state.
 */
async function markDisplaySeen(page) {
  await page.addInitScript(() => {
    localStorage.setItem('kraken-hub:v1:config:displaySeen', '1');
  });
}

/**
 * The hero: the halo on the home screen, running the real display page.
 *
 * Until the Halo redesign this was `#/preview` — a display iframe inside a round
 * bezel on a route of its own. That route folded into the home screen, and the
 * halo IS the bezel now: the same real display document, at the same real panel
 * size, in the frame the product actually presents it in.
 *
 * The clock is what the halo is showing, and that is not an accident. The video
 * mirror is deliberately a stylized surface — a second decoder and a second set
 * of ads on a page whose job is to watch the first one is a bad trade — so video
 * is the one module whose halo would NOT be a photograph of the running app.
 * `public/preview-640.png` below is the honest capture of video on the panel.
 */
async function captureHero(browser) {
  const { context, page } = await freshPage(browser, { width: 740, height: 780 }, DOC_SCALE);
  await markDisplaySeen(page);
  /*
    `?cam=1`, because the halo IS a display iframe and only the window that
    shares CAM's storage partition may mount one (wave 1, A1 — `ownsBytes`).
    Without it this run waited thirty seconds for a frame the surface gate is
    right to refuse, and the hero has not regenerated since that gate shipped.
  */
  await page.goto(`${ORIGIN}/?cam=1#/`, { waitUntil: 'networkidle' });
  await page.getByTestId('module-chip-clock').click();

  const halo = page.getByTestId('mirror');
  await halo.waitFor({ state: 'visible' });
  const frame = page.frameLocator('.kh-halo__frame');
  await frame.locator('.kh-stage').waitFor({ state: 'visible', timeout: 30_000 });
  await frame.locator('.kh-clock').waitFor({ state: 'visible', timeout: 30_000 });

  const file = join(assetsDir, 'hero.png');
  await halo.screenshot({ path: file });
  reportSize(file);
  await context.close();
  return file;
}

/** The configuration UI, as CAM's Configuration Browser opens it. */
async function captureConfigUi(browser) {
  const { context, page } = await freshPage(browser, { width: 1000, height: 700 }, DOC_SCALE);
  await markDisplaySeen(page);
  // The window this shot is OF: `?cam=1` is the simulator seam for the surface
  // gate, so the capture shows what a Configuration Browser shows.
  await page.goto(`${ORIGIN}/?cam=1#/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { level: 1, name: 'kraken-hub' }).waitFor();
  await page.locator('.kh-footer').waitFor();
  const file = join(assetsDir, 'config-ui.png');
  await page.screenshot({ path: file, fullPage: true });
  reportSize(file);
  await context.close();
  return file;
}

/**
 * The phone remote, at a phone viewport, paired.
 *
 * The room code is generated by clicking the button a user clicks, not written
 * into localStorage — so the screenshot can only ever show a state the app can
 * actually reach. `?transport=fake` keeps the capture off `broker.emqx.io`: a
 * documentation build has no business touching a public broker, and the paired
 * layout (code, topic id, QR) is identical either way.
 */
async function captureRemote(browser) {
  const { context, page } = await freshPage(browser, { width: 420, height: 900 }, DOC_SCALE);
  await page.goto(`${ORIGIN}/?transport=fake#/remote`, { waitUntil: 'networkidle' });
  await page.getByTestId('pairing-card').waitFor();
  await page.getByTestId('pair-rotate').click();
  // Paired: the card collapses to "Paired with your PC · ROOM …", which is the
  // state the design is actually about.
  await page.getByTestId('paired-summary').waitFor({ state: 'visible', timeout: 15_000 });
  // Let the fake transport settle so the status chips are not mid-transition.
  await page.waitForTimeout(1500);
  const file = join(assetsDir, 'remote.png');
  await page.screenshot({ path: file, fullPage: true });
  reportSize(file);
  await context.close();
  return file;
}

/**
 * The merged About page, with its technical drawer open and probed.
 *
 * `#/about` rather than `#/diag`: the two are one page now (design audit, F7),
 * and `#/diag` reaches it by rewriting the hash — which would put a redirect in
 * the middle of a screenshot run for no reason.
 *
 * The drawer is opened deliberately. Round 2's R3 put every probe behind
 * **Show the technical detail**, and a shot of the closed page would be three
 * short sections — accurate, and useless as documentation of what the
 * diagnostics actually contain.
 */
async function captureDiag(browser) {
  const { context, page } = await freshPage(browser, { width: 1000, height: 880 }, DOC_SCALE);
  await page.goto(`${ORIGIN}/?cam=1#/about`, { waitUntil: 'networkidle' });
  await page.getByTestId('tech-detail').locator('summary').click();
  await page.getByRole('heading', { name: 'This browser' }).waitFor();
  // The codec/storage probes are async; give them a beat to fill in.
  await page.waitForTimeout(3500);
  const file = join(assetsDir, 'diag.png');
  await page.screenshot({ path: file, fullPage: true });
  reportSize(file);
  await context.close();
  return file;
}

/**
 * `public/preview-640.png` — the NZXT submission image.
 *
 * Captured at deviceScaleFactor 1 from a 640x640 viewport of the display page
 * itself, so the file is exactly 640x640 device pixels with no bezel, no
 * browser chrome and no scaling. The size is asserted below.
 */
async function capturePreview640(browser) {
  const { context, page } = await freshPage(browser, { width: PANEL, height: PANEL }, 1);
  await page.goto(`${ORIGIN}/?kraken=1&sim=elite&fps=40`, { waitUntil: 'networkidle' });
  await page.locator('.kh-stage').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('video').waitFor({ state: 'attached', timeout: 30_000 });
  await waitForHintToFade(page);

  const file = join(publicDir, 'preview-640.png');
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: PANEL, height: PANEL } });
  assertSize(file, PANEL);
  reportSize(file);
  await context.close();
  return file;
}

// ---------------------------------------------------------------------------
// Optional hero GIF
// ---------------------------------------------------------------------------

/**
 * A short looping GIF of the demo clip on the panel.
 *
 * Frames are grabbed one screenshot at a time — Playwright has no video encoder
 * we can point at a single element — so the capture rate is approximate and the
 * result is a *representative* loop, not a frame-accurate recording. That is
 * fine for a README, and it is why the shipped hero is the PNG.
 */
async function captureHeroGif(browser) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    log('ffmpeg not on PATH — skipping the hero GIF (the PNG hero is unaffected)');
    return null;
  }

  const FRAMES = 48;
  const FPS = 12;
  const frameDir = mkdtempSync(join(tmpdir(), 'kraken-hub-gif-'));
  const { context, page } = await freshPage(browser, { width: 900, height: 900 }, 1);
  // The display page itself, at the panel's own size: a moving hero has to show
  // the video actually playing, and the home screen's halo shows a stylized
  // stand-in for video by design (see `captureHero`).
  await page.goto(`${ORIGIN}/?kraken=1&sim=elite&fps=40`, { waitUntil: 'networkidle' });
  const stage = page.locator('.kh-stage');
  await stage.waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('video').waitFor({ state: 'attached', timeout: 30_000 });
  await waitForHintToFade(page);

  log(`grabbing ${String(FRAMES)} frames`);
  for (let i = 0; i < FRAMES; i += 1) {
    await stage.screenshot({ path: join(frameDir, `f${String(i).padStart(4, '0')}.png`) });
  }

  const out = join(assetsDir, 'hero.gif');
  const pattern = join(frameDir, 'f%04d.png');
  const palette = join(frameDir, 'palette.png');
  const filters = `fps=${String(FPS)},scale=520:-1:flags=lanczos`;
  execFileSync('ffmpeg', ['-y', '-i', pattern, '-vf', `${filters},palettegen`, palette], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-framerate',
      String(FPS),
      '-i',
      pattern,
      '-i',
      palette,
      '-lavfi',
      `${filters}[x];[x][1:v]paletteuse`,
      '-loop',
      '0',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  rmSync(frameDir, { recursive: true, force: true });
  reportSize(out);
  await context.close();
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(assetsDir, { recursive: true });

if (!skipBuild) {
  log('building');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

const server = await startPreview();
const browser = await chromium.launch();
try {
  await captureHero(browser);
  await captureConfigUi(browser);
  await captureRemote(browser);
  await captureDiag(browser);
  await capturePreview640(browser);
  if (wantsGif) await captureHeroGif(browser);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

log('done — review the diff, then commit the PNGs.');
