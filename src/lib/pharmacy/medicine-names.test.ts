import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  containsMedicineName,
  MEDICINE_NAME_QUERY_LIMIT,
  medicineNameSet,
  medicineNameVariants,
  normalizeNameText,
  readTenantMedicineNames,
} from './medicine-names';

describe('medicine names', () => {
  it('normalizes case, accents and punctuation', () => {
    expect(normalizeNameText('  Pañadol-EXTRA (500mg) ')).toBe('panadol extra 500mg');
  });

  it('keeps the name before a strength and drops names shorter than 3 characters', () => {
    expect(medicineNameVariants('Panadol Extra 500mg Tablet')).toEqual([
      'panadol extra 500mg tablet',
      'panadol extra',
    ]);
    expect(medicineNameVariants('Q')).toEqual([]);
    expect(medicineNameVariants('AB 10')).toEqual(['ab 10']);
  });

  it('matches whole words only, across spelling variants', () => {
    const names = medicineNameSet(['Panadol 500mg', 'Paracetamol', 'Brufen', null, 'پیناڈول']);
    expect(containsMedicineName('New PANADOL stock is in! Reply STOP to opt out.', names)).toBe(
      true
    );
    expect(containsMedicineName('paracetamol.', names)).toBe(true);
    expect(containsMedicineName('پیناڈول اب دستیاب ہے', names)).toBe(true);
    expect(containsMedicineName('Our Brufenstore is open', names)).toBe(false);
    expect(containsMedicineName('Welcome to our store. Reply STOP to opt out.', names)).toBe(false);
  });

  it('reads product, brand, alias and ingredient names with bounded queries', async () => {
    const medicine = vi.fn(async () => [
      { productName: 'Panadol Extra 500mg', brandName: 'Panadol' },
      { productName: 'Calpol Syrup', brandName: null },
    ]);
    const alias = vi.fn(async () => [{ value: 'Paracetamol' }, { value: 'پیناڈول' }]);
    const ingredient = vi.fn(async () => [{ name: 'Ibuprofen' }]);
    const db = {
      medicine: { findMany: medicine },
      medicineAlias: { findMany: alias },
      ingredient: { findMany: ingredient },
    } as unknown as ScopedDb;
    const names = await readTenantMedicineNames(db);
    expect([...names]).toEqual(
      expect.arrayContaining([
        'panadol extra',
        'panadol',
        'calpol syrup',
        'paracetamol',
        'پیناڈول',
        'ibuprofen',
      ])
    );
    for (const call of [medicine, alias, ingredient])
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ take: MEDICINE_NAME_QUERY_LIMIT })
      );
    expect(alias).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: { not: 'LEGACY_CODE' } } })
    );
  });
});
