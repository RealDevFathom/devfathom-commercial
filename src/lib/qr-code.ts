// Small, dependency-free QR encoder for the MFA enrolment screen. It deliberately
// supports one conservative profile: Version 8, error correction L, byte mode.
// That profile holds 192 payload bytes and keeps the security-sensitive URI local.

const SIZE = 49;
const DATA_CODEWORDS = 194;
const EC_CODEWORDS = 24;
const ALIGNMENT = [6, 24, 42];

function multiply(a: number, b: number) {
  let result = 0;
  while (b) {
    if (b & 1) result ^= a;
    b >>>= 1;
    a = (a << 1) ^ ((a & 0x80) ? 0x11d : 0);
  }
  return result;
}

function polynomial(degree: number) {
  let result = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array(result.length + 1).fill(0) as number[];
    result.forEach((value, index) => {
      next[index] ^= value;
      next[index + 1] ^= multiply(value, root);
    });
    result = next;
    root = multiply(root, 2);
  }
  return result;
}

function errorCorrection(data: number[]) {
  const generator = polynomial(EC_CODEWORDS);
  const remainder = new Array(EC_CODEWORDS).fill(0) as number[];
  for (const value of data) {
    const factor = value ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < EC_CODEWORDS; i++) remainder[i] ^= multiply(generator[i + 1], factor);
  }
  return remainder;
}

function append(bits: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function codewords(value: string) {
  const bytes = [...new TextEncoder().encode(value)];
  if (bytes.length > 192) {
    throw new Error('The authenticator URI is too long to display as a QR code.');
  }
  const bits: number[] = [];
  append(bits, 0b0100, 4);
  append(bits, bytes.length, 8);
  bytes.forEach((byte) => append(bits, byte, 8));
  append(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < DATA_CODEWORDS; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  const blocks = [data.slice(0, 97), data.slice(97)];
  const ec = blocks.map(errorCorrection);
  const result: number[] = [];
  for (let i = 0; i < 97; i++) blocks.forEach((block) => result.push(block[i]));
  for (let i = 0; i < EC_CODEWORDS; i++) ec.forEach((block) => result.push(block[i]));
  return result.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
}

function formatBits(mask: number) {
  let value = (0b01 << 3) | mask; // L error correction level
  let remainder = value << 10;
  for (let i = 14; i >= 10; i--) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  return ((value << 10) | remainder) ^ 0x5412;
}

function versionBits() {
  let remainder = 8 << 12;
  for (let i = 17; i >= 12; i--) if ((remainder >>> i) & 1) remainder ^= 0x1f25 << (i - 12);
  return (8 << 12) | remainder;
}

function build(value: string, mask: number) {
  const modules = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const reserved = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const set = (row: number, col: number, dark: boolean, reserve = true) => {
    if (row >= 0 && row < SIZE && col >= 0 && col < SIZE) {
      modules[row][col] = dark;
      if (reserve) reserved[row][col] = true;
    }
  };
  const finder = (row: number, col: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const inFinder = y >= 0 && y <= 6 && x >= 0 && x <= 6;
        const dark =
          inFinder &&
          (y === 0 ||
            y === 6 ||
            x === 0 ||
            x === 6 ||
            (y >= 2 && y <= 4 && x >= 2 && x <= 4));
        set(row + y, col + x, dark);
      }
    }
  };
  finder(0, 0);
  finder(0, SIZE - 7);
  finder(SIZE - 7, 0);
  for (let i = 8; i < SIZE - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const row of ALIGNMENT) {
    for (const col of ALIGNMENT) {
      if (reserved[row][col]) continue;
      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
          set(row + y, col + x, Math.max(Math.abs(x), Math.abs(y)) !== 1);
        }
      }
    }
  }
  const format = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = Boolean((format >>> i) & 1);
    const verticalRow = i < 6 ? i : i < 8 ? i + 1 : SIZE - 15 + i;
    const horizontalCol = i < 8 ? SIZE - i - 1 : i === 8 ? 8 : 14 - i;
    set(verticalRow, 8, bit);
    set(8, horizontalCol, bit);
  }
  set(SIZE - 8, 8, true);
  const version = versionBits();
  for (let i = 0; i < 18; i++) {
    const bit = Boolean((version >>> i) & 1);
    set(Math.floor(i / 3), SIZE - 11 + (i % 3), bit);
    set(SIZE - 11 + (i % 3), Math.floor(i / 3), bit);
  }
  const bits = codewords(value);
  const masked = (row: number, col: number) =>
    [
      (row + col) % 2 === 0,
      row % 2 === 0,
      col % 3 === 0,
      (row + col) % 3 === 0,
      (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
      ((row * col) % 2) + ((row * col) % 3) === 0,
      (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
      (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
    ][mask];
  let index = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let step = 0; step < SIZE; step++) {
      const row = ((right + 1) & 2) === 0 ? SIZE - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (!reserved[row][col]) modules[row][col] = Boolean(bits[index++] ?? 0) !== masked(row, col);
      }
    }
  }
  return modules;
}

function penalty(modules: boolean[][]) {
  let score = 0;
  const lines = [...modules, ...modules[0].map((_, col) => modules.map((row) => row[col]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i < SIZE; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
    const text = line.map(Number).join('');
    score += (text.match(/1011101/g)?.length ?? 0) * 40;
  }
  for (let row = 0; row < SIZE - 1; row++) {
    for (let col = 0; col < SIZE - 1; col++) {
      const sum =
        Number(modules[row][col]) +
        Number(modules[row + 1][col]) +
        Number(modules[row][col + 1]) +
        Number(modules[row + 1][col + 1]);
      if (sum === 0 || sum === 4) score += 3;
    }
  }
  const dark = modules.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 100 / (SIZE * SIZE) - 50) / 5) * 10;
  return score;
}

export function qrCodeModules(value: string): boolean[][] {
  const candidates = Array.from({ length: 8 }, (_, mask) => build(value, mask));
  return candidates.reduce((best, candidate) =>
    penalty(candidate) < penalty(best) ? candidate : best,
  );
}
