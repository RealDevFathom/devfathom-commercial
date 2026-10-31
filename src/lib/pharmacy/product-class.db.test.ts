/**
 * #718 — non-drug retail items against migrated PostgreSQL with FORCED row-level security.
 *
 * Proves the database backstops of the server guards: a marketing template can feature only
 * same-tenant NON_DRUG_RETAIL (FRONT_SHOP) items, a medicine never takes a shop-set retail price,
 * and gross margin splits medicine from non-drug on the posted journal. Skipped (never silently
 * passed) when the database URL is absent.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grossMargin } from './finance-reports';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;

const org = `i718_${randomUUID()}`;
const otherOrg = `${org}_other`;
const branchId = `${org}_branch`;
const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-03T00:00:00Z') };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let shampooId: string;
let panadolId: string;
let foreignShampooId: string;

const inOrg = <T>(organizationId: string, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(organizationId, work);

async function createTemplate(organizationId: string, featuredMedicineIds: string[]) {
  return inOrg(organizationId, (db) =>
    db.pharmacyMarketingTemplate.create({
      data: {
        organizationId,
        branchId,
        name: `template-${randomUUID()}`,
        channel: 'WHATSAPP',
        body: 'New skincare range in store. Reply STOP to opt out.',
        approvedByUserId: 'owner',
        approvedAt: new Date(),
        featuredMedicineIds,
      },
    })
  );
}

async function postSale(productId: string, revenue: number, cogs: number) {
  await inOrg(org, async (db) => {
    const id = randomUUID();
    await db.financeJournalEntry.create({
      data: {
        id,
        organizationId: org,
        branchId,
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId: id,
        description: '#718 product class margin test',
        actorId: org,
        occurredAt: new Date('2026-10-01T10:00:00Z'),
        idempotencyKey: id,
        lines: {
          create: [
            { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: revenue, productId },
            { accountCode: 'COST_OF_GOODS_SOLD', side: 'DEBIT', amountMinor: cogs, productId },
            { accountCode: 'CASH', side: 'DEBIT', amountMinor: revenue },
            { accountCode: 'INVENTORY', side: 'CREDIT', amountMinor: cogs },
          ].map((line) => ({ ...line, branchId })) as {
            accountCode: 'SALES_REVENUE' | 'COST_OF_GOODS_SOLD' | 'CASH' | 'INVENTORY';
            side: 'CREDIT' | 'DEBIT';
            amountMinor: number;
            productId?: string;
            branchId: string;
          }[],
        },
      },
    });
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [org, otherOrg]
    )
  );
  withTenantDb = scoped.withTenantDb;
  shampooId = (
    await inOrg(org, (db) =>
      db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Herbal shampoo 200ml',
          productFamily: 'FRONT_SHOP',
          retailPriceMinor: 65000,
          retailCategory: 'Cosmetics',
        },
      })
    )
  ).id;
  panadolId = (
    await inOrg(org, (db) =>
      db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Paracetamol 500mg',
          productFamily: 'PHARMACEUTICAL',
        },
      })
    )
  ).id;
  foreignShampooId = (
    await inOrg(otherOrg, (db) =>
      db.medicine.create({
        data: {
          organizationId: otherOrg,
          productName: 'Foreign soap',
          productFamily: 'FRONT_SHOP',
        },
      })
    )
  ).id;
  await postSale(shampooId, 65000, 40000);
  await postSale(panadolId, 10000, 8500);
}, 30000);

suite('#718 non-drug retail on migrated PostgreSQL with restricted runtime role', () => {
  it('stores a template featuring only same-tenant non-drug items', async () => {
    const template = await createTemplate(org, [shampooId]);
    expect(template.featuredMedicineIds).toEqual([shampooId]);
    expect((await createTemplate(org, [])).featuredMedicineIds).toEqual([]);
  });

  it('refuses a template that includes a medicine SKU', async () => {
    await expect(createTemplate(org, [shampooId, panadolId])).rejects.toThrow(
      /may feature only non-drug retail items/
    );
  });

  it('refuses another tenant item as missing', async () => {
    await expect(createTemplate(org, [foreignShampooId])).rejects.toThrow(
      /may feature only non-drug retail items/
    );
  });

  it('refuses an Rx-flagged front-shop item', async () => {
    const flagged = await inOrg(org, (db) =>
      db.medicine.create({
        data: {
          organizationId: org,
          productName: 'Medicated cream',
          productFamily: 'FRONT_SHOP',
          rx: true,
        },
      })
    );
    await expect(createTemplate(org, [flagged.id])).rejects.toThrow(
      /may feature only non-drug retail items/
    );
  });

  it('refuses a shop-set retail price or category on a medicine', async () => {
    await expect(
      inOrg(org, (db) =>
        db.medicine.update({ where: { id: panadolId }, data: { retailPriceMinor: 100 } })
      )
    ).rejects.toThrow(/retail_fields_non_drug_only|check constraint/i);
    await expect(
      inOrg(org, (db) =>
        db.medicine.update({ where: { id: shampooId }, data: { retailPriceMinor: 0 } })
      )
    ).rejects.toThrow(/retail_price_positive|check constraint/i);
  });

  it('splits medicine and non-drug margin on the posted journal', async () => {
    const rows = await inOrg(org, (db) =>
      grossMargin(db, { organizationId: org, branchId }, { ...period, by: 'productClass' })
    );
    expect(rows).toEqual([
      {
        key: 'MEDICINE',
        revenueMinor: 10000,
        discountMinor: 0,
        cogsMinor: 8500,
        grossMarginMinor: 1500,
      },
      {
        key: 'NON_DRUG_RETAIL',
        revenueMinor: 65000,
        discountMinor: 0,
        cogsMinor: 40000,
        grossMarginMinor: 25000,
      },
    ]);
  });
});
