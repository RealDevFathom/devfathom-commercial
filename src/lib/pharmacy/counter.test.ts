import { describe, expect, it } from 'vitest';

import { compareCounterRows, counterMatchRank, renderStrengthValue } from './counter';

describe('renderStrengthValue (POS-02 strength display)', () => {
  it('never trims a trailing zero that carries magnitude', () => {
    // The defect this guards: a positional trailing-zero trim turns 500 into 5,
    // a hundredfold strength error on the field a pharmacist reads back.
    expect(renderStrengthValue('500')).toBe('500');
    expect(renderStrengthValue('50')).toBe('50');
    expect(renderStrengthValue('1000')).toBe('1000');
    expect(renderStrengthValue(500)).toBe('500');
  });

  it('trims only fractional trailing zeros, as a Decimal renders them', () => {
    expect(renderStrengthValue('500.000000')).toBe('500');
    expect(renderStrengthValue('2.500000')).toBe('2.5');
    expect(renderStrengthValue('0.125000')).toBe('0.125');
    expect(renderStrengthValue('10.00')).toBe('10');
  });

  it('leaves a value with no trailing zeros untouched', () => {
    expect(renderStrengthValue('2.5')).toBe('2.5');
    expect(renderStrengthValue('125')).toBe('125');
  });
});

describe('counter search ranking (DEV-500)', () => {
  const sort = (rows: Parameters<typeof compareCounterRows>[0][], q: string) =>
    [...rows].sort((a, b) => compareCounterRows(a, b, q));

  it('ranks prefix matches above substring matches', () => {
    const rows = [
      {
        displayName: 'Co-Paracetamol',
        brandName: null,
        matchedOn: 'NAME' as const,
        onHandUnits: 9,
      },
      { displayName: 'Paracetamol', brandName: null, matchedOn: 'NAME' as const, onHandUnits: 0 },
    ];
    expect(sort(rows, 'para').map((r) => r.displayName)).toEqual(['Paracetamol', 'Co-Paracetamol']);
  });

  it('puts the branded product before the generic reached by alias', () => {
    const rows = [
      { displayName: 'Paracetamol', brandName: null, matchedOn: 'ALIAS' as const, onHandUnits: 50 },
      {
        displayName: 'Paracetamol',
        brandName: 'Panadol',
        matchedOn: 'NAME' as const,
        onHandUnits: 1,
      },
    ];
    expect(sort(rows, 'panadol')[0]!.brandName).toBe('Panadol');
  });

  it('keeps a barcode hit first and falls back to stock then name', () => {
    expect(
      counterMatchRank({ displayName: 'X', brandName: null, matchedOn: 'BARCODE' }, 'zz')
    ).toBe(0);
    const rows = [
      { displayName: 'B', brandName: null, matchedOn: 'INGREDIENT' as const, onHandUnits: 0 },
      { displayName: 'A', brandName: null, matchedOn: 'INGREDIENT' as const, onHandUnits: 0 },
      { displayName: 'C', brandName: null, matchedOn: 'INGREDIENT' as const, onHandUnits: 3 },
    ];
    expect(sort(rows, 'zz').map((r) => r.displayName)).toEqual(['C', 'A', 'B']);
  });
});
