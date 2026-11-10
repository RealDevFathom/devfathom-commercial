/**
 * For the separate direct-script runner, against its migrated disposable PostgreSQL DB.
 * No mocked totals, SQL, tenant scope, or pagination. These are posted-journal
 * fixtures for a read-only projection, not tests of the operational source adapters.
 * Gated on its test database URL, like the other database-backed suites.
 * The direct-script runner must supply that URL for database acceptance.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FinanceAccountCode, FinanceSourceKind } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { classifyBalanceSheet } from './balance-sheet';

const url = process.env.BALANCE_SHEET_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

const organizationId = `dev117_${randomUUID()}`;
const otherOrganizationId = `${organizationId}_other`;
const branchId = `${organizationId}_main`;
const otherBranchId = `${organizationId}_second`;
const foreignBranchId = `${organizationId}_foreign`;
const emptyBranchId = `${organizationId}_empty`;
const gapBranchId = `${organizationId}_gap`;
const gapPeerBranchId = `${organizationId}_gap_peer`;
const from = new Date('2026-10-28T00:00:00.000Z');
const to = new Date('2026-10-29T00:00:00.000Z');
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let financialStatements: typeof import('@/lib/pharmacy/financial-statements').financialStatements;
let originalExpenseId: string;
let reversalId: string;

type Leg = {
  accountCode: FinanceAccountCode;
  side: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  branchId?: string;
};
const dr = (accountCode: FinanceAccountCode, amountMinor: number): Leg => ({
  accountCode,
  side: 'DEBIT',
  amountMinor,
});
const cr = (accountCode: FinanceAccountCode, amountMinor: number): Leg => ({
  accountCode,
  side: 'CREDIT',
  amountMinor,
});

async function post(
  at: string,
  sourceKind: FinanceSourceKind,
  legs: Leg[],
  options: {
    organizationId?: string;
    branchId?: string;
    currency?: 'PKR' | 'USD';
    reversesEntryId?: string;
  } = {}
) {
  const tenant = options.organizationId ?? organizationId;
  const branch = options.branchId ?? branchId;
  const id = randomUUID();
  await withTenantDb(tenant, (db) =>
    db.financeJournalEntry.create({
      data: {
        id,
        organizationId: tenant,
        branchId: branch,
        sourceKind,
        sourceId: id,
        description: 'DEV-117 disposable posted-balance fixture',
        actorId: 'dev117_fixture_actor',
        occurredAt: new Date(at),
        currency: options.currency ?? 'PKR',
        idempotencyKey: id,
        reversesEntryId: options.reversesEntryId,
        reversalReason: options.reversesEntryId ? 'Additive fixture correction' : undefined,
        lines: {
          create: legs.map((leg) => ({ ...leg, branchId: leg.branchId ?? branch })),
        },
      },
    })
  );
  return id;
}

function read(branch = branchId, tenant = organizationId, start = from, page = 1) {
  return withTenantDb(tenant, (db) =>
    financialStatements(db, { organizationId: tenant, branchId: branch }, { from: start, to, page })
  );
}

async function createBranch(db: ScopedDb, tenant: string, id: string) {
  await db.pharmacyBranch.create({
    data: {
      id,
      organizationId: tenant,
      code: id,
      name: id,
      addressLine: '1 Test Road',
      city: 'Lahore',
      provinceCode: 'PB',
    },
  });
}

beforeAll(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  ({ financialStatements } = await import('@/lib/pharmacy/financial-statements'));

  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
      [organizationId, otherOrganizationId]
    )
  );
  await withTenantDb(organizationId, async (db) => {
    for (const id of [branchId, otherBranchId, emptyBranchId, gapBranchId, gapPeerBranchId]) {
      await createBranch(db, organizationId, id);
    }
  });
  await withTenantDb(otherOrganizationId, (db) => createBranch(db, otherOrganizationId, foreignBranchId));

  await post('2026-09-01T00:00:00.000Z', 'PHARMACY_OPENING_LEDGER', [
    dr('CASH', 100000), dr('BANK', 20000), cr('OPENING_BALANCE_EQUITY', 120000),
  ]);
  await post('2026-09-02T00:00:00.000Z', 'PHARMACY_GOODS_RECEIPT', [
    dr('INVENTORY', 60000), cr('GOODS_RECEIVED_ACCRUAL', 60000),
  ]);
  await post('2026-09-03T00:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    dr('GOODS_RECEIVED_ACCRUAL', 50000), cr('ACCOUNTS_PAYABLE', 50000),
  ]);
  await post('2026-09-04T00:00:00.000Z', 'PHARMACY_INTERBRANCH_TRANSFER_LINE', [
    dr('INVENTORY_IN_TRANSIT', 7000), cr('BANK', 7000),
  ]);
  await post('2026-09-05T00:00:00.000Z', 'PHARMACY_SUPPLIER_CLAIM', [
    dr('SUPPLIER_CLAIM_RECEIVABLE', 3000), cr('INVENTORY', 3000),
  ]);
  // The prior sale and opening funding are absent from the selected journal page.
  await post('2026-10-27T23:59:59.999Z', 'PHARMACY_SALE_LINE', [
    dr('SALES_CLEARING', 28500), dr('SALES_DISCOUNT', 1500),
    dr('COST_OF_GOODS_SOLD', 12000), cr('SALES_REVENUE', 30000), cr('INVENTORY', 12000),
  ]);
  await post(from.toISOString(), 'PHARMACY_TENDER', [
    dr('CASH', 18500), dr('ACCOUNTS_RECEIVABLE', 10000), cr('SALES_CLEARING', 28500),
  ]);
  await post('2026-10-28T10:00:00.000Z', 'PHARMACY_SALE_LINE', [
    dr('SALES_CLEARING', 9000), dr('SALES_DISCOUNT', 1000),
    dr('COST_OF_GOODS_SOLD', 4000), cr('SALES_REVENUE', 10000), cr('INVENTORY', 4000),
  ]);
  await post('2026-10-28T11:00:00.000Z', 'PHARMACY_SALE_RETURN_LINE', [
    dr('SALES_REVENUE', 2000), dr('INVENTORY', 800), cr('SALES_CLEARING', 1800),
    cr('SALES_DISCOUNT', 200), cr('COST_OF_GOODS_SOLD', 800),
  ]);
  await post('2026-10-28T13:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    dr('ACCOUNTS_PAYABLE', 15000), cr('BANK', 15000),
  ]);
  await post('2026-10-28T14:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    dr('CASH', 4000), cr('ACCOUNTS_RECEIVABLE', 4000),
  ]);
  await post('2026-10-28T15:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    dr('BANK', 1000), cr('SUPPLIER_CLAIM_RECEIVABLE', 1000),
  ]);
  await post('2026-10-28T16:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    dr('OPERATING_EXPENSE', 2500), cr('CASH', 2500),
  ]);
  originalExpenseId = await post('2026-10-28T17:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    dr('OPERATING_EXPENSE', 500), cr('CASH', 500),
  ]);
  reversalId = await post('2026-10-28T18:00:00.000Z', 'PHARMACY_BOOKKEEPING_TRANSACTION', [
    cr('OPERATING_EXPENSE', 500), dr('CASH', 500),
  ], { reversesEntryId: originalExpenseId });
  await post('2026-10-28T23:59:59.999Z', 'PHARMACY_SALE_LINE', [
    dr('SALES_CLEARING', 123), cr('SALES_REVENUE', 123),
  ]);
  for (let index = 0; index < 30; index += 1) {
    await post('2026-10-28T12:00:00.000Z', 'PHARMACY_SALE_LINE', [
      dr('SALES_CLEARING', 1), cr('SALES_REVENUE', 1),
    ]);
  }
  await post(to.toISOString(), 'PHARMACY_SALE_LINE', [dr('CASH', 99999), cr('SALES_REVENUE', 99999)]);
  await post('2026-10-29T00:00:00.001Z', 'PHARMACY_SALE_LINE', [
    dr('CASH', 88888), cr('SALES_REVENUE', 88888),
  ]);
  // Each stored leg fits the ledger's integer column; their closing sum exceeds it.
  for (let index = 0; index < 3; index += 1) {
    await post('2026-09-01T00:00:00.000Z', 'PHARMACY_OPENING_LEDGER', [
      dr('CASH', 1999999999), cr('OPENING_BALANCE_EQUITY', 1999999999),
    ], { currency: 'USD' });
  }
  await post(from.toISOString(), 'PHARMACY_OPENING_LEDGER', [
    dr('CASH', 777777), cr('OPENING_BALANCE_EQUITY', 777777),
  ], { branchId: otherBranchId });
  await post(from.toISOString(), 'PHARMACY_OPENING_LEDGER', [
    dr('CASH', 888888), cr('OPENING_BALANCE_EQUITY', 888888),
  ], { organizationId: otherOrganizationId, branchId: foreignBranchId });
  // A globally balanced transfer legitimately leaves each branch with a gap.
  await post(from.toISOString(), 'PHARMACY_INTERBRANCH_TRANSFER_LINE', [
    dr('INVENTORY_IN_TRANSIT', 50), { ...cr('INVENTORY', 50), branchId: gapPeerBranchId },
  ], { branchId: gapBranchId });
}, 60000);

(url ? describe : describe.skip)('classified balance sheet from actual canonical PostgreSQL postings', () => {
  it('includes prior opening funding and earnings, then nets sales, returns, expenses and settlements once', async () => {
    const report = await read();
    const [pkr, usd] = classifyBalanceSheet(report.accounts);
    expect(pkr).toMatchObject({
      currency: 'PKR', assetsMinor: '183153', liabilitiesMinor: '45000',
      openingEquityMinor: '120000', currentResultMinor: '18153',
      liabilitiesAndEquityMinor: '183153', reconciliationGapMinor: '0', reconciled: true,
    });
    expect(Object.fromEntries(pkr!.accounts.map((row) => [row.accountCode, row.closingMinor]))).toEqual({
      CASH: '120000', BANK: '-1000', INVENTORY: '41800', INVENTORY_IN_TRANSIT: '7000',
      SUPPLIER_CLAIM_RECEIVABLE: '2000', ACCOUNTS_RECEIVABLE: '6000', SALES_CLEARING: '7353',
      GOODS_RECEIVED_ACCRUAL: '-10000', ACCOUNTS_PAYABLE: '-35000', OPENING_BALANCE_EQUITY: '-120000',
      SALES_REVENUE: '-38153', SALES_DISCOUNT: '2300', COST_OF_GOODS_SOLD: '15200', OPERATING_EXPENSE: '2500',
    });
    expect(pkr!.accounts.find((row) => row.accountCode === 'SALES_REVENUE')).toMatchObject({
      openingMinor: '-30000', debitMinor: '2000', creditMinor: '10153',
      normalSide: 'CREDIT', normalBalanceMinor: '38153',
    });
    expect(pkr!.accounts.find((row) => row.accountCode === 'CASH')).toMatchObject({
      openingMinor: '100000', debitMinor: '23000', creditMinor: '3000',
    });
    expect(report.profitAndLoss.find((row) => row.currency === 'PKR')?.netProfitMinor).toBe('1653');
    expect(usd).toMatchObject({
      currency: 'USD', assetsMinor: '5999999997', openingEquityMinor: '5999999997',
      currentResultMinor: '0', reconciliationGapMinor: '0', reconciled: true,
    });
  });

  it('uses exclusive cutoff totals independently of the window and every journal page', async () => {
    const first = await read();
    const second = await read(branchId, organizationId, from, 2);
    const wide = await read(branchId, organizationId, new Date('2026-09-01T00:00:00.000Z'));
    expect(first.journalCount).toBe(40);
    expect(first.journal).toHaveLength(25);
    expect(second.journal).toHaveLength(15);
    expect(first.accounts).toEqual(second.accounts);
    const closing = (report: typeof first) =>
      report.accounts.map(({ accountCode, currency, closingMinor }) => ({ accountCode, currency, closingMinor }));
    expect(closing(wide)).toEqual(closing(first));
    expect(first.accounts.find((row) => row.accountCode === 'SALES_REVENUE')?.closingMinor).toBe('-38153');
    expect(wide.accounts.find((row) => row.accountCode === 'SALES_REVENUE')).toMatchObject({
      openingMinor: '0', debitMinor: '2000', creditMinor: '40153', closingMinor: '-38153',
    });
    expect(wide.profitAndLoss.find((row) => row.currency === 'PKR')?.netProfitMinor).toBe('18153');
    expect(first.journal.some((entry) => entry.occurredAt.getTime() === to.getTime() - 1)).toBe(true);
    expect([...first.journal, ...second.journal].every((entry) => entry.occurredAt < to)).toBe(true);
    expect(second.journal.some((entry) => entry.occurredAt.getTime() === from.getTime())).toBe(true);
  });

  it('retains both the expense and its linked additive reversal', async () => {
    const trail = await withTenantDb(organizationId, (db) => db.financeJournalEntry.findMany({
      where: { organizationId, id: { in: [originalExpenseId, reversalId] } },
      include: { lines: true }, orderBy: { occurredAt: 'asc' },
    }));
    expect(trail).toHaveLength(2);
    expect(trail[0]).toMatchObject({ id: originalExpenseId, reversesEntryId: null });
    expect(trail[1]).toMatchObject({ id: reversalId, reversesEntryId: originalExpenseId });
    const expenseNet = trail.flatMap((entry) => entry.lines)
      .filter((line) => line.accountCode === 'OPERATING_EXPENSE')
      .reduce((sum, line) => sum + (line.side === 'DEBIT' ? line.amountMinor : -line.amountMinor), 0);
    expect(expenseNet).toBe(0);
  });

  it('separates two branches and two tenants, with RLS denying an explicitly foreign scope', async () => {
    expect(classifyBalanceSheet((await read(otherBranchId)).accounts)).toMatchObject([
      { currency: 'PKR', assetsMinor: '777777', openingEquityMinor: '777777', currentResultMinor: '0' },
    ]);
    expect(classifyBalanceSheet((await read(foreignBranchId, otherOrganizationId)).accounts)).toMatchObject([
      { currency: 'PKR', assetsMinor: '888888', openingEquityMinor: '888888', currentResultMinor: '0' },
    ]);
    const denied = await withTenantDb(organizationId, (db) => financialStatements(
      db, { organizationId: otherOrganizationId, branchId: foreignBranchId }, { from, to, page: 1 }
    ));
    expect(denied.accounts).toEqual([]);
    expect(denied.journal).toEqual([]);
    expect(denied.journalCount).toBe(0);
    expect((await read(foreignBranchId)).accounts).toEqual([]);
  });

  it('returns an empty source without manufacturing a currency or zero-activity claim', async () => {
    const empty = await read(emptyBranchId);
    expect(empty.accounts).toEqual([]);
    expect(empty.journalCount).toBe(0);
    expect(classifyBalanceSheet(empty.accounts)).toEqual([]);
  });

  it('exposes branch equation mismatches from a balanced cross-branch posting without plugging equity', async () => {
    const [sender] = classifyBalanceSheet((await read(gapBranchId)).accounts);
    const [peer] = classifyBalanceSheet((await read(gapPeerBranchId)).accounts);
    expect(sender).toMatchObject({
      assetsMinor: '50', openingEquityMinor: '0', currentResultMinor: '0',
      reconciliationGapMinor: '50', equationBalanced: false, reconciled: false,
    });
    expect(peer).toMatchObject({
      assetsMinor: '-50', openingEquityMinor: '0', currentResultMinor: '0',
      reconciliationGapMinor: '-50', equationBalanced: false, reconciled: false,
    });
  });
});
