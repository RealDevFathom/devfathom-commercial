/**
 * DEV-879 — a small, dependency-free QR Code encoder (ISO/IEC 18004) for the
 * authenticator set-up screen, so an `otpauth://` URI can be scanned by Google
 * Authenticator and similar apps. Byte mode, error-correction level M, versions 1–20
 * (up to 666 bytes, ample for an otpauth URI), automatic mask selection.
 *
 * CLIENT-SAFE and PURE: it returns the module matrix (true = dark); rendering is the
 * caller's job. The secret it encodes is only ever shown to the member enrolling.
 */

// Error-correction level M, indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];
const MAX_VERSION = 20;
/** Format-information bits for error-correction level M. */
const ECL_M_FORMAT_BITS = 0;

export class QrCodeTooLongError extends Error {
  constructor() {
    super('The text is too long for a QR code.');
  }
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number): number {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[version] * NUM_ERROR_CORRECTION_BLOCKS[version]
  );
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// --- Reed–Solomon over GF(2^8) with the QR polynomial 0x11D -------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// --- Data encoding -------------------------------------------------------------

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function encodeData(bytes: readonly number[], version: number): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4); // byte mode
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  const capacityBits = numDataCodewords(version) * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = reedSolomonDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// --- Matrix construction --------------------------------------------------------

type Matrix = { size: number; modules: boolean[][]; reserved: boolean[][] };

function newMatrix(version: number): Matrix {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(m: Matrix, x: number, y: number, dark: boolean) {
  m.modules[y][x] = dark;
  m.reserved[y][x] = true;
}

function drawFunctionPatterns(m: Matrix, version: number) {
  for (let i = 0; i < m.size; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [m.size - 4, 3],
    [3, m.size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= m.size || y < 0 || y >= m.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(m, x, y, dist !== 2 && dist !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((px, i) => {
    positions.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(m, px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  drawFormatBits(m, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = m.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(m, a, b, dark);
      setFunction(m, b, a, dark);
    }
  }
}

function drawFormatBits(m: Matrix, mask: number) {
  const data = (ECL_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFunction(m, 8, i, bit(i));
  setFunction(m, 8, 7, bit(6));
  setFunction(m, 8, 8, bit(7));
  setFunction(m, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(m, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunction(m, m.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(m, 8, m.size - 15 + i, bit(i));
  setFunction(m, 8, m.size - 8, true);
}

function drawCodewords(m: Matrix, codewords: readonly number[]) {
  let i = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.reserved[y][x] && i < codewords.length * 8) {
          m.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.reserved[y][x] && maskApplies(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

/** The standard penalty score; the lowest-scoring mask scans most reliably. */
function penalty(m: Matrix): number {
  const { size, modules } = m;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      for (let j = 0; j + 7 <= size; j++) {
        const pattern = [true, false, true, true, true, false, true];
        if (!pattern.every((dark, k) => get(i, j + k) === dark)) continue;
        const lightBefore = j >= 4 && [1, 2, 3, 4].every((k) => !get(i, j - k));
        const lightAfter = j + 11 <= size && [7, 8, 9, 10].every((k) => !get(i, j + k));
        if (lightBefore || lightAfter) score += 40;
      }
    }
  };
  line((i, j) => modules[i][j]);
  line((i, j) => modules[j][i]);
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1])
        score += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/** Encode `text` as a QR code matrix (rows of modules, true = dark), without quiet zone. */
export function encodeQrCode(text: string): boolean[][] {
  const bytes = utf8Bytes(text);
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    const headerBits = 4 + (version <= 9 ? 8 : 16);
    if (headerBits + bytes.length * 8 <= numDataCodewords(version) * 8) break;
  }
  if (version > MAX_VERSION) throw new QrCodeTooLongError();
  const codewords = addEccAndInterleave(encodeData(bytes, version), version);
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = newMatrix(version);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormatBits(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return (best as Matrix).modules;
}
