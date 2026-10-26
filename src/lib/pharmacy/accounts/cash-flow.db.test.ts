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
const matrixBranchId = `${organizationId}_matrix`;
const period = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
};
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let usdSaleId: string;

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

type MatrixLine = {
  accountCode:
    | 'CASH'
    | 'BANK'
    | 'SALES_CLEARING'
    | 'ACCOUNTS_PAYABLE'
    | 'INVENTORY'
    | 'OPERATING_EXPENSE'
    | 'OPENING_BALANCE_EQUITY';
  side: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
};

async function postMatrixEntry(options: {
  sourceKind:
    | 'PHARMACY_TENDER'
    | 'PHARMACY_BOOKKEEPING_TRANSACTION'
    | 'PHARMACY_OPENING_LEDGER'
    | 'PHARMACY_GOODS_RECEIPT';
  occurredAt: Date;
  lines: MatrixLine[];
  currency?: 'PKR' | 'USD';
  reversesEntryId?: string;
}) {
  return withTenantDb(organizationId, async (db: ScopedDb) => {
    const id = randomUUID();
    await db.financeJournalEntry.create({
      data: {
        id,
        organizationId,
        branchId: matrixBranchId,
        sourceKind: options.sourceKind,
        sourceId: id,
        description: 'Cash-flow database acceptance fixture',
        currency: options.currency ?? 'PKR',
        actorId: organizationId,
        occurredAt: options.occurredAt,
        idempotencyKey: id,
        reversesEntryId: options.reversesEntryId,
        reversalReason: options.reversesEntryId ? 'Acceptance fixture reversal' : undefined,
        lines: {
          create: options.lines.map((line) => ({ ...line, branchId: matrixBranchId })),
        },
      },
    });
    return id;
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

  await postMatrixEntry({
    sourceKind: 'PHARMACY_TENDER',
    occurredAt: new Date('2026-09-30T23:59:59Z'),
    lines: [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: BigInt('9007199254740993') },
      {
        accountCode: 'SALES_CLEARING',
        side: 'CREDIT',
        amountMinor: BigInt('9007199254740993'),
      },
    ],
  });
  for (let index = 0; index < 30; index += 1) {
    await postMatrixEntry({
      sourceKind: 'PHARMACY_TENDER',
      occurredAt: new Date(index === 0 ? '2026-10-01T00:00:00Z' : '2026-10-10T12:00:00Z'),
      lines: [
        { accountCode: 'CASH', side: 'DEBIT', amountMinor: BigInt(10) },
        { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: BigInt(10) },
      ],
    });
  }
  await postMatrixEntry({
    sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
    occurredAt: new Date('2026-10-11T12:00:00Z'),
    lines: [
      { accountCode: 'BANK', side: 'CREDIT', amountMinor: BigInt(40) },
      { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: BigInt(40) },
    ],
  });
  await postMatrixEntry({
    sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
    occurredAt: new Date('2026-10-12T12:00:00Z'),
    lines: [
      { accountCode: 'CASH', side: 'CREDIT', amountMinor: BigInt(100) },
      { accountCode: 'BANK', side: 'DEBIT', amountMinor: BigInt(100) },
    ],
  });
  await postMatrixEntry({
    sourceKind: 'PHARMACY_GOODS_RECEIPT',
    occurredAt: new Date('2026-10-13T12:00:00Z'),
    lines: [
      { accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: BigInt(80) },
      { accountCode: 'ACCOUNTS_PAYABLE', side: 'CREDIT', amountMinor: BigInt(80) },
    ],
  });
  await postMatrixEntry({
    sourceKind: 'PHARMACY_OPENING_LEDGER',
    occurredAt: new Date('2026-10-14T12:00:00Z'),
    lines: [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: BigInt(500) },
      { accountCode: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', amountMinor: BigInt(500) },
    ],
  });
  usdSaleId = await postMatrixEntry({
    sourceKind: 'PHARMACY_TENDER',
    occurredAt: new Date('2026-10-15T12:00:00Z'),
    currency: 'USD',
    lines: [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: BigInt(25) },
      { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: BigInt(25) },
    ],
  });
  await postMatrixEntry({
    sourceKind: 'PHARMACY_TENDER',
    occurredAt: new Date('2026-10-16T12:00:00Z'),
    currency: 'USD',
    reversesEntryId: usdSaleId,
    lines: [
      { accountCode: 'CASH', side: 'CREDIT', amountMinor: BigInt(25) },
      { accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: BigInt(25) },
    ],
  });
  await postMatrixEntry({
    sourceKind: 'PHARMACY_GOODS_RECEIPT',
    occurredAt: new Date('2026-10-17T12:00:00Z'),
    lines: [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: BigInt(9) },
      { accountCode: 'INVENTORY', side: 'CREDIT', amountMinor: BigInt(9) },
    ],
  });
  await postMatrixEntry({
    sourceKind: 'PHARMACY_TENDER',
    occurredAt: period.to,
    lines: [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: BigInt(777) },
      { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: BigInt(777) },
    ],
  });
}, 60_000);

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

  it('executes the monetary acceptance matrix through the migrated database query', async () => {
    const result = await withTenantDb(organizationId, (db) =>
      loadCashFlowProjection(db, { organizationId, branchId: matrixBranchId }, period, [
        {
          currency: 'PKR',
          openingMinor: '9007199254740992',
          movementMinor: '770',
          closingMinor: '9007199254741762',
        },
      ])
    );

    expect(result.find((item) => item.currency === 'PKR')).toMatchObject({
      openingMinor: '9007199254740993',
      operatingMinor: '260',
      financingMinor: '500',
      unclassifiedMinor: '9',
      movementMinor: '769',
      closingMinor: '9007199254741762',
      canonicalOpeningDiscrepancyMinor: '1',
      canonicalMovementDiscrepancyMinor: '-1',
      canonicalClosingDiscrepancyMinor: '0',
      canonicalControlMatches: false,
    });
    const pkr = result.find((item) => item.currency === 'PKR')!;
    expect(pkr.evidence).toHaveLength(33);
    expect(pkr.evidence.map((item) => item.category)).toEqual(
      expect.arrayContaining(['OPERATING', 'FINANCING', 'UNCLASSIFIED'])
    );
    expect(result.find((item) => item.currency === 'USD')).toMatchObject({
      operatingMinor: '0',
      movementMinor: '0',
      closingMinor: '0',
    });
    expect(result.find((item) => item.currency === 'USD')!.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ reversesEntryId: usdSaleId })])
    );
  });
});
