/** Run only against a newly owned, migrated disposable DB via WHA1372_TEST_DATABASE_URL or TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grossMargin, grossMarginComparison, landedProfit } from './finance-reports';

const url = process.env.WHA1372_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
const org = `wha1372_${randomUUID()}`;
const otherOrg = `${org}_other`;
const branchId = `${org}_branch`;
const period = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-03T00:00:00Z') };

async function post(
  organizationId: string,
  branch: string,
  at: string,
  revenue: number,
  discount: number,
  cogs: number,
  returned = false,
  dimensions: { productId?: string; actorId?: string; sourceLineId?: string } = {}
) {
  await withTenantDb(organizationId, async (db: ScopedDb) => {
    const id = randomUUID();
    const legs = [
      { accountCode: 'SALES_REVENUE' as const, side: 'CREDIT' as const, amountMinor: revenue },
      { accountCode: 'SALES_DISCOUNT' as const, side: 'DEBIT' as const, amountMinor: discount },
      { accountCode: 'COST_OF_GOODS_SOLD' as const, side: 'DEBIT' as const, amountMinor: cogs },
      { accountCode: 'CASH' as const, side: 'DEBIT' as const, amountMinor: revenue - discount },
      { accountCode: 'INVENTORY' as const, side: 'CREDIT' as const, amountMinor: cogs },
    ];
    await db.financeJournalEntry.create({
      data: {
        id,
        organizationId,
        branchId: branch,
        sourceKind: returned ? 'PHARMACY_SALE_RETURN_LINE' : 'PHARMACY_SALE_LINE',
        sourceId: id,
        description: 'Disposable comparison test',
        actorId: dimensions.actorId ?? org,
        occurredAt: new Date(at),
        idempotencyKey: id,
        lines: {
          create: legs
            .filter((line) => line.amountMinor > 0)
            .map((line) => ({
              ...line,
              branchId: branch,
              productId: dimensions.productId,
              sourceLineId: dimensions.sourceLineId,
              side: returned ? (line.side === 'DEBIT' ? 'CREDIT' : 'DEBIT') : line.side,
            })),
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
  // Integrated tip (20261012120000_visibility_context_anchors): journal entries must reference an
  // existing organization, so anchor this suite's synthetic tenants before posting.
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [org, otherOrg]
    )
  );
  withTenantDb = scoped.withTenantDb;
  await withTenantDb(org, (db) =>
    db.medicine.createMany({
      data: [
        {
          id: `${org}_medicine_a`,
          organizationId: org,
          productName: 'Integration medicine A',
          productFamily: 'PHARMACEUTICAL',
        },
        {
          id: `${org}_medicine_b`,
          organizationId: org,
          productName: 'Integration medicine B',
          productFamily: 'DEVICE',
        },
      ],
    })
  );
  await post(org, branchId, '2026-08-30T00:00:00Z', 10000, 500, 6000);
  await post(org, branchId, '2026-09-01T00:00:00Z', 12000, 1500, 8000);
  await post(org, branchId, '2026-09-02T23:59:59.999Z', 1000, 100, 600, true);
  await post(org, branchId, '2026-09-03T00:00:00Z', 99999, 0, 0);
  await post(org, branchId, '2026-08-29T23:59:59.999Z', 99999, 0, 0);
  await post(org, `${branchId}_other`, '2026-09-01T00:00:00Z', 99999, 0, 0);
  await post(otherOrg, branchId, '2026-09-01T00:00:00Z', 99999, 0, 0);
  await post(org, branchId, '2026-09-01T10:15:00Z', 5000, 500, 2000, false, {
    productId: `${org}_medicine_a`,
    actorId: 'staff_a',
    sourceLineId: 'sale_line_a',
  });
  await post(org, branchId, '2026-09-01T10:45:00Z', 1000, 100, 400, true, {
    productId: `${org}_medicine_a`,
    actorId: 'staff_a',
    sourceLineId: 'return_line_a',
  });
  await post(org, branchId, '2026-09-01T11:05:00Z', 3000, 0, 1000, false, {
    productId: `${org}_medicine_b`,
    actorId: 'staff_b',
    sourceLineId: 'sale_line_b',
  });
}, 30000);

suite('comparison on migrated PostgreSQL with restricted runtime role', () => {
  it('reconciles returns and both half-open windows against existing read model', async () => {
    await withTenantDb(org, async (db) => {
      const report = await grossMarginComparison(db, { organizationId: org, branchId }, period);
      expect(report.previous.grossMarginMinor).toBe(3500);
      expect(report.current.grossMarginMinor).toBe(6200);
      expect(report.differenceMinor).toBe(2700);
      expect(report.reconciledMinor).toBe(2700);
      const existing = await grossMargin(
        db,
        { organizationId: org, branchId },
        { ...period, by: 'branch' }
      );
      expect(report.current).toMatchObject(existing[0]!);
    });
  });
  it('groups persisted landed postings, reversals, categories, nulls, hours, and staff', async () => {
    await withTenantDb(org, async (db) => {
      const scope = { organizationId: org, branchId };
      const item = await landedProfit(db, scope, { ...period, by: 'item' });
      expect(item).toEqual([
        {
          key: `${org}_medicine_a`,
          revenueMinor: 4000,
          discountMinor: 400,
          landedCostMinor: 1600,
          profitMinor: 2000,
        },
        {
          key: `${org}_medicine_b`,
          revenueMinor: 3000,
          discountMinor: 0,
          landedCostMinor: 1000,
          profitMinor: 2000,
        },
        {
          key: null,
          revenueMinor: 11000,
          discountMinor: 1400,
          landedCostMinor: 7400,
          profitMinor: 2200,
        },
      ]);
      expect(await landedProfit(db, scope, { ...period, by: 'category' })).toEqual([
        {
          key: 'DEVICE',
          revenueMinor: 3000,
          discountMinor: 0,
          landedCostMinor: 1000,
          profitMinor: 2000,
        },
        {
          key: 'PHARMACEUTICAL',
          revenueMinor: 4000,
          discountMinor: 400,
          landedCostMinor: 1600,
          profitMinor: 2000,
        },
        {
          key: null,
          revenueMinor: 11000,
          discountMinor: 1400,
          landedCostMinor: 7400,
          profitMinor: 2200,
        },
      ]);
      const hour = await landedProfit(db, scope, { ...period, by: 'hour' });
      expect(hour.find((row) => row.key === '2026-09-01T10:00:00Z')).toMatchObject({
        revenueMinor: 4000,
        profitMinor: 2000,
      });
      const staff = await landedProfit(db, scope, { ...period, by: 'staff' });
      expect(staff.find((row) => row.key === 'staff_a')).toMatchObject({
        revenueMinor: 4000,
        profitMinor: 2000,
      });
      expect(item.reduce((sum, row) => sum + row.profitMinor, 0)).toBe(6200);
    });
  });
  it('RLS denies a foreign tenant even when explicitly requested in SQL', async () => {
    const report = await withTenantDb(org, (db) =>
      grossMarginComparison(db, { organizationId: otherOrg, branchId }, period)
    );
    expect(report.previous.hasEntries).toBe(false);
    expect(report.current.hasEntries).toBe(false);
  });
  it('returns absent groups honestly', async () => {
    const report = await withTenantDb(org, (db) =>
      grossMarginComparison(db, { organizationId: org, branchId: 'absent' }, period)
    );
    expect(report.differenceMinor).toBe(0);
    expect(report.previous.hasEntries).toBe(false);
    expect(report.current.hasEntries).toBe(false);
  });
});
