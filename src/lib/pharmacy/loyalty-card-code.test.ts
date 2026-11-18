import { describe, expect, it } from 'vitest';

import {
  formatLoyaltyCardCode,
  looksLikeLoyaltyCardCode,
  normalizeLoyaltyCardCode,
} from './loyalty-card-code';

const CODE = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';

describe('DEV-748 loyalty card code format', () => {
  it('accepts a scanned code in any case, with spaces or hyphens', () => {
    expect(normalizeLoyaltyCardCode(CODE)).toBe(CODE);
    expect(normalizeLoyaltyCardCode(CODE.toLowerCase())).toBe(CODE);
    expect(normalizeLoyaltyCardCode(` ${formatLoyaltyCardCode(CODE)} `)).toBe(CODE);
    expect(normalizeLoyaltyCardCode('DFLC-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ')).toBe(CODE);
  });

  it('refuses anything else: phone numbers, barcodes, wrong length or alphabet', () => {
    for (const text of [
      '03001234567',
      '8964000123456',
      `${CODE}A`,
      CODE.slice(0, -1),
      'DFLC00000000000000000000000000',
      'XFLCABCDEFGHIJKLMNOPQRSTUVWXYZ',
      `${CODE}${' '.repeat(60)}`,
    ])
      expect(normalizeLoyaltyCardCode(text)).toBeNull();
  });

  it('recognises a card code while the scanner is still typing it', () => {
    expect(looksLikeLoyaltyCardCode('dfl')).toBe(false);
    expect(looksLikeLoyaltyCardCode('dflc')).toBe(true);
    expect(looksLikeLoyaltyCardCode('DFLCAB')).toBe(true);
    expect(looksLikeLoyaltyCardCode('Panadol')).toBe(false);
  });

  it('prints the code in groups of four for manual entry', () => {
    expect(formatLoyaltyCardCode(CODE)).toBe('DFLC ABCD EFGH IJKL MNOP QRST UVWX YZ');
  });
});
