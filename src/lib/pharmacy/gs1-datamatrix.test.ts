import { describe, expect, it } from 'vitest';

import {
  gtinCheckDigit,
  gs1Year,
  packIsExpired,
  parseGs1DataMatrix,
  receivedPacksForScan,
} from './gs1-datamatrix';

const NOW = new Date('2026-10-21T00:00:00.000Z');
const GS = '\u001d';
const GTIN = '08961234567894';

function elementString(parts: string) {
  return parseGs1DataMatrix(parts, NOW);
}

describe('gtinCheckDigit', () => {
  it('matches the mod-10 samples used by the stock-in spec', () => {
    expect(gtinCheckDigit('0896123456789')).toBe(4);
    expect(gtinCheckDigit('0890123456789')).toBe(0);
    expect(gtinCheckDigit('0003896123400000001')).toBe(1);
  });
});

describe('gs1Year', () => {
  it('uses the sliding window around the current year', () => {
    expect(gs1Year(26, NOW)).toBe(2026);
    expect(gs1Year(76, NOW)).toBe(2076);
    expect(gs1Year(77, NOW)).toBe(1977);
    expect(gs1Year(0, NOW)).toBe(2000);
  });
});

describe('parseGs1DataMatrix', () => {
  it('parses the synthetic DRAP secondary-pack sample', () => {
    const payload = `]d201${GTIN}1727123110ABCD1234${GS}21A3F09C1E77B2`;
    expect(elementString(payload)).toEqual({
      kind: 'parsed',
      fields: {
        gtin: GTIN,
        gtin13: GTIN.slice(1),
        batch: 'ABCD1234',
        expiry: '271231',
        expiryDate: '2027-12-31',
        serial: 'A3F09C1E77B2',
        unknownAis: [],
        warnings: [],
      },
    });
  });

  it('parses a reordered string with a lowercase serial and a final batch', () => {
    const payload = `01${GTIN}21a3f09c1e77b2${GS}1728063010LOT-7`;
    expect(elementString(payload)).toMatchObject({
      kind: 'parsed',
      fields: {
        gtin: GTIN,
        expiry: '280630',
        expiryDate: '2028-06-30',
        batch: 'LOT-7',
        serial: 'a3f09c1e77b2',
        warnings: [],
      },
    });
  });

  it.each([']C1', ']Q3'])('strips the %s symbology prefix and a leading FNC1', (prefix) => {
    const payload = `${prefix}${GS}01${GTIN}1727123110ABCD1234${GS}21A3F09C1E77B2`;
    expect(elementString(payload)).toMatchObject({
      kind: 'parsed',
      fields: { gtin: GTIN, serial: 'A3F09C1E77B2' },
    });
  });

  it.each(['<GS>', '|', '~'])('accepts %s as a group separator', (separator) => {
    const payload = `01${GTIN}1727123110ABCD1234${separator}21A3F09C1E77B2`;
    expect(elementString(payload)).toMatchObject({
      kind: 'parsed',
      fields: { batch: 'ABCD1234', serial: 'A3F09C1E77B2' },
    });
  });

  it('reads day 00 as the last day of the month and warns', () => {
    expect(elementString(`(01)${GTIN}(17)271200(10)ABCD1234`)).toEqual({
      kind: 'parsed',
      fields: {
        gtin: GTIN,
        gtin13: GTIN.slice(1),
        batch: 'ABCD1234',
        expiry: '271200',
        expiryDate: '2027-12-31',
        serial: null,
        unknownAis: [],
        warnings: [
          {
            code: 'EXPIRY_END_OF_MONTH',
            message: 'Expiry day 00 was read as the last day of the month.',
          },
        ],
      },
    });
  });

  it('uses 29 February when day 00 falls in a leap year', () => {
    const parsed = elementString(`(01)${GTIN}(17)240200`);
    if (parsed.kind !== 'parsed') throw new Error('expected a parsed expiry');
    expect(parsed.fields).toMatchObject({
      expiry: '240200',
      expiryDate: '2024-02-29',
    });
  });

  it('warns, and does not reject, a short or non-hex serial', () => {
    const parsed = elementString(`(01)${GTIN}(21)SERIAL-9`);
    expect(parsed).toMatchObject({
      kind: 'parsed',
      fields: { serial: 'SERIAL-9' },
    });
    if (parsed.kind !== 'parsed') throw new Error('expected a parsed serial');
    expect(parsed.fields.warnings.map((warning) => warning.code)).toEqual(['SERIAL_FORMAT']);
  });

  it('keeps other known AIs and still requires a GTIN', () => {
    expect(elementString(`(01)${GTIN}(11)260101(240)SUPPLIER-CODE`)).toMatchObject({
      kind: 'parsed',
      fields: {
        gtin: GTIN,
        unknownAis: [
          { ai: '11', value: '260101' },
          { ai: '240', value: 'SUPPLIER-CODE' },
        ],
      },
    });
    expect(elementString(`]d200038961234000000011`)).toEqual({
      kind: 'invalid',
      reason: 'A pack-level GTIN (AI 01) is required.',
    });
  });

  it.each([
    [`]d201${GTIN.slice(0, 10)}`, 'GS1 AI 01 is truncated.'],
    ['(17)251231(10)LOT-7', 'A pack-level GTIN (AI 01) is required.'],
    [`(01)${GTIN.slice(0, 13)}5`, 'GTIN check digit does not match.'],
    ['(01)08901234567890(17)250231', 'Expiry (AI 17) is not a valid YYMMDD date.'],
    [`01${GTIN}99FOO`, 'Unknown AI 99 cannot be read. Enter the pack by hand.'],
    [`(01)${GTIN}(10)${'A'.repeat(21)}`, 'GS1 AI 10 has an invalid length.'],
  ])('rejects %s', (payload, reason) => {
    expect(elementString(payload)).toEqual({ kind: 'invalid', reason });
  });

  it('rejects a repeated core AI', () => {
    expect(elementString(`(01)${GTIN}(01)${GTIN}`)).toEqual({
      kind: 'invalid',
      reason: 'GS1 AI 01 is repeated.',
    });
    expect(elementString(`01${GTIN}01${GTIN}`)).toEqual({
      kind: 'invalid',
      reason: 'GS1 AI 01 is repeated.',
    });
    expect(elementString(`(01)${GTIN}(17)271231(17)280101`)).toEqual({
      kind: 'invalid',
      reason: 'GS1 AI 17 is repeated.',
    });
  });

  it('rejects a variable AI that runs into the next AI without a separator', () => {
    expect(elementString(`01${GTIN}10ABCD123417271231`)).toEqual({
      kind: 'invalid',
      reason: 'GS1 AI 10 is not terminated before the next AI.',
    });
    expect(elementString(`01${GTIN}21A3F09C1E77B217271231`)).toEqual({
      kind: 'invalid',
      reason: 'GS1 AI 21 is not terminated before the next AI.',
    });
  });

  it('warns when the pack expires within 90 days and does not warn on a far date', () => {
    const near = elementString(`(01)${GTIN}(17)261130(10)EXP-NEAR-1`);
    if (near.kind !== 'parsed') throw new Error('expected a parsed near-expiry pack');
    expect(near.fields.warnings.map((warning) => warning.code)).toContain('NEAR_EXPIRY');
    const far = elementString(`(01)${GTIN}(17)271231(10)ABCD1234`);
    if (far.kind !== 'parsed') throw new Error('expected a parsed far pack');
    expect(far.fields.warnings.map((warning) => warning.code)).not.toContain('NEAR_EXPIRY');
  });

  it('treats a past calendar day as expired and a serialized scan as one pack', () => {
    expect(packIsExpired(new Date('2025-12-31T00:00:00.000Z'), NOW)).toBe(true);
    expect(packIsExpired(new Date('2026-11-30T00:00:00.000Z'), NOW)).toBe(false);
    expect(receivedPacksForScan('A3F09C1E77B2', 10)).toBe(1);
    expect(receivedPacksForScan(null, 10)).toBe(10);
  });

  it.each(['', '8901234567890', 'ABC-123', ']E012345'])('classifies %s as non-GS1', (payload) => {
    expect(parseGs1DataMatrix(payload, NOW).kind).toBe('not-gs1');
  });

  it('still parses the pack-authentication sample', () => {
    expect(elementString(']d201089012345678901725123110LOT-7\u001d21SERIAL-9')).toMatchObject({
      kind: 'parsed',
      fields: {
        gtin: '08901234567890',
        gtin13: '8901234567890',
        expiry: '251231',
        expiryDate: '2025-12-31',
        batch: 'LOT-7',
        serial: 'SERIAL-9',
      },
    });
    expect(elementString('(01)08901234567890(240)SUPPLIER-CODE')).toMatchObject({
      kind: 'parsed',
      fields: { unknownAis: [{ ai: '240', value: 'SUPPLIER-CODE' }] },
    });
  });
});
