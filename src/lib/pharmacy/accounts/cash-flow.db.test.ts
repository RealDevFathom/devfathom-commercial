/** Run only against a newly owned, migrated disposable DB via TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { loadCashFlowProjection } from './cash-flow';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomUUID();
const org = `cash_flow_${suffix}`;
const foreignOrg = `${org}_foreign`;
const branch = `${org}_branch`;
const otherBranch = `${org}_other_branch`;
const period = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
};
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

async function post(
  organizationId: string,
  id: string,
  occurredAt: Date,
  lines: Array<{
    accountCode: 'CASH' | 'BANK' | 'SALES_CLEARING';
    side: 'DEBIT' | 'CREDIT';
    amountMinor: number;
    branchId: string;
  }>,
  reversesEntryId?: string
) {
  await withTenantDb(organizationId, (db: ScopedDb) =>
    db.financeJournalEntry.create({
      data: {
        id,
        organizationId,
        sourceKind: 'PHARMACY_TENDER',
        sourceId: id,
        description: id,
        actorId: org,
        occurredAt,
        idempotencyKey: id,
        reversesEntryId,
        reversalReason: reversesEntryId ? 'Test reversal' : undefined,
        lines: { create: lines },
      },
    })
  );
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [org, foreignOrg]
    )
  );
  await post(org, `${org}_opening`, new Date('2026-09-30T23:59:59Z'), [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 100, branchId: branch },
    { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 100, branchId: branch },
  ]);
  const original = `${org}_original`;
  await post(org, original, new Date('2026-10-02T00:00:00Z'), [
    { accountCode: 'BANK', side: 'DEBIT', amountMinor: 50, branchId: branch },
    { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 50, branchId: branch },
  ]);
  await post(
    org,
    `${org}_reversal`,
    new Date('2026-10-03T00:00:00Z'),
    [
      { accountCode: 'BANK', side: 'CREDIT', amountMinor: 20, branchId: branch },
      { accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 20, branchId: branch },
    ],
    original
  );
  await post(org, `${org}_cross_branch`, new Date('2026-10-04T00:00:00Z'), [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 40, branchId: branch },
    { accountCode: 'CASH', side: 'CREDIT', amountMinor: 40, branchId: otherBranch },
  ]);
  await post(org, `${org}_upper_bound`, period.to, [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 999, branchId: branch },
    { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 999, branchId: branch },
  ]);
  await post(foreignOrg, `${org}_foreign_entry`, new Date('2026-10-05T00:00:00Z'), [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 777, branchId: branch },
    { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 777, branchId: branch },
  ]);
}, 30_000);

suite('cash-flow projection on migrated PostgreSQL with RLS', () => {
  it('reconciles non-empty, reversal, half-open, and cross-branch evidence', async () => {
    const result = await withTenantDb(org, (db) =>
      loadCashFlowProjection(db, { organizationId: org, branchId: branch }, period)
    );
    expect(result.totals).toEqual([
      expect.objectContaining({
        currency: 'PKR',
        opening: BigInt(100),
        operating: BigInt(30),
        unclassified: BigInt(40),
        closing: BigInt(170),
        discrepancy: BigInt(0),
      }),
    ]);
    expect(result.evidence.map((entry) => entry.id)).not.toContain(`${org}_upper_bound`);
    expect(result.evidence.find((entry) => entry.id === `${org}_reversal`)).toMatchObject({
      reversesEntryId: `${org}_original`,
      netMinor: BigInt(-20),
    });
  });

  it('returns no rows when a tenant asks explicitly for another organization', async () => {
    const result = await withTenantDb(org, (db) =>
      loadCashFlowProjection(db, { organizationId: foreignOrg, branchId: branch }, period)
    );
    expect(result.evidence).toEqual([]);
    expect(result.totals).toEqual([]);
  });
});
