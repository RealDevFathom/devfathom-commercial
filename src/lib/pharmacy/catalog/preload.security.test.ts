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

/** Records every delegate touched and every raw statement the seed issues. */
function seedDb() {
  const writes = new Map<string, Row[]>();
  const touched = new Set<string>();
  const raw: string[] = [];
  const delegate = (name: string) => ({
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    count: vi.fn(async () => (name === 'medicine' ? catalog.count : 0)),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      writes.set(name, [...(writes.get(name) ?? []), ...data]);
      return { count: data.length };
    }),
  });
  const db = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name.startsWith('$')) {
          return vi.fn(async (query: { strings?: readonly string[] }) => {
            raw.push(query?.strings?.join('?') ?? name);
            return [];
          });
        }
        touched.add(name);
        return delegate(name);
      },
    }
  ) as ScopedDb;
  return { db, writes, touched, raw };
}

describe('catalogue seed: reference rows only (finding 3, CAT-SEC-02/03)', () => {
  it('creates every medicine unsaleable with its catalogue origin, even when the source says active', async () => {
    const { db, writes } = seedDb();
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

  it('stores the catalogue defaults as reference values on the packs, and no applied price', async () => {
    const { db, writes } = seedDb();
    await seedPharmacyCatalog(db, 'org-a', catalog);
    const packs = writes.get('packLevel')!;
    expect(packs).toEqual([
      expect.objectContaining({
        catalogDefaultSalePriceMinor: 1200,
        catalogDefaultPurchasePriceMinor: 900,
      }),
      expect.objectContaining({
        catalogDefaultSalePriceMinor: null,
        catalogDefaultPurchasePriceMinor: 400,
      }),
    ]);
    for (const pack of packs) {
      expect(pack).not.toHaveProperty('sellingPriceMinor');
      expect(pack).not.toHaveProperty('purchasePriceMinor');
      expect(pack).not.toHaveProperty('catalogSellingPriceCount');
    }
  });

  it('never writes a branch price, a branch setting or a raw statement', async () => {
    const { db, touched, raw } = seedDb();
    await seedPharmacyCatalog(db, 'org-a', catalog);
    expect([...touched].sort()).toEqual([
      'catalogSeedRun',
      'medicine',
      'medicineAlias',
      'medicineProvenance',
      'packLevel',
      'presentation',
    ]);
    expect(raw).toEqual([]);
  });
});
