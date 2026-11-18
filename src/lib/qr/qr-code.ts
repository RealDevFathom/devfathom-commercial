/**
 * DEV-748: a small QR Code (ISO/IEC 18004) encoder for printing loyalty cards. It covers what a
 * card needs and nothing more: byte mode, error-correction level M (about 15% of the symbol can
 * be damaged and still read), versions 1 to 10 (up to 213 bytes). Pure and deterministic, so the
 * same text always yields the same symbol, on the server or in the browser.
 *
 * The structure follows the standard: function patterns, Reed-Solomon error correction over
 * GF(256) with interleaved blocks, the zig-zag codeword placement, and the mask with the lowest
 * penalty score.
 */

/** Dark modules are `true`. `modules[y][x]`, top-left origin, no quiet zone. */
export type QrMatrix = boolean[][];

const MAX_VERSION = 10;
// Error-correction level M, indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
// The two format bits for level M are 00.
const ECC_FORMAT_BITS_M = 0;

const getBit = (value: number, index: number) => ((value >>> index) & 1) !== 0;

function numRawDataModules(version: number) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number) {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[version]! * NUM_ERROR_CORRECTION_BLOCKS[version]!
  );
}

function gfMultiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number) {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

function alignmentPositions(version: number, size: number) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < numAlign; position -= step)
    result.splice(1, 0, position);
  return result;
}

/** The data codewords for `bytes` at `version`: byte-mode segment, terminator and padding. */
function dataCodewords(bytes: Uint8Array, version: number) {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacityBits = numDataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  return codewords;
}

function interleaveWithEcc(data: readonly number[], version: number) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version]!;
  const blockEccLength = ECC_CODEWORDS_PER_BLOCK[version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);
  const divisor = reedSolomonDivisor(blockEccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const block = data.slice(
      k,
      k + shortBlockLength - blockEccLength + (i < numShortBlocks ? 0 : 1)
    );
    k += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < numShortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    blocks.forEach((block, j) => {
      // Short blocks carry a placeholder where long blocks have their last data codeword.
      if (i !== shortBlockLength - blockEccLength || j >= numShortBlocks) result.push(block[i]!);
    });
  return result;
}

function maskApplies(mask: number, x: number, y: number) {
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

/** The standard's penalty score; the encoder keeps the mask that scores lowest. */
export function qrPenaltyScore(modules: QrMatrix) {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]!);
    lines.push(modules.map((row) => row[i]!));
  }
  const finderLike = [true, false, true, true, true, false, true];
  for (const line of lines) {
    // Rule 1: runs of five or more same-colour modules.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // Rule 3: a finder-like 1:1:3:1:1 pattern with four light modules on one side.
    const light = (i: number) => i < 0 || i >= size || !line[i];
    for (let i = 0; i + 7 <= size; i++) {
      if (!finderLike.every((dark, j) => line[i + j] === dark)) continue;
      const before = [1, 2, 3, 4].every((d) => light(i - d));
      const after = [0, 1, 2, 3].every((d) => light(i + 7 + d));
      if (before || after) score += 40;
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const colour = modules[y]![x];
      if (
        modules[y]![x + 1] === colour &&
        modules[y + 1]![x] === colour &&
        modules[y + 1]![x + 1] === colour
      )
        score += 3;
    }
  // Rule 4: balance of dark and light modules.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

class QrBuilder {
  readonly size: number;
  readonly modules: QrMatrix;
  private readonly isFunction: boolean[][];

  constructor(private readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    );
  }

  private setFunction(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size)
            this.setFunction(x, y, distance !== 2 && distance !== 4);
        }
    const positions = alignmentPositions(this.version, size);
    const last = positions.length - 1;
    positions.forEach((cx, i) =>
      positions.forEach((cy, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      })
    );
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask: number) {
    const { size } = this;
    const data = (ECC_FORMAT_BITS_M << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i));
    this.setFunction(8, size - 8, true);
  }

  private drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(codewords: readonly number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (!this.isFunction[y]![x] && i < codewords.length * 8) {
            this.modules[y]![x] = getBit(codewords[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.isFunction[y]![x] && maskApplies(mask, x, y))
          this.modules[y]![x] = !this.modules[y]![x];
  }
}

/**
 * Encodes `text` (UTF-8) as a QR symbol at error-correction level M, in the smallest version
 * that holds it. Throws for text longer than version 10 holds.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (
    version <= MAX_VERSION &&
    4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > numDataCodewords(version) * 8
  )
    version++;
  if (version > MAX_VERSION) throw new RangeError('Text is too long for this QR encoder.');
  const codewords = interleaveWithEcc(dataCodewords(bytes, version), version);
  const builder = new QrBuilder(version);
  builder.drawFunctionPatterns();
  builder.drawCodewords(codewords);
  let best: { mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    builder.applyMask(mask);
    builder.drawFormatBits(mask);
    const score = qrPenaltyScore(builder.modules);
    if (!best || score < best.score) best = { mask, score };
    builder.applyMask(mask); // XOR again to undo.
  }
  builder.applyMask(best!.mask);
  builder.drawFormatBits(best!.mask);
  return builder.modules.map((row) => [...row]);
}

/** One SVG path drawing every dark module as a unit square, offset by `margin` modules. */
export function qrSvgPath(modules: QrMatrix, margin = 4): string {
  const parts: string[] = [];
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`);
    })
  );
  return parts.join('');
}
