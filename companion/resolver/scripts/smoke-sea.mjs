#!/usr/bin/env node
/**
 * Smoke-test a built single-executable companion.
 *
 * The build script proves the exe was produced. This proves it *runs* — which
 * is a different claim, because a SEA can be injected perfectly and still die
 * on the first `require` of something the bundler dropped. So this starts the
 * real binary, on a real ephemeral port, and drives the real protocol end to
 * end: `/health`, then `/resolve` → `/job/<id>` → `/stream/<id>`, with
 * `KRAKEN_HUB_RESOLVER_STUB` standing in for yt-dlp so nothing touches the
 * network and no extractor is ever spawned.
 *
 *     node scripts/smoke-sea.mjs [path-to-exe]
 *
 * Written with `fetch` and `spawn` rather than curl so the same file is the CI
 * step on windows-latest and the command a developer runs on a Mac.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

/** The fixture the stub downloader copies for every resolve. */
const FIXTURE = join(repoRoot, 'public', 'demo', 'demo.mp4');

function findExe() {
  const explicit = process.argv[2];
  if (explicit !== undefined) return resolve(explicit);
  const dir = join(packageRoot, 'build', 'sea');
  if (!existsSync(dir)) throw new Error(`No build output at ${dir}. Run npm run build:sea first.`);
  const found = readdirSync(dir).find((f) => f.startsWith('kraken-hub-resolver-'));
  if (found === undefined) throw new Error(`No kraken-hub-resolver-* binary in ${dir}.`);
  return join(dir, found);
}

const exe = findExe();
if (!existsSync(FIXTURE)) throw new Error(`Missing stub fixture: ${FIXTURE}`);

process.stdout.write(`▸ Starting ${exe}\n`);
const child = spawn(exe, ['--port', '0', '--log-level', 'debug'], {
  env: {
    ...process.env,
    KRAKEN_HUB_RESOLVER_STUB: FIXTURE,
    // Belt and braces: even in stub mode, nothing may reach out for a binary.
    KRAKEN_HUB_RESOLVER_NO_DOWNLOAD: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const capture = (chunk) => {
  output += String(chunk);
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n\n--- companion output ---\n${output}\n`);
  child.kill('SIGKILL');
  process.exit(1);
}

/** `--port 0` asks the kernel for a free port; the log line is how we learn it. */
async function waitForPort(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match !== null) return Number(match[1]);
    if (child.exitCode !== null) fail(`The companion exited with code ${String(child.exitCode)}.`);
    await new Promise((r) => setTimeout(r, 200));
  }
  fail('The companion never reported a listening port.');
}

async function main() {
  const port = await waitForPort();
  const base = `http://127.0.0.1:${String(port)}`;
  process.stdout.write(`▸ Listening on ${base}\n`);

  // 1. /health — the one call kraken-hub makes to decide the companion exists.
  const health = await fetch(`${base}/health`);
  if (health.status !== 200) fail(`/health returned ${String(health.status)}, expected 200.`);
  const healthBody = await health.json();
  if (healthBody.ok !== true || healthBody.api !== 1) {
    fail(`/health body is not a v1 health envelope: ${JSON.stringify(healthBody)}`);
  }
  process.stdout.write(`✓ /health 200 — ${healthBody.name} ${healthBody.version} (api v1)\n`);

  if (!banner()) fail('The startup banner was not printed.');
  process.stdout.write('✓ startup banner printed\n');

  // 2. /resolve — a stubbed resolve, polled to completion.
  const target = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  let envelope = await (await fetch(`${base}/resolve?url=${encodeURIComponent(target)}`)).json();
  const deadline = Date.now() + 30_000;
  while (envelope.status === 'pending' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    envelope = await (await fetch(`${base}/job/${String(envelope.jobId)}`)).json();
  }
  if (envelope.status !== 'ok') fail(`/resolve did not finish ok: ${JSON.stringify(envelope)}`);
  process.stdout.write(`✓ /resolve → ${String(envelope.kind)} ${String(envelope.streamUrl)}\n`);

  // 3. /stream — the minted opaque id must actually serve bytes.
  const stream = await fetch(String(envelope.streamUrl));
  if (stream.status !== 200) fail(`/stream returned ${String(stream.status)}, expected 200.`);
  const bytes = (await stream.arrayBuffer()).byteLength;
  if (bytes === 0) fail('/stream served an empty body.');
  process.stdout.write(`✓ /stream 200 — ${String(bytes)} bytes\n`);

  // 4. An unknown id is a 404, not a path traversal.
  const missing = await fetch(`${base}/stream/0123456789abcdef0123456789abcdef`);
  if (missing.status !== 404) fail(`Unknown stream id returned ${String(missing.status)}.`);
  process.stdout.write('✓ unknown /stream id → 404\n');

  child.kill('SIGTERM');
  process.stdout.write('\n✓ SEA smoke test passed.\n');
}

function banner() {
  return output.includes('kraken-hub will detect this automatically');
}

main().catch((cause) => {
  fail(cause instanceof Error ? cause.message : String(cause));
});
