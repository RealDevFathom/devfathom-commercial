/** Run only against a newly owned, migrated disposable DB via TEST_DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { financialStatements } from '@/lib/pharmacy/financial-statements';
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
    accountCode: 'CASH' | 'BANK' | 'SALES_CLEARING' | 'SALES_REVENUE';
    side: 'DEBIT' | 'CREDIT';
    amountMinor: number;
    branchId: string | null;
  }>,
  reversesEntryId?: string,
  currency: 'PKR' | 'USD' = 'PKR'
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
        currency,
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
  // Null entry-branch lines belong to no branch and must never reach a branch projection.
  await post(org, `${org}_null_branch`, new Date('2026-10-06T00:00:00Z'), [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 70, branchId: null },
    { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 70, branchId: null },
  ]);
  await post(org, `${org}_noncash`, new Date('2026-10-07T00:00:00Z'), [
    { accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 500, branchId: branch },
    { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 500, branchId: branch },
  ]);
  await post(org, `${org}_transfer`, new Date('2026-10-08T00:00:00Z'), [
    { accountCode: 'BANK', side: 'DEBIT', amountMinor: 10, branchId: branch },
    { accountCode: 'CASH', side: 'CREDIT', amountMinor: 10, branchId: branch },
  ]);
  // More cash entries than the 25-row financial-statements journal page.
  for (let index = 0; index < 30; index += 1) {
    await post(org, `${org}_small_${index}`, new Date(Date.UTC(2026, 9, 10, 0, 0, index)), [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 1, branchId: branch },
      { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 1, branchId: branch },
    ]);
  }
  // A second recorded currency whose closing exceeds a 32-bit integer.
  const large = 2_000_000_000;
  for (const [id, occurredAt] of [
    [`${org}_usd_opening`, new Date('2026-09-15T00:00:00Z')],
    [`${org}_usd_sale`, new Date('2026-10-11T00:00:00Z')],
  ] as const) {
    await post(
      org,
      id,
      occurredAt,
      [
        { accountCode: 'CASH', side: 'DEBIT', amountMinor: large, branchId: branch },
        { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: large, branchId: branch },
      ],
      undefined,
      'USD'
    );
  }
  await post(foreignOrg, `${org}_foreign_entry`, new Date('2026-10-05T00:00:00Z'), [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 777, branchId: branch },
    { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 777, branchId: branch },
  ]);
}, 60_000);

const scope = { organizationId: org, branchId: branch };
const controls = (db: ScopedDb) =>
  financialStatements(db, scope, { ...period, page: 1 }).then((result) => result.accounts);

suite('cash-flow projection on migrated PostgreSQL with RLS', () => {
  it('reconciles every scoped cash posting per currency against canonical controls', async () => {
    const result = await withTenantDb(org, async (db) =>
      loadCashFlowProjection(db, scope, period, await controls(db))
    );
    expect(result.totals).toEqual([
      expect.objectContaining({
        currency: 'PKR',
        opening: BigInt(100),
        operating: BigInt(60),
        unclassified: BigInt(40),
        closing: BigInt(200),
        canonicalClosing: BigInt(200),
        discrepancy: BigInt(0),
      }),
      expect.objectContaining({
        currency: 'USD',
        opening: BigInt(2_000_000_000),
        operating: BigInt(2_000_000_000),
        closing: BigInt(4_000_000_000),
        canonicalClosing: BigInt(4_000_000_000),
        discrepancy: BigInt(0),
      }),
    ]);
    const ids = result.evidence.map((entry) => entry.id);
    expect(ids.length).toBe(34);
    expect(ids.length).toBeGreaterThan(25);
    for (const excluded of ['upper_bound', 'opening', 'null_branch', 'noncash', 'transfer']) {
      expect(ids).not.toContain(`${org}_${excluded}`);
    }
    expect(result.evidence.every((entry) => entry.netMinor !== BigInt(0))).toBe(true);
    expect(result.evidence.find((entry) => entry.id === `${org}_reversal`)).toMatchObject({
      reversesEntryId: `${org}_original`,
      netMinor: BigInt(-20),
      occurredAt: new Date('2026-10-03T00:00:00Z'),
    });
  });

  it('surfaces a mismatch between the projection and canonical controls', async () => {
    const result = await withTenantDb(org, async (db) => {
      const accounts = (await controls(db)).map((account) =>
        account.accountCode === 'BANK' && account.currency === 'PKR'
          ? { ...account, closingMinor: (BigInt(account.closingMinor) + BigInt(7)).toString() }
          : account
      );
      return loadCashFlowProjection(db, scope, period, accounts);
    });
    expect(result.totals.find((row) => row.currency === 'PKR')).toMatchObject({
      closing: BigInt(200),
      discrepancy: BigInt(7),
    });
    expect(result.totals.find((row) => row.currency === 'USD')?.discrepancy).toBe(BigInt(0));
  });

  it('returns no rows when a tenant asks explicitly for another organization', async () => {
    const result = await withTenantDb(org, (db) =>
      loadCashFlowProjection(db, { organizationId: foreignOrg, branchId: branch }, period, [])
    );
    expect(result.evidence).toEqual([]);
    expect(result.totals).toEqual([]);
  });
});
