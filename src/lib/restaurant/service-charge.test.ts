import { describe, expect, it } from 'vitest';

import { serviceChargeFor } from './service-charge';

describe('serviceChargeFor', () => {
  it('uses exact decimal arithmetic and half-up money rounding', () => {
    expect(serviceChargeFor('10.05', '0.10').toFixed(2)).toBe('1.01');
  });

  it.each([
    ['negative basis', '-0.01', '0.10'],
    ['negative rate', '10.00', '-0.01'],
    ['rate above one', '10.00', '1.01'],
  ])('rejects a %s', (_case, basis, rate) => {
    expect(() => serviceChargeFor(basis, rate)).toThrow(RangeError);
  });
});
