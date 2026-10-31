import { describe, expect, it } from 'vitest';

import { parseShelfLabelCode, shelfLabelBarcodeSvg, shelfLabelCode } from './shelf-label-code';

/** Code128 widths, re-declared here so the test does not trust the encoder's own table. */
const REFERENCE: Record<number, string> = {
  0: '212222',
  12: '112232',
  66: '121421',
  71: '122114',
  105: '211232',
};

function decodeRuns(svg: string): number[] {
  const rects = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="24"\/>/g)].map(
    (match) => ({ x: Number(match[1]), width: Number(match[2]) })
  );
  const runs: number[] = [];
  let cursor = rects[0]!.x;
  for (const rect of rects) {
    if (rect.x > cursor) runs.push(rect.x - cursor);
    runs.push(rect.width);
    cursor = rect.x + rect.width;
  }
  return runs;
}

describe('#719 internal shelf-label code', () => {
  it('formats a lot alias as a sixteen-digit code that is never a GTIN length', () => {
    expect(shelfLabelCode(1)).toBe('7100000000000001');
    expect(shelfLabelCode(2_147_483_647)).toBe('7100002147483647');
    expect(shelfLabelCode(42)).toHaveLength(16);
  });

  it('round-trips through the scanner and ignores surrounding whitespace', () => {
    expect(parseShelfLabelCode(shelfLabelCode(123_456))).toBe(123_456);
    expect(parseShelfLabelCode(` ${shelfLabelCode(9)}\n`)).toBe(9);
  });

  it('refuses manufacturer codes, other prefixes and out-of-range aliases', () => {
    for (const value of [
      '8964000000017', // EAN-13
      '08964000000017', // GTIN-14
      '0101234567890128', // GS1 AI string
      '7200000000000001',
      '7100000000000000',
      '7100002147483648',
      '71000000000001',
      'abc',
      '',
    ]) {
      expect(parseShelfLabelCode(value)).toBeNull();
    }
    expect(() => shelfLabelCode(0)).toThrow();
    expect(() => shelfLabelCode(-1)).toThrow();
    expect(() => shelfLabelCode(1.5)).toThrow();
    expect(() => shelfLabelCode(2_147_483_648)).toThrow();
  });

  it('encodes a valid Code128-C symbol with checksum, stop and quiet zones', () => {
    const code = '7100000000000012';
    const svg = shelfLabelBarcodeSvg(code);
    expect(svg).toContain('viewBox="0 0 143 24"');
    expect(svg).toContain(`aria-label="Lot barcode ${code}"`);

    const runs = decodeRuns(svg);
    // 10 symbols × 6 runs + a 7-run stop.
    expect(runs).toHaveLength(67);
    const symbols = Array.from({ length: 10 }, (_, index) =>
      runs.slice(index * 6, index * 6 + 6).join('')
    );
    const data = [71, 0, 0, 0, 0, 0, 0, 12];
    const checksum = (105 + data.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
    expect(checksum).toBe(66);
    expect(symbols[0]).toBe(REFERENCE[105]);
    expect(symbols[1]).toBe(REFERENCE[71]);
    expect(symbols.slice(2, 8)).toEqual(Array(6).fill(REFERENCE[0]));
    expect(symbols[8]).toBe(REFERENCE[12]);
    expect(symbols[9]).toBe(REFERENCE[checksum]);
    expect(runs.slice(60).join('')).toBe('2331112');
  });

  it('refuses to draw anything that is not an internal label code', () => {
    expect(() => shelfLabelBarcodeSvg('8964000000017')).toThrow();
    expect(() => shelfLabelBarcodeSvg('<script>')).toThrow();
  });
});
