import { describe, expect, it } from 'vitest';

import { counterMedicineDisplayName, counterMedicineGenericName } from './counter-display-name';

describe('counter medicine identity', () => {
  it('puts the brand first and retains a separate generic', () => {
    const medicine = { brandName: ' Panadol ', displayName: 'Paracetamol' };
    expect(counterMedicineDisplayName(medicine)).toBe('Panadol');
    expect(counterMedicineGenericName(medicine)).toBe('Paracetamol');
  });

  it.each([null, undefined, '', '   '])(
    'falls back without an empty generic row for %j',
    (brandName) => {
      expect(counterMedicineDisplayName({ brandName, displayName: 'Paracetamol' })).toBe(
        'Paracetamol'
      );
      expect(counterMedicineGenericName({ brandName, displayName: 'Paracetamol' })).toBeNull();
    }
  );

  it('does not repeat identical brand and generic names', () => {
    expect(counterMedicineGenericName({ brandName: 'PANADOL', displayName: 'Panadol' })).toBeNull();
  });
});
