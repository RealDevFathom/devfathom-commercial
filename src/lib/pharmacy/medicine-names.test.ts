import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  containsMedicineName,
  MEDICINE_NAME_MAX_ROWS,
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

  it('also cuts at dose-form and unit words, in English, Roman Urdu and Urdu', () => {
    expect(medicineNameVariants('Calpol Syrup 120ml')).toEqual(['calpol syrup 120ml', 'calpol']);
    expect(medicineNameVariants('Augmentin Tab')).toEqual(['augmentin tab', 'augmentin']);
    expect(medicineNameVariants('Brufen Suspension')).toEqual(['brufen suspension', 'brufen']);
    expect(medicineNameVariants('Ventolin Inj')).toEqual(['ventolin inj', 'ventolin']);
    expect(medicineNameVariants('Polyfax Ointment')).toEqual(['polyfax ointment', 'polyfax']);
    expect(medicineNameVariants('Panadol mg')).toEqual(['panadol mg', 'panadol']);
    expect(medicineNameVariants('Calpol Sharbat')).toEqual(['calpol sharbat', 'calpol']);
    expect(medicineNameVariants('کالپول شربت')).toEqual(['کالپول شربت', 'کالپول']);
    expect(medicineNameVariants('Syrup Calpol')).toEqual(['syrup calpol']);
  });

  it('keeps the length and stopword safety for the cut name', () => {
    expect(medicineNameVariants('Eye Drops 10ml')).toEqual(['eye drops 10ml']);
    expect(medicineNameVariants('Baby Syrup')).toEqual(['baby syrup']);
    expect(medicineNameVariants('Cough Syrup')).toEqual(['cough syrup']);
    expect(medicineNameVariants('Zo Tablets')).toEqual(['zo tablets']);
    const names = medicineNameSet(['Eye Drops 10ml', 'Calpol Syrup 120ml']);
    expect(containsMedicineName('Get your eye checked at our store.', names)).toBe(false);
    expect(containsMedicineName('Calpol is back in stock.', names)).toBe(true);
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

  it('reads every page by id cursor, tenant-scoped, and logs a truncated source', async () => {
    const pageOf = (start: number, size: number) =>
      Array.from({ length: size }, (_, i) => ({
        id: `m${String(start + i).padStart(7, '0')}`,
        name: `Ingredient${start + i}`,
      }));
    const pages = Math.ceil(MEDICINE_NAME_MAX_ROWS / MEDICINE_NAME_QUERY_LIMIT);
    const ingredient = vi.fn(async (args: { where: { id?: { gt: string } } }) => {
      const after = args.where.id?.gt;
      const start = after ? Number(after.slice(1)) + 1 : 0;
      return pageOf(start, MEDICINE_NAME_QUERY_LIMIT);
    });
    const medicine = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: MEDICINE_NAME_QUERY_LIMIT }, (_, i) => ({
          id: `a${String(i).padStart(7, '0')}`,
          productName: `Product${i}`,
          brandName: null,
        }))
      )
      .mockResolvedValueOnce([{ id: 'b0000001', productName: 'Lastmed Syrup', brandName: null }]);
    const alias = vi.fn(async () => [{ id: 'x1', value: 'Paracetamol' }]);
    const db = {
      medicine: { findMany: medicine },
      medicineAlias: { findMany: alias },
      ingredient: { findMany: ingredient },
    } as unknown as ScopedDb;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const names = await readTenantMedicineNames(db);
      expect(names.has('lastmed')).toBe(true);
      expect(names.has('product0')).toBe(true);
      expect(names.has(`ingredient${MEDICINE_NAME_MAX_ROWS - 1}`)).toBe(true);
      expect(names.has(`ingredient${MEDICINE_NAME_MAX_ROWS}`)).toBe(false);
      expect(medicine).toHaveBeenCalledTimes(2);
      expect(medicine.mock.calls[1]![0]).toMatchObject({
        where: { id: { gt: 'a0004999' } },
        orderBy: { id: 'asc' },
      });
      expect(alias).toHaveBeenCalledTimes(1);
      expect(ingredient).toHaveBeenCalledTimes(pages);
      expect(warn).toHaveBeenCalledExactlyOnceWith('PHARMACY_MEDICINE_NAMES_TRUNCATED', {
        source: 'ingredient',
        rows: MEDICINE_NAME_MAX_ROWS,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Ingredient');
    } finally {
      warn.mockRestore();
    }
  });

  it('reads product, brand, alias and ingredient names with bounded queries', async () => {
    const medicine = vi.fn(async () => [
      { id: 'm1', productName: 'Panadol Extra 500mg', brandName: 'Panadol' },
      { id: 'm2', productName: 'Calpol Syrup', brandName: null },
    ]);
    const alias = vi.fn(async () => [
      { id: 'a1', value: 'Paracetamol' },
      { id: 'a2', value: 'پیناڈول' },
    ]);
    const ingredient = vi.fn(async () => [{ id: 'i1', name: 'Ibuprofen' }]);
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
        'calpol',
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
