/**
 * The ZIP reader is the one piece of this package that parses an untrusted
 * binary format, and it does so in order to produce a file the companion then
 * *executes*. So the cases below are weighted towards refusal: a malformed,
 * truncated or tampered archive must fail loudly, never yield a short file.
 *
 * The fixtures are built here rather than checked in. Writing the archive by
 * hand from the spec means the reader is tested against an independent
 * implementation of the format, not against its own idea of one.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crc32, extractZipEntry, readZipEntries } from '../src/unzip.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kh-unzip-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Member {
  name: string;
  data: Buffer;
  /** 0 = stored, 8 = deflate. */
  method: 0 | 8;
}

/** A minimal but spec-shaped ZIP writer, used only to feed the reader. */
function buildZip(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const m of members) {
    const body = m.method === 8 ? deflateRawSync(m.data) : m.data;
    const name = Buffer.from(m.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(m.method, 8);
    local.writeUInt32LE(crc32(m.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(m.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(m.method, 10);
    central.writeUInt32LE(crc32(m.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(m.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

describe('crc32', () => {
  it('matches the published check values for the ZIP polynomial', () => {
    // The canonical CRC-32 test vector: "123456789" → 0xCBF43926.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('is resumable across chunks, which is how a stream is checked', () => {
    const whole = Buffer.from('the quick brown fox', 'ascii');
    const seeded = crc32(whole.subarray(9), crc32(whole.subarray(0, 9)));
    expect(seeded).toBe(crc32(whole));
  });
});

describe('reading the central directory', () => {
  it('lists every entry, with the sizes the directory declares', () => {
    const zip = buildZip([
      { name: 'build/bin/ffmpeg.exe', data: Buffer.from('MZ-pretend-executable'), method: 8 },
      { name: 'build/README.txt', data: Buffer.from('hello'), method: 0 },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['build/bin/ffmpeg.exe', 'build/README.txt']);
    expect(entries[0]?.uncompressedSize).toBe(21);
    expect(entries[1]?.method).toBe(0);
  });

  it('refuses anything that is not a ZIP at all', () => {
    expect(() => readZipEntries(Buffer.from('not a zip file, just some bytes'))).toThrow(
      /not a ZIP file/,
    );
  });

  it('refuses a truncated archive rather than reading past its end', () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }]);
    // Point the EOCD's central-directory offset past the end of the buffer.
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(zip.length + 100, broken.length - 22 + 16);
    expect(() => readZipEntries(broken)).toThrow(/truncated/);
  });

  it('refuses ZIP64 rather than misreading its sentinel values as real ones', () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }]);
    const zip64 = Buffer.from(zip);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(() => readZipEntries(zip64)).toThrow(/ZIP64/);
  });
});

describe('extracting one entry', () => {
  it('inflates a deflated entry byte for byte', async () => {
    // Compressible enough that deflate actually engages, and big enough to
    // cross more than one stream chunk.
    const payload = Buffer.from('ffmpeg'.repeat(50_000), 'ascii');
    const zip = buildZip([
      { name: 'x/bin/ffprobe.exe', data: Buffer.from('other'), method: 0 },
      { name: 'x/bin/ffmpeg.exe', data: payload, method: 8 },
    ]);
    const entry = readZipEntries(zip).find((e) => e.name.endsWith('/bin/ffmpeg.exe'));
    expect(entry).toBeDefined();

    const dest = join(dir, 'ffmpeg.exe');
    await extractZipEntry(zip, entry!, dest);
    expect(await readFile(dest)).toEqual(payload);
  });

  it('handles a stored entry too', async () => {
    const zip = buildZip([{ name: 'a/bin/ffmpeg.exe', data: Buffer.from('raw'), method: 0 }]);
    const dest = join(dir, 'out');
    await extractZipEntry(zip, readZipEntries(zip)[0]!, dest);
    expect(await readFile(dest, 'utf8')).toBe('raw');
  });

  it('fails the CRC check when the compressed bytes were tampered with', async () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('x'.repeat(1000)), method: 8 }]);
    const entry = readZipEntries(zip)[0]!;
    // Claim a CRC the real bytes cannot produce: the archive's own integrity
    // check, on top of the SHA-256 over the whole download.
    entry.crc32 = 0xdeadbeef;
    await expect(extractZipEntry(zip, entry, join(dir, 'out'))).rejects.toThrow(/CRC/);
  });

  it('rejects an entry whose declared length does not match what came out', async () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('x'.repeat(1000)), method: 8 }]);
    const entry = readZipEntries(zip)[0]!;
    entry.uncompressedSize = 12;
    await expect(extractZipEntry(zip, entry, join(dir, 'out'))).rejects.toThrow(/declares 12/);
  });

  it('refuses a compression method it does not implement', async () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }]);
    const entry = readZipEntries(zip)[0]!;
    entry.method = 14; // LZMA
    await expect(extractZipEntry(zip, entry, join(dir, 'out'))).rejects.toThrow(
      /compression method 14/,
    );
  });

  it('refuses an entry whose local header is not where the directory says', async () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('x'), method: 0 }]);
    const entry = readZipEntries(zip)[0]!;
    entry.localHeaderOffset = 3;
    await expect(extractZipEntry(zip, entry, join(dir, 'out'))).rejects.toThrow(
      /Malformed local header/,
    );
  });
});
