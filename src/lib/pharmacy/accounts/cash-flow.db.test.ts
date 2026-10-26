/** Run only against a newly owned, migrated disposable DB via TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { loadCashFlowProjection } from './cash-flow';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const organizationId = `cashflow_${randomUUID()}`;
const foreignOrganizationId = `${organizationId}_foreign`;
const branchId = `${organizationId}_branch`;
const otherBranchId = `${organizationId}_other`;
const period = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
};
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

async function post(
  organization: string,
  entryBranch: string | null,
  amount: number,
  cashBranch: string | null,
  counterpartBranch: string | null
) {
  await withTenantDb(organization, async (db: ScopedDb) => {
    const id = randomUUID();
    await db.financeJournalEntry.create({
      data: {
        id,
        organizationId: organization,
        branchId: entryBranch,
        sourceKind: 'PHARMACY_TENDER',
        sourceId: id,
        description: 'Cash-flow scope acceptance fixture',
        actorId: organizationId,
        occurredAt: new Date('2026-10-15T12:00:00Z'),
        idempotencyKey: id,
        lines: {
          create: [
            { accountCode: 'CASH', side: 'DEBIT', amountMinor: amount, branchId: cashBranch },
            {
              accountCode: 'SALES_CLEARING',
              side: 'CREDIT',
              amountMinor: amount,
              branchId: counterpartBranch,
            },
          ],
        },
      },
    });
  });
}

beforeAll(async () => {
  if (!url) return;
  const tenancy = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(tenancy.withPlatformDb);
  await tenancy.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, foreignOrganizationId]
    )
  );
  withTenantDb = tenancy.withTenantDb;

  await post(organizationId, branchId, 100, branchId, branchId);
  await post(organizationId, null, 20, branchId, branchId);
  await post(organizationId, branchId, 30, branchId, null);
  await post(organizationId, branchId, 40, branchId, otherBranchId);
  await post(organizationId, otherBranchId, 50, otherBranchId, otherBranchId);
  await post(foreignOrganizationId, branchId, 999, branchId, branchId);
}, 30_000);

suite('cash-flow scope on migrated PostgreSQL with RLS', () => {
  it('includes null-entry-branch rows but excludes null and sibling line branches', async () => {
    const result = await withTenantDb(organizationId, (db) =>
      loadCashFlowProjection(db, { organizationId, branchId }, period)
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      currency: 'PKR',
      operatingMinor: '120',
      unclassifiedMinor: '70',
      movementMinor: '190',
    });
    expect(result[0]!.evidence).toHaveLength(4);
  });

  it('does not leak another tenant when its organization is explicitly requested', async () => {
    const result = await withTenantDb(organizationId, (db) =>
      loadCashFlowProjection(db, { organizationId: foreignOrganizationId, branchId }, period)
    );
    expect(result).toEqual([]);
  });
});
