import { describe, expect, it } from 'vitest';
import { amountInputError, amountInputToMinor, amountInputUnit } from './money-input';

describe('amountInputToMinor', () => {
  it.each([
    ['125.50', 12550],
    ['125.5', 12550],
    ['0.05', 5],
    ['0.29', 29],
    ['1000000.00', 100000000],
    ['1000', 100000],
    ['  42.10  ', 4210],
    ['0', 0],
    ['007.01', 701],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('reads %s as %i minor units exactly', (raw, minor) => {
    expect(amountInputToMinor(raw)).toEqual({ status: 'OK', minor });
  });

  it('treats an empty or blank field as empty, not zero', () => {
    expect(amountInputToMinor('')).toEqual({ status: 'EMPTY' });
    expect(amountInputToMinor('   ')).toEqual({ status: 'EMPTY' });
  });

  it.each([
    ['125.505', 'DECIMALS'],
    ['0.001', 'DECIMALS'],
    ['-1', 'NEGATIVE'],
    ['-0.50', 'NEGATIVE'],
    ['1,000', 'FORMAT'],
    ['+5', 'FORMAT'],
    ['1e3', 'FORMAT'],
    ['.50', 'FORMAT'],
    ['12.', 'FORMAT'],
    ['Rs 10', 'FORMAT'],
    ['90071992547409.92', 'TOO_LARGE'],
  ])('rejects %s (%s) instead of rounding it', (raw, reason) => {
    expect(amountInputToMinor(raw)).toEqual({ status: 'INVALID', reason });
  });

  it('explains each refusal in plain words', () => {
    expect(amountInputError('DECIMALS')).toContain('2 decimal places');
    expect(amountInputError('NEGATIVE')).toContain('0 or more');
    expect(amountInputError('FORMAT')).toContain('125.50');
  });
});

describe('amountInputUnit', () => {
  it('says rupees only for PKR and never names paisa or rupees for another currency', () => {
    expect(amountInputUnit('PKR')).toBe('rupees');
    expect(amountInputUnit('USD')).toBe('USD');
    expect(amountInputUnit('')).toBe('chosen currency');
    expect(amountInputUnit('usd')).toBe('chosen currency');
    for (const code of ['USD', 'AED', '', null]) {
      expect(amountInputUnit(code)).not.toMatch(/paisa|rupee/i);
    }
  });
});
