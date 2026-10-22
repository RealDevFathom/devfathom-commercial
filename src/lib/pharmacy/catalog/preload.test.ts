import { describe, expect, it } from 'vitest';
import { parsePharmacyCatalog, PHARMACY_CATALOG_VERSION } from './preload';

const item = { name: 'Synthetic A', alias: 'LEG-1', active: true, packUnits: 'tablet', packQty: 10, class: 'NARCOTICS', category: 'synthetic', defaultSalePriceMinor: 1200, defaultPurchasePriceMinor: 900 };
const fixture = { version: PHARMACY_CATALOG_VERSION, count: 1, items: [item] };

describe('pharmacy catalogue input contract (synthetic fixture only)', () => {
  it('accepts the documented, quantity-free shape', () => expect(parsePharmacyCatalog(fixture).count).toBe(1));
  it.each(['QTY', 'StockValue', 'supplier', 'distributor'])('rejects forbidden/unknown %s data', (field) => {
    expect(() => parsePharmacyCatalog({ ...fixture, items: [{ ...item, [field]: 1 }] })).toThrow();
  });
  it('rejects a count mismatch', () => expect(() => parsePharmacyCatalog({ ...fixture, count: 2 })).toThrow());
});
