/**
 * Just enough of the ZIP format to pull two named files out of an archive.
 *
 * ## Why this exists
 *
 * The companion can install ffmpeg for itself on Windows, and the only
 * ffmpeg build yt-dlp itself endorses ships as a `.zip`. `node:zlib` decompresses
 * *streams* — gzip, deflate — but it knows nothing about ZIP's container: the
 * central directory, local headers, per-entry CRCs. There is no unzip in the
 * Node standard library, and this package ships with **zero runtime
 * dependencies** on purpose (see `cli.ts`), so adding one to unpack one archive
 * would be a poor trade.
 *
 * ## What it deliberately does not do
 *
 * No ZIP64, no encryption, no multi-disk archives, no directory reconstruction,
 * no symlink or permission handling. Anything it does not understand is a hard
 * error, never a silent partial extraction — the caller is about to *execute*
 * what comes out of here, so "I got most of it" is not an acceptable outcome.
 *
 * Entry names are never turned into paths. The caller names the destination
 * file itself and matches entries by exact suffix, so a crafted archive cannot
 * write outside the cache directory via `../` or an absolute name.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

import { MediaError } from './exec.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const EOCD_MIN_SIZE = 22;
/** A ZIP comment is a u16 length, so the EOCD can be at most this far from the end. */
const MAX_EOCD_SEARCH = 0xffff + EOCD_MIN_SIZE;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** The sentinel both a u16 count and a u32 offset use to mean "see the ZIP64 record". */
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The ZIP flavour of CRC-32 (reflected, polynomial 0xEDB88320), as an unsigned int. */
export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const from = Math.max(0, zip.length - MAX_EOCD_SEARCH);
  for (let at = zip.length - EOCD_MIN_SIZE; at >= from; at -= 1) {
    if (zip.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new MediaError('upstream-failed', 'That archive is not a ZIP file (no end-of-directory).');
}

/**
 * Every entry in the archive, read from the central directory — which is the
 * authoritative copy of the sizes. The local headers may legally leave them
 * zero and defer to a trailing data descriptor, so they are never trusted here.
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const total = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  const offset = zip.readUInt32LE(eocd + 16);

  if (total === U16_MAX || size === U32_MAX || offset === U32_MAX) {
    throw new MediaError('upstream-failed', 'ZIP64 archives are not supported.');
  }
  if (offset + size > zip.length) {
    throw new MediaError('upstream-failed', 'That ZIP file is truncated.');
  }

  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < total; i += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new MediaError('upstream-failed', 'That ZIP central directory is malformed.');
    }
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    entries.push({
      name: zip.toString('utf8', at + 46, at + 46 + nameLen),
      method: zip.readUInt16LE(at + 10),
      crc32: zip.readUInt32LE(at + 16),
      compressedSize: zip.readUInt32LE(at + 20),
      uncompressedSize: zip.readUInt32LE(at + 24),
      localHeaderOffset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Where an entry's compressed bytes actually start, per its local header. */
function dataOffset(zip: Buffer, entry: ZipEntry): number {
  const at = entry.localHeaderOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new MediaError('upstream-failed', `Malformed local header for ${entry.name}.`);
  }
  return at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
}

/**
 * Decompress one entry to `destFile`, streaming so that a 145 MB executable
 * never has to exist as a second Buffer in memory.
 *
 * The CRC and the uncompressed length from the central directory are both
 * checked afterwards. They are the archive's own integrity check, on top of the
 * SHA-256 the caller already verified over the whole download.
 */
export async function extractZipEntry(
  zip: Buffer,
  entry: ZipEntry,
  destFile: string,
): Promise<void> {
  if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
    throw new MediaError(
      'upstream-failed',
      `${entry.name} uses ZIP compression method ${String(entry.method)}, which is not supported.`,
    );
  }
  const start = dataOffset(zip, entry);
  const end = start + entry.compressedSize;
  if (end > zip.length) {
    throw new MediaError('upstream-failed', `${entry.name} runs past the end of the archive.`);
  }

  let crc = 0;
  let bytes = 0;
  const tally = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      crc = crc32(chunk, crc);
      bytes += chunk.length;
      yield chunk;
    }
  };

  const source = Readable.from([zip.subarray(start, end)]);
  const dest = createWriteStream(destFile);
  if (entry.method === METHOD_DEFLATE) {
    await pipeline(source, createInflateRaw(), tally, dest);
  } else {
    await pipeline(source, tally, dest);
  }

  if (bytes !== entry.uncompressedSize) {
    throw new MediaError(
      'upstream-failed',
      `${entry.name} unpacked to ${String(bytes)} bytes; the archive declares ${String(entry.uncompressedSize)}.`,
    );
  }
  if (crc !== entry.crc32) {
    throw new MediaError('upstream-failed', `${entry.name} failed its CRC check.`);
  }
}
