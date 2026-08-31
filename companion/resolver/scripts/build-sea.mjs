#!/usr/bin/env node
/**
 * Build the standalone single-executable companion.
 *
 * Why this exists: `npx kraken-hub-resolver` asks a Windows user who wants
 * ad-free YouTube on an LCD screen to first install Node. That is a bigger ask
 * than the feature is worth, so the artifact people actually download is one
 * `.exe` with a Node runtime inside it.
 *
 * The pipeline, in order, and why each step is there:
 *
 *   1. `tsc`      — the normal workspace build, so the exe is built from exactly
 *                   the same `dist/` the npm package and the e2e suite use.
 *   2. `esbuild`  — Node's SEA takes ONE CommonJS file. `dist/` is seven ES
 *                   modules. Bundling is not an optimisation here; it is the
 *                   format conversion SEA requires. Nothing external is pulled
 *                   in: this package has zero runtime dependencies and imports
 *                   nothing but `node:` builtins, which stay external.
 *   3. `--experimental-sea-config` — turns that file into a blob.
 *   4. copy `node` — the host's own Node binary becomes the carrier.
 *   5. `postject` — injects the blob into a section of that copy.
 *
 * macOS needs two extra moves: a signed binary cannot be modified, so the
 * signature comes off before injection and an ad-hoc one goes back on after.
 * Windows binaries are unsigned here, which is why the download instructions
 * everywhere tell people about the SmartScreen "More info → Run anyway" prompt.
 *
 * Build outputs land in `build/` and are gitignored. Nothing here is committed.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(packageRoot, 'build', 'sea');

/** `win-x64`, `macos-arm64`, `linux-x64` — the suffix on the released filename. */
const PLATFORM_NAMES = { win32: 'win', darwin: 'macos', linux: 'linux' };
const platform = PLATFORM_NAMES[process.platform] ?? process.platform;
const target = `${platform}-${process.arch}`;
const exeName = `kraken-hub-resolver-${target}${process.platform === 'win32' ? '.exe' : ''}`;
const exePath = join(buildDir, exeName);

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    stdio: 'inherit',
    cwd: packageRoot,
    // npm is a shell script on Windows; everything else here is a real binary.
    shell: process.platform === 'win32' && file === 'npm',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited ${String(result.status)}`);
  }
}

step('Cleaning build/sea');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

step('Compiling TypeScript (tsc -p tsconfig.build.json)');
run('npm', ['run', 'build']);

step('Bundling dist/ into a single CommonJS file (esbuild)');
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [join(packageRoot, 'dist', 'sea-entry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(buildDir, 'bundle.cjs'),
  // `cli.js` self-starts by comparing `import.meta.url` to argv[1]. In a SEA
  // there is neither, and `import.meta` has no meaning in CommonJS at all — so
  // it is replaced with a URL that can never match a real path, which switches
  // that guard off. `sea-entry.js` calls `main()` instead.
  define: { 'import.meta.url': '"kraken-hub-resolver:sea"' },
  legalComments: 'none',
  // Node builtins are provided by the runtime baked into the exe. Everything
  // else would be a bug: this package has no runtime dependencies.
  external: [],
});

step('Generating the SEA blob');
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);

step(`Copying the Node runtime → ${exeName}`);
copyFileSync(process.execPath, exePath);
chmodSync(exePath, 0o755);

if (process.platform === 'darwin') {
  step('Removing the existing code signature (a signed binary cannot be patched)');
  run('codesign', ['--remove-signature', exePath]);
}

step('Injecting the blob (postject)');
const postjectArgs = [
  exePath,
  'NODE_SEA_BLOB',
  join(buildDir, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, [require.resolve('postject/dist/cli.js'), ...postjectArgs]);

if (process.platform === 'darwin') {
  step('Re-signing ad-hoc (macOS refuses to exec an unsigned modified binary)');
  run('codesign', ['--sign', '-', exePath]);
}

const megabytes = (statSync(exePath).size / 1024 / 1024).toFixed(1);
process.stdout.write(`\n✓ ${exePath}  (${megabytes} MB)\n`);
process.stdout.write(`  Smoke-test it:  "${exePath}" --version\n\n`);
