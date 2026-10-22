import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PHARMACY_CATALOG_VERSION, seedPharmacyCatalog, type PharmacyCatalog } from './preload';

type Row = Record<string, unknown>;

/** Every source row says `active: true`, exactly like the bundled asset. */
const catalog: PharmacyCatalog = {
  version: PHARMACY_CATALOG_VERSION,
  count: 2,
  items: [
    {
      name: 'Synthetic A',
      alias: 'A-1',
      active: true,
      packUnits: 'tablet',
      packQty: 10,
      class: 'GENERAL',
      category: 'test',
      defaultSalePriceMinor: 1200,
      defaultPurchasePriceMinor: 900,
    },
    {
      name: 'Synthetic B',
      alias: 'B-1',
      active: true,
      packUnits: 'capsule',
      packQty: 20,
      class: 'NARCOTICS',
      category: 'test',
      defaultSalePriceMinor: null,
      defaultPurchasePriceMinor: 400,
    },
  ],
};

function seedDb(useCatalogDefaultPrices: boolean) {
  const writes = new Map<string, Row[]>();
  const order: string[] = [];
  const delegate = (name: string) => ({
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    count: vi.fn(async () => (name === 'medicine' ? catalog.count : 0)),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      order.push(`createMany:${name}`);
      writes.set(name, [...(writes.get(name) ?? []), ...data]);
      return { count: data.length };
    }),
  });
  const db = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === '$executeRaw') return vi.fn(async () => 1);
        if (name === '$queryRaw') {
          return vi.fn(async (query: { strings: readonly string[] }) => {
            if (query.strings.join('?').includes('FOR UPDATE')) order.push('lock:setting');
            return [{ useCatalogDefaultPrices }];
          });
        }
        return delegate(name);
      },
    }
  ) as ScopedDb;
  return { db, writes, order };
}

describe('catalogue seed review quarantine (finding 3)', () => {
  it('creates every medicine unsaleable with its catalogue origin, even when the source says active', async () => {
    const { db, writes } = seedDb(false);
    await seedPharmacyCatalog(db, 'org-a', catalog);
    expect(writes.get('medicine')).toEqual(
      catalog.items.map(() =>
        expect.objectContaining({
          organizationId: 'org-a',
          saleable: false,
          catalogVersion: PHARMACY_CATALOG_VERSION,
        })
      )
    );
    expect(writes.get('medicineProvenance')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'catalog', status: 'UNREVIEWED' }),
        expect.objectContaining({ field: 'classHint', status: 'UNREVIEWED' }),
      ])
    );
    expect(writes.get('medicineProvenance')!.every((row) => row.status === 'UNREVIEWED')).toBe(
      true
    );
  });

  it('leaves tenant prices empty while catalogue default prices are off', async () => {
    const { db, writes } = seedDb(false);
    await seedPharmacyCatalog(db, 'org-a', catalog);
    expect(writes.get('packLevel')).toEqual([
      expect.objectContaining({
        catalogDefaultSalePriceMinor: 1200,
        sellingPriceMinor: null,
        purchasePriceMinor: null,
      }),
      expect.objectContaining({
        catalogDefaultPurchasePriceMinor: 400,
        sellingPriceMinor: null,
        purchasePriceMinor: null,
      }),
    ]);
  });

  it('seeds the defaults when the tenant already turned them on (finding 2: no stale state)', async () => {
    const { db, writes, order } = seedDb(true);
    await seedPharmacyCatalog(db, 'org-a', catalog);
    expect(writes.get('packLevel')).toEqual([
      expect.objectContaining({ sellingPriceMinor: 1200, purchasePriceMinor: 900 }),
      expect.objectContaining({ sellingPriceMinor: null, purchasePriceMinor: 400 }),
    ]);
    // The setting row is held before any pack is written, serializing with the toggle.
    expect(order.indexOf('lock:setting')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lock:setting')).toBeLessThan(order.indexOf('createMany:packLevel'));
  });
});
