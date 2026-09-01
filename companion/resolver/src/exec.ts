/**
 * The bits `ytdlp.ts` and `ffmpeg.ts` both need: spawning a child process
 * without a shell, and installing a third-party binary only after its published
 * digest has been checked.
 *
 * This file exists because there are now **two** binaries the companion may
 * fetch for itself — yt-dlp and, on Windows, ffmpeg — and the security rules
 * that govern the first must govern the second identically. Duplicating the
 * "download, hash, compare, refuse" dance would mean one of the two copies
 * eventually drifting into "install it anyway".
 *
 * Nothing here knows what a video is.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import type { ResolverErrorCode } from './contract.js';

/** A failure that already knows which contract code it maps onto. */
export class MediaError extends Error {
  readonly code: ResolverErrorCode;

  constructor(code: ResolverErrorCode, message: string) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The shape of {@link run}, so PATH probes can be stubbed in a unit test. */
export type Runner = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    // `shell: false` is the default and is spelled out because the whole
    // security story of this program rests on it.
    const child = spawn(bin, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(() => {
        reject(new MediaError('internal', 'Cancelled.'));
      });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => {
        reject(new MediaError('upstream-failed', `${bin} timed out.`));
      });
    }, opts.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      finish(() => {
        reject(new MediaError('upstream-failed', `${bin} could not be started: ${err.message}`));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        resolve({ code, stdout, stderr });
      });
    });

    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function isExecutable(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

/** The environment kill switches. Both mean "never touch the network". */
export function autoDownloadRefused(env: NodeJS.ProcessEnv): string | null {
  if (env['KRAKEN_HUB_RESOLVER_NO_DOWNLOAD'] === '1') {
    return 'KRAKEN_HUB_RESOLVER_NO_DOWNLOAD=1';
  }
  if (typeof env['CI'] === 'string' && env['CI'] !== '' && env['CI'] !== 'false') {
    return 'CI';
  }
  return null;
}

/**
 * A checksum manifest line: `<sha256>␠␠<asset>`. Both yt-dlp's `SHA2-256SUMS`
 * and FFmpeg-Builds' `checksums.sha256` use exactly this form.
 *
 * Returns `null` when the asset is absent, which must be treated as a failure —
 * "no digest published" is never a reason to install the bytes anyway.
 */
export function digestFor(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === asset && typeof parts[0] === 'string') {
      return parts[0].toLowerCase();
    }
  }
  return null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Fetch `<base>/<asset>` and refuse to return the bytes unless they hash to the
 * digest `<base>/<sumsFile>` publishes for that exact asset name.
 */
export async function fetchVerifiedAsset(opts: {
  base: string;
  asset: string;
  sumsFile: string;
  fetchImpl: typeof fetch;
}): Promise<Buffer> {
  const sumsRes = await opts.fetchImpl(`${opts.base}/${opts.sumsFile}`);
  if (!sumsRes.ok) {
    throw new MediaError('upstream-failed', `Could not fetch the ${opts.sumsFile} checksum file.`);
  }
  const expected = digestFor(await sumsRes.text(), opts.asset);
  if (expected === null) {
    throw new MediaError('upstream-failed', `The release publishes no digest for ${opts.asset}.`);
  }

  const binRes = await opts.fetchImpl(`${opts.base}/${opts.asset}`);
  if (!binRes.ok) {
    throw new MediaError('upstream-failed', `Could not download ${opts.asset}.`);
  }
  const bytes = Buffer.from(await binRes.arrayBuffer());
  if (sha256(bytes) !== expected) {
    throw new MediaError(
      'upstream-failed',
      `Checksum mismatch for ${opts.asset} — refusing to install it.`,
    );
  }
  return bytes;
}
