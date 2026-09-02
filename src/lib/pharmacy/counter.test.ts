import { describe, expect, it } from 'vitest';

import { renderStrengthValue } from './counter';

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
