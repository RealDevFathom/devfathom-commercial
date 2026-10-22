import { describe, expect, it, vi } from 'vitest';
import type { Subject } from '@/lib/abac';
import { PHARMACY_CATALOG_VERSION, seedPharmacyCatalog, setCatalogDefaultPrices } from './preload';

const subject: Subject = { id: 'owner-a', role: 'ADMIN', status: 'ACTIVE' };
function priceDb(
  effect?: 'ALLOW' | 'ROLE_DENY' | 'USER_DENY',
  concurrentSale = false
) {
  const updates: unknown[] = [];
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        permissionOverrides:
          effect === 'USER_DENY'
            ? [{ capability: 'pharmacy:catalog-settings', effect: 'DENY' }]
            : [],
        organizationRole: effect
          ? {
              permissions: [
                {
                  capability: 'pharmacy:catalog-settings',
                  effect: effect === 'ROLE_DENY' ? 'DENY' : 'ALLOW',
                },
              ],
            }
          : null,
      })),
    },
    pharmacyCatalogSetting: { upsert: vi.fn() },
    packLevel: {
      findMany: vi.fn(async () => [{ id: 'pack-a', sellingPriceMinor: null, purchasePriceMinor: null, catalogDefaultSalePriceMinor: 1200, catalogDefaultPurchasePriceMinor: 900 }]),
      updateMany: vi.fn(async (args) => { updates.push(args); return { count: concurrentSale && 'sellingPriceMinor' in (args as any).where ? 0 : 1 }; }),
    },
    auditLog: { create: vi.fn() },
  };
  return { db: db as never, updates };
}

describe('catalogue price authorization and compare-and-set', () => {
  it.each([undefined, 'ROLE_DENY', 'USER_DENY'] as const)('rejects %s capability without making settings writes', async (effect) => {
    const { db } = priceDb(effect);
    await expect(setCatalogDefaultPrices(db, 'org-a', subject, true)).rejects.toThrow('Forbidden');
    expect((db as any).pharmacyCatalogSetting.upsert).not.toHaveBeenCalled();
  });

  it('allows an owner grant only through its tenant-scoped database', async () => {
    const { db, updates } = priceDb('ALLOW');
    await expect(setCatalogDefaultPrices(db, 'org-a', subject, true)).resolves.toEqual({ enabled: true, saleApplied: 1, purchaseApplied: 1 });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ where: { organizationId: 'org-a', id: 'pack-a', sellingPriceMinor: null } }),
      expect.objectContaining({ where: { organizationId: 'org-a', id: 'pack-a', purchasePriceMinor: null } }),
    ]));
  });

  it('does not overwrite or count a concurrent owner sale price', async () => {
    const { db } = priceDb('ALLOW', true);
    await expect(setCatalogDefaultPrices(db, 'org-a', subject, true)).resolves.toMatchObject({ saleApplied: 0, purchaseApplied: 1 });
  });
});

describe('catalogue seed review quarantine', () => {
  it('creates every imported medicine unsaleable with unreviewed provenance', async () => {
    const writes = new Map<string, any[]>();
    const delegate = (name: string) => ({
      findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})),
      count: vi.fn(async () => name === 'medicine' ? 1 : 0),
      createMany: vi.fn(async ({ data }: any) => { writes.set(name, data); return { count: data.length }; }),
    });
    const db = new Proxy({}, { get: (_target, name: string) => delegate(name) }) as never;
    await seedPharmacyCatalog(db, 'org-a', { version: PHARMACY_CATALOG_VERSION, count: 1, items: [{ name: 'A', alias: 'A-1', active: true, packUnits: 'tablet', packQty: 10, class: 'GENERAL', category: 'test', defaultSalePriceMinor: null, defaultPurchasePriceMinor: null }] });
    expect(writes.get('medicine')).toEqual([expect.objectContaining({ organizationId: 'org-a', saleable: false })]);
    expect(writes.get('medicineProvenance')).toEqual([expect.objectContaining({ organizationId: 'org-a', status: 'UNREVIEWED' })]);
  });
});
