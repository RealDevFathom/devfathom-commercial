/** Run only against a newly owned, migrated disposable DB via WHA1372_TEST_DATABASE_URL or TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grossMargin, grossMarginComparison } from './finance-reports';

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
  returned = false
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
        actorId: org,
        occurredAt: new Date(at),
        idempotencyKey: id,
        lines: {
          create: legs
            .filter((line) => line.amountMinor > 0)
            .map((line) => ({
              ...line,
              branchId: branch,
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
  withTenantDb = scoped.withTenantDb;
  await post(org, branchId, '2026-08-30T00:00:00Z', 10000, 500, 6000);
  await post(org, branchId, '2026-09-01T00:00:00Z', 12000, 1500, 8000);
  await post(org, branchId, '2026-09-02T23:59:59.999Z', 1000, 100, 600, true);
  await post(org, branchId, '2026-09-03T00:00:00Z', 99999, 0, 0);
  await post(org, branchId, '2026-08-29T23:59:59.999Z', 99999, 0, 0);
  await post(org, `${branchId}_other`, '2026-09-01T00:00:00Z', 99999, 0, 0);
  await post(otherOrg, branchId, '2026-09-01T00:00:00Z', 99999, 0, 0);
}, 30000);

suite('comparison on migrated PostgreSQL with restricted runtime role', () => {
  it('reconciles returns and both half-open windows against existing read model', async () => {
    await withTenantDb(org, async (db) => {
      const report = await grossMarginComparison(db, { organizationId: org, branchId }, period);
      expect(report.previous.grossMarginMinor).toBe(3500);
      expect(report.current.grossMarginMinor).toBe(2200);
      expect(report.differenceMinor).toBe(-1300);
      expect(report.reconciledMinor).toBe(-1300);
      const existing = await grossMargin(
        db,
        { organizationId: org, branchId },
        { ...period, by: 'branch' }
      );
      expect(report.current).toMatchObject(existing[0]!);
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
