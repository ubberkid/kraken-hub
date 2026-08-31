/**
 * A minimal QR encoder — byte mode, error-correction level L, versions 1–10.
 *
 * ## Why this is hand-rolled
 *
 * The pairing QR encodes a URL that contains the ROOM CODE, and the room code
 * is the only secret in the whole sync design. Handing that URL to
 * `api.qrserver.com` or a Google Charts endpoint would mail the key to a third
 * party on every render — which is precisely the threat model the encryption
 * exists to defend against, defeated by a convenience. Invariant 8 (nothing
 * loads from a CDN) rules out pulling a library at runtime for the same reason,
 * and a dependency for one screen is more weight than the ~250 lines below.
 *
 * ## Scope, deliberately
 *
 * Byte mode only (URLs), ECC level L (a screen-to-camera scan at 6 cm needs no
 * more), versions 1–10 (up to 271 bytes — a fork URL plus `#/remote?room=…`
 * fits several times over). Anything longer throws rather than silently
 * producing an unscannable code.
 *
 * Everything here follows ISO/IEC 18004. The tables are the standard's, quoted
 * for level L only.
 */

/** data codewords, EC codewords per block, group-1 blocks/size, group-2 blocks/size */
interface VersionSpec {
  ecPerBlock: number;
  g1Blocks: number;
  g1Size: number;
  g2Blocks: number;
  g2Size: number;
}

/** ISO/IEC 18004 Table 13/14, level L, versions 1–10. */
const SPECS: readonly VersionSpec[] = [
  { ecPerBlock: 7, g1Blocks: 1, g1Size: 19, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 10, g1Blocks: 1, g1Size: 34, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 15, g1Blocks: 1, g1Size: 55, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 20, g1Blocks: 1, g1Size: 80, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 26, g1Blocks: 1, g1Size: 108, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 18, g1Blocks: 2, g1Size: 68, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 20, g1Blocks: 2, g1Size: 78, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 24, g1Blocks: 2, g1Size: 97, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 30, g1Blocks: 2, g1Size: 116, g2Blocks: 0, g2Size: 0 },
  { ecPerBlock: 18, g1Blocks: 2, g1Size: 68, g2Blocks: 2, g2Size: 69 },
];

/** Alignment-pattern centre coordinates per version (index 0 = version 1). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** BCH-encoded format information for level L, masks 0–7. */
const FORMAT_L: readonly number[] = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

/** BCH-encoded version information, versions 7–10. */
const VERSION_INFO: Readonly<Record<number, number>> = {
  7: 0x07c94,
  8: 0x085bc,
  9: 0x09a99,
  10: 0x0a4d3,
};

const MAX_VERSION = SPECS.length;

// ---------------------------------------------------------------------------
// GF(256)
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] ?? 0;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0;
}

/** Generator polynomial of degree `degree`, coefficients high-order first. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j] ?? 0, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j] ?? 0, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], ecLength: number): number[] {
  const gen = generatorPoly(ecLength);
  const remainder = new Array<number>(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecLength; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Bit stream
// ---------------------------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
}

function capacityBytes(version: number): number {
  const spec = SPECS[version - 1];
  if (spec === undefined) return 0;
  const dataCodewords = spec.g1Blocks * spec.g1Size + spec.g2Blocks * spec.g2Size;
  // 4 bits mode + 8 or 16 bits character count.
  const headerBytes = version < 10 ? 2 : 3;
  return dataCodewords - headerBytes;
}

function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    if (byteLength <= capacityBytes(v)) return v;
  }
  throw new Error(
    `kraken-hub: ${String(byteLength)} bytes does not fit a version-${String(MAX_VERSION)} QR code at ECC level L.`,
  );
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

type Cell = 0 | 1;

interface Matrix {
  size: number;
  modules: Cell[][];
  reserved: boolean[][];
}

function blank(size: number): Matrix {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<Cell>(size).fill(0)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function set(m: Matrix, r: number, c: number, v: Cell, reserve = true): void {
  const row = m.modules[r];
  const res = m.reserved[r];
  if (row === undefined || res === undefined) return;
  row[c] = v;
  if (reserve) res[c] = true;
}

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
      const onRing = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(m, rr, cc, onRing || inCore ? 1 : 0);
    }
  }
}

function placeAlignment(m: Matrix, version: number): void {
  const centres = ALIGNMENT[version - 1] ?? [];
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three that would collide with the finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === m.size - 7) || (r === m.size - 7 && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const centre = dr === 0 && dc === 0;
          set(m, r + dr, c + dc, edge || centre ? 1 : 0);
        }
      }
    }
  }
}

function placeTiming(m: Matrix): void {
  for (let i = 8; i < m.size - 8; i += 1) {
    const bit: Cell = i % 2 === 0 ? 1 : 0;
    set(m, 6, i, bit);
    set(m, i, 6, bit);
  }
}

function reserveFormat(m: Matrix): void {
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      set(m, 8, i, 0);
      set(m, i, 8, 0);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(m, 8, m.size - 1 - i, 0);
    set(m, m.size - 1 - i, 8, 0);
  }
  // The one module that is always dark.
  set(m, m.size - 8, 8, 1);
}

function placeVersionInfo(m: Matrix, version: number): void {
  const info = VERSION_INFO[version];
  if (info === undefined) return;
  for (let i = 0; i < 18; i += 1) {
    const bit: Cell = ((info >>> i) & 1) === 1 ? 1 : 0;
    const r = Math.floor(i / 3);
    const c = m.size - 11 + (i % 3);
    set(m, r, c, bit);
    set(m, c, r, bit);
  }
}

function placeFormatInfo(m: Matrix, mask: number): void {
  const bits = FORMAT_L[mask] ?? 0;
  for (let i = 0; i < 15; i += 1) {
    const bit: Cell = ((bits >>> i) & 1) === 1 ? 1 : 0;
    // Copy 1: around the top-left finder.
    if (i < 6) set(m, 8, i, bit);
    else if (i < 8) set(m, 8, i + 1, bit);
    else if (i === 8) set(m, 7, 8, bit);
    else set(m, 14 - i, 8, bit);
    // Copy 2: split between the other two finders.
    if (i < 8) set(m, m.size - 1 - i, 8, bit);
    else set(m, 8, m.size - 15 + i, bit);
  }
}

const MASKS: readonly ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** ISO/IEC 18004 §8.8.2 penalty scores, used to choose the mask. */
function penalty(m: Matrix): number {
  const n = m.size;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules, in both directions.
  for (let r = 0; r < n; r += 1) {
    let runH = 1;
    let runV = 1;
    for (let c = 1; c < n; c += 1) {
      runH = m.modules[r]?.[c] === m.modules[r]?.[c - 1] ? runH + 1 : 1;
      if (runH === 5) score += 3;
      else if (runH > 5) score += 1;
      runV = m.modules[c]?.[r] === m.modules[c - 1]?.[r] ? runV + 1 : 1;
      if (runV === 5) score += 3;
      else if (runV > 5) score += 1;
    }
  }

  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = m.modules[r]?.[c];
      if (
        v === m.modules[r]?.[c + 1] &&
        v === m.modules[r + 1]?.[c] &&
        v === m.modules[r + 1]?.[c + 1]
      ) {
        score += 3;
      }
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (i: number) => number | undefined, start: number): boolean =>
    pattern.every((p, i) => get(start + i) === p);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c + 6 < n; c += 1) {
      if (matches((i) => m.modules[r]?.[i], c)) score += 40;
      if (matches((i) => m.modules[i]?.[r], c)) score += 40;
    }
  }

  let dark = 0;
  for (const row of m.modules) for (const v of row) dark += v;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Column-pair zig-zag from the bottom right, skipping the timing column. */
function placeData(m: Matrix, bits: number[]): void {
  let index = 0;
  let upward = true;
  for (let right = m.size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < m.size; step += 1) {
      const r = upward ? m.size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (m.reserved[r]?.[c] === true) continue;
        const bit = bits[index] ?? 0;
        index += 1;
        set(m, r, c, bit === 1 ? 1 : 0, false);
      }
    }
    upward = !upward;
  }
}

/**
 * The pairing link — the single place it is built.
 *
 * ## The room code lives in the FRAGMENT, and that is a security property
 *
 * `https://host/kraken-hub/#/remote?room=ABCD1234`, never
 * `https://host/kraken-hub/?room=ABCD1234`. A fragment is stripped by the
 * browser before the request goes out: it never reaches the origin server, a
 * CDN, a corporate proxy, a `Referer` header sent to a third party, or an
 * analytics beacon. A query string reaches all of them and is written to their
 * logs.
 *
 * That matters here more than it usually does. The room code is not an opaque
 * session id that a server could revoke — it is the *key material*: the topic is
 * `SHA-256(code)` and every payload is AES-GCM encrypted under a key derived
 * from the same code. Anyone who reads the code out of a log can decrypt the
 * room. There is no server of ours to notice or to rotate it.
 *
 * So this function takes the code and puts it after the route inside the hash,
 * and `qr.test.ts` asserts that a URL built from it has an empty `search` and a
 * `hash` containing the code. Do not "tidy" it into a normal query string.
 *
 * `appUrl` is the canonical install URL with its trailing slash
 * (`knownHosts.canonicalAppUrl`), so a fork encodes its own origin.
 */
export function remoteLinkUrl(appUrl: string, roomCode: string): string {
  return `${appUrl}#/remote?room=${encodeURIComponent(roomCode)}`;
}

/**
 * Encode `text` as a QR matrix of booleans (`true` = dark module).
 *
 * The returned matrix has NO quiet zone; the caller adds the mandatory 4-module
 * margin, because whoever is drawing it knows whether that is padding, a `viewBox`
 * or CSS.
 */
export function qrMatrix(text: string): boolean[][] {
  const data = [...new TextEncoder().encode(text)];
  const version = pickVersion(data.length);
  const spec = SPECS[version - 1];
  if (spec === undefined) throw new Error('kraken-hub: unsupported QR version');

  const dataCodewords = spec.g1Blocks * spec.g1Size + spec.g2Blocks * spec.g2Size;
  const countBits = version < 10 ? 8 : 16;

  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode
  buf.put(data.length, countBits);
  for (const b of data) buf.put(b, 8);

  const capacityBits = dataCodewords * 8;
  buf.put(0, Math.min(4, capacityBits - buf.bits.length)); // terminator
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (buf.bits[i + j] ?? 0);
    codewords.push(byte);
  }
  // §8.4.9 — pad with alternating 11101100 / 00010001 until the block is full.
  let padHigh = true;
  while (codewords.length < dataCodewords) {
    codewords.push(padHigh ? 0xec : 0x11);
    padHigh = !padHigh;
  }

  // Split into blocks, compute EC, then interleave — §8.6.
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  const push = (count: number, size: number): void => {
    for (let i = 0; i < count; i += 1) {
      const block = codewords.slice(offset, offset + size);
      offset += size;
      blocks.push(block);
      ecBlocks.push(reedSolomon(block, spec.ecPerBlock));
    }
  };
  push(spec.g1Blocks, spec.g1Size);
  push(spec.g2Blocks, spec.g2Size);

  const interleaved: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.length) interleaved.push(block[i] ?? 0);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) interleaved.push(block[i] ?? 0);
  }

  const bits: number[] = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }

  const size = version * 4 + 17;
  let best: { matrix: Matrix; score: number } | null = null;

  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const m = blank(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    reserveFormat(m);
    placeVersionInfo(m, version);
    placeData(m, bits);

    const fn = MASKS[mask];
    if (fn === undefined) continue;
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (m.reserved[r]?.[c] === true) continue;
        if (fn(r, c)) {
          const row = m.modules[r];
          if (row !== undefined) row[c] = row[c] === 1 ? 0 : 1;
        }
      }
    }
    placeFormatInfo(m, mask);

    const score = penalty(m);
    if (best === null || score < best.score) best = { matrix: m, score };
  }

  if (best === null) throw new Error('kraken-hub: QR mask selection produced nothing');
  return best.matrix.modules.map((row) => row.map((v) => v === 1));
}

/**
 * The matrix as a standalone SVG string, with the mandatory 4-module quiet
 * zone. Rendered with `dangerouslySetInnerHTML`-free markup by the caller;
 * this returns a `path` `d` attribute plus the viewBox side length.
 */
export function qrSvgPath(matrix: boolean[][], quiet = 4): { d: string; side: number } {
  const side = matrix.length + quiet * 2;
  let d = '';
  for (let r = 0; r < matrix.length; r += 1) {
    const row = matrix[r];
    if (row === undefined) continue;
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] === true) d += `M${String(c + quiet)} ${String(r + quiet)}h1v1h-1z`;
    }
  }
  return { d, side };
}
