import { describe, expect, it } from 'vitest';

import { parseGs1DataMatrix } from './gs1-datamatrix';

describe('parseGs1DataMatrix', () => {
  it.each([
    [']d201089012345678901725123110LOT-7\u001d21SERIAL-9', '08901234567890'],
    ['(01)08901234567890(17)251231(10)LOT-7(21)SERIAL-9', '08901234567890'],
  ])('parses valid pack payload %s', (payload, gtin) => {
    expect(parseGs1DataMatrix(payload)).toEqual({
      kind: 'parsed',
      fields: {
        gtin,
        expiry: '251231',
        batch: 'LOT-7',
        serial: 'SERIAL-9',
        unknownAis: [],
      },
    });
  });

  it.each([
    [']d20108901234', 'GS1 AI 01 is truncated.'],
    ['(17)251231(10)LOT-7', 'A pack-level GTIN (AI 01) is required.'],
    [']d20208901234567890', 'Unknown AI 02 cannot be safely delimited.'],
  ])('rejects malformed or wrong-AI payload %s', (payload, reason) => {
    expect(parseGs1DataMatrix(payload)).toEqual({ kind: 'invalid', reason });
  });

  it('preserves unknown AIs when parenthesized notation makes their boundary unambiguous', () => {
    expect(parseGs1DataMatrix('(01)08901234567890(240)SUPPLIER-CODE')).toMatchObject({
      kind: 'parsed',
      fields: { unknownAis: [{ ai: '240', value: 'SUPPLIER-CODE' }] },
    });
  });

  it.each(['', '8901234567890', 'ABC-123', ']E012345'])('classifies %s as non-GS1', (payload) => {
    expect(parseGs1DataMatrix(payload).kind).toBe('not-gs1');
  });

  it('rejects an impossible expiry date', () => {
    expect(parseGs1DataMatrix('(01)08901234567890(17)250231')).toEqual({
      kind: 'invalid',
      reason: 'Expiry (AI 17) is not a valid YYMMDD date.',
    });
  });
});
