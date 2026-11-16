import { describe, expect, it } from 'vitest';
import type { CounterSearchRow } from './counter';
import { CounterCatalogueCache } from './counter-catalogue-cache';

const code = '8964000123456';
function row(overrides: Partial<CounterSearchRow> = {}): CounterSearchRow {
  return {
    medicineId: 'synthetic-medicine',
    displayName: 'Fixture',
    brandName: null,
    manufacturer: null,
    strength: null,
    presentationId: 'synthetic-presentation',
    presentation: 'Tablet',
    dosageForm: 'Tablet',
    route: 'Oral',
    matchedOn: 'BARCODE',
    recommendedLotId: 'synthetic-lot',
    packLevelId: 'synthetic-pack',
    unitsPerPack: 1,
    printedMrpMinor: 100,
    roundingIncrementMinor: 1,
    batchNumber: 'fixture',
    nearestSafeExpiry: '2030-01-01T00:00:00.000Z',
    onHandUnits: 2,
    saleableUnits: [],
    saleUnits: [],
    restriction: {
      otc: true,
      rx: false,
      controlled: false,
      restricted: false,
      highAlert: false,
      lasa: false,
    },
    storage: { coldChain: false, locationKind: 'STORE', locationCode: null, locationName: null },
    blocked: [],
    ...overrides,
  };
}

describe('counter catalogue hints', () => {
  it('expires at ten seconds and sales never extend the original expiry', () => {
    let now = 0;
    const cache = new CounterCatalogueCache(() => now);
    cache.put(code, row());
    now = 9_999;
    cache.sold('synthetic-medicine', 1);
    expect(cache.get(code)?.onHandUnits).toBe(1);
    now = 10_000;
    expect(cache.get(code)).toBeUndefined();
  });

  it('debits all barcode aliases without mutating the server response and refetches exhausted hints', () => {
    const cache = new CounterCatalogueCache();
    const source = row();
    cache.put(code, source);
    cache.put('123456789', source);
    cache.sold(source.medicineId, 1);
    expect(source.onHandUnits).toBe(2);
    expect(cache.get('123456789')?.onHandUnits).toBe(1);
    cache.sold(source.medicineId, 1);
    expect(cache.get(code)).toBeUndefined();
    expect(cache.get('123456789')).toBeUndefined();
  });

  it.each(['rx', 'controlled', 'restricted', 'highAlert', 'lasa'] as const)(
    'never reuses a %s catalogue hint',
    (flag) => {
      const cache = new CounterCatalogueCache();
      const value = row();
      value.restriction[flag] = true;
      cache.put(code, value);
      expect(cache.get(code)).toBeUndefined();
    }
  );

  it('never caches fuzzy, serialized, unavailable or blocked results', () => {
    const cache = new CounterCatalogueCache();
    for (const value of [
      row({ matchedOn: 'NAME' }),
      row({ onHandUnits: 0 }),
      row({ blocked: ['EXPIRED'] }),
    ]) {
      cache.put(code, value);
      expect(cache.get(code)).toBeUndefined();
    }
    cache.put('(01)01234567890128(21)fixture', row());
    expect(cache.get('(01)01234567890128(21)fixture')).toBeUndefined();
  });

  it('bounds memory at 100 entries and clears an operator scope', () => {
    const cache = new CounterCatalogueCache();
    for (let i = 0; i <= 100; i++) cache.put(String(100000 + i), row());
    expect(cache.get('100000')).toBeUndefined();
    expect(cache.get('100001')).toBeDefined();
    cache.clear();
    expect(cache.get('100001')).toBeUndefined();
  });

  it('never shares catalogue entries between instances', () => {
    const a = new CounterCatalogueCache();
    const b = new CounterCatalogueCache();
    a.put(code, row());
    expect(b.get(code)).toBeUndefined();
  });
});
