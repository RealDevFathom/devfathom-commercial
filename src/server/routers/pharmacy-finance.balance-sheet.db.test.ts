/**
 * @vitest-environment node
 *
 * End-to-end balance-sheet acceptance against a migrated, RLS-enforcing PostgreSQL database.
 * Requires TEST_DATABASE_URL (or WHA1372_TEST_DATABASE_URL) pointing at a disposable database.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyBalanceSheet } from '@/lib/pharmacy/accounts/balance-sheet';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: vi.fn(async () => true),
}));

const url = process.env.WHA1372_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomUUID();
const ORG = `balance_sheet_${suffix}`;
const OTHER_ORG = `balance_sheet_other_${suffix}`;
const BRANCH = `balance_sheet_branch_${suffix}`;
const OTHER_BRANCH = `balance_sheet_branch_other_${suffix}`;
const INACTIVE_BRANCH = `balance_sheet_branch_inactive_${suffix}`;
const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-10-01T00:00:00.000Z';

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Line = {
  accountCode: import('@/generated/prisma/client').FinanceAccountCode;
  side: 'DEBIT' | 'CREDIT';
  amountMinor: number;
};
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;

async function post(
  organizationId: string,
  branchId: string,
  occurredAt: string,
  lines: Line[],
  options: {
    sourceKind?: import('@/generated/prisma/client').FinanceSourceKind;
    reversesEntryId?: string;
  } = {}
) {
  return withTenantDb(organizationId, (db) => {
    const id = randomUUID();
    return db.financeJournalEntry.create({
      data: {
        id,
        organizationId,
        branchId,
        sourceKind: options.sourceKind ?? 'PHARMACY_BOOKKEEPING_TRANSACTION',
        sourceId: id,
        description: 'Balance sheet acceptance fixture',
        actorId: id,
        occurredAt: new Date(occurredAt),
        idempotencyKey: id,
        reversesEntryId: options.reversesEntryId,
        reversalReason: options.reversesEntryId ? 'Acceptance fixture reversal' : undefined,
        lines: { create: lines.map((line) => ({ ...line, organizationId, branchId })) },
      },
    });
  });
}

async function caller(db: ScopedDb, organizationId = ORG) {
  const { pharmacyFinanceRouter } = await import('./pharmacy-finance');
  return pharmacyFinanceRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-reports'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: `${organizationId}_admin`, role: 'ADMIN', status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
      [ORG, OTHER_ORG]
    )
  );
  for (const [organizationId, id, active] of [
    [ORG, BRANCH, true],
    [ORG, OTHER_BRANCH, true],
    [ORG, INACTIVE_BRANCH, false],
    [OTHER_ORG, `${OTHER_BRANCH}_tenant`, true],
  ] as const) {
    await withTenantDb(organizationId, (db) =>
      db.pharmacyBranch.create({
        data: {
          id,
          organizationId,
          code: id,
          name: id,
          addressLine: '1 Test Road',
          city: 'Lahore',
          provinceCode: 'PB',
          active,
        },
      })
    );
  }

  // Pre-window opening capital and retained trading result must still be in closing balances.
  await post(
    ORG,
    BRANCH,
    '2026-08-01T00:00:00Z',
    [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 1000 },
      { accountCode: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', amountMinor: 1000 },
    ],
    { sourceKind: 'PHARMACY_OPENING_LEDGER' }
  );
  await post(
    ORG,
    BRANCH,
    '2026-08-31T23:59:59.999Z',
    [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 200 },
      { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 200 },
    ],
    { sourceKind: 'PHARMACY_SALE_LINE' }
  );
  await post(
    ORG,
    BRANCH,
    FROM,
    [
      { accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: 500 },
      { accountCode: 'ACCOUNTS_PAYABLE', side: 'CREDIT', amountMinor: 500 },
    ],
    { sourceKind: 'PHARMACY_GOODS_RECEIPT' }
  );
  await post(
    ORG,
    BRANCH,
    '2026-09-05T00:00:00Z',
    [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 280 },
      { accountCode: 'SALES_DISCOUNT', side: 'DEBIT', amountMinor: 20 },
      { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 300 },
      { accountCode: 'COST_OF_GOODS_SOLD', side: 'DEBIT', amountMinor: 120 },
      { accountCode: 'INVENTORY', side: 'CREDIT', amountMinor: 120 },
    ],
    { sourceKind: 'PHARMACY_SALE_LINE' }
  );
  await post(ORG, BRANCH, '2026-09-06T00:00:00Z', [
    { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT', amountMinor: 50 },
    { accountCode: 'CASH', side: 'CREDIT', amountMinor: 50 },
  ]);
  await post(ORG, BRANCH, '2026-09-07T00:00:00Z', [
    { accountCode: 'ACCOUNTS_PAYABLE', side: 'DEBIT', amountMinor: 200 },
    { accountCode: 'CASH', side: 'CREDIT', amountMinor: 200 },
  ]);
  await post(
    ORG,
    BRANCH,
    '2026-09-08T00:00:00Z',
    [
      { accountCode: 'ACCOUNTS_RECEIVABLE', side: 'DEBIT', amountMinor: 100 },
      { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 100 },
    ],
    { sourceKind: 'PHARMACY_SALE_LINE' }
  );
  await post(ORG, BRANCH, '2026-09-09T00:00:00Z', [
    { accountCode: 'CASH', side: 'DEBIT', amountMinor: 80 },
    { accountCode: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amountMinor: 80 },
  ]);
  const returnedSale = await post(
    ORG,
    BRANCH,
    '2026-09-09T12:00:00Z',
    [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 30 },
      { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 30 },
      { accountCode: 'COST_OF_GOODS_SOLD', side: 'DEBIT', amountMinor: 12 },
      { accountCode: 'INVENTORY', side: 'CREDIT', amountMinor: 12 },
    ],
    { sourceKind: 'PHARMACY_SALE_LINE' }
  );
  await post(
    ORG,
    BRANCH,
    '2026-09-10T00:00:00Z',
    [
      { accountCode: 'SALES_REVENUE', side: 'DEBIT', amountMinor: 30 },
      { accountCode: 'CASH', side: 'CREDIT', amountMinor: 30 },
      { accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: 12 },
      { accountCode: 'COST_OF_GOODS_SOLD', side: 'CREDIT', amountMinor: 12 },
    ],
    { sourceKind: 'PHARMACY_SALE_RETURN_LINE', reversesEntryId: returnedSale.id }
  );

  // These balanced entries must be excluded by exclusive cutoff, branch scope, and RLS tenant scope.
  for (const [organizationId, branchId, at] of [
    [ORG, BRANCH, TO],
    [ORG, OTHER_BRANCH, '2026-09-15T00:00:00Z'],
    [OTHER_ORG, `${OTHER_BRANCH}_tenant`, '2026-09-15T00:00:00Z'],
  ]) {
    await post(organizationId, branchId, at, [
      { accountCode: 'CASH', side: 'DEBIT', amountMinor: 99999 },
      { accountCode: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', amountMinor: 99999 },
    ]);
  }
}, 30_000);

suite('balance sheet through pharmacyFinance.financialStatements', () => {
  it('reads complete posted closing balances independent of journal pagination and honors all scopes', async () => {
    await withTenantDb(ORG, async (db) => {
      const api = await caller(db);
      const first = await api.financialStatements({
        branchId: BRANCH,
        from: FROM,
        to: TO,
        page: 1,
      });
      const beyondJournal = await api.financialStatements({
        branchId: BRANCH,
        from: FROM,
        to: TO,
        page: 2,
      });
      expect(beyondJournal.journal).toEqual([]);
      expect(beyondJournal.accounts).toEqual(first.accounts);
      expect(
        Object.fromEntries(first.accounts.map((row) => [row.accountCode, row.closingMinor]))
      ).toEqual({
        ACCOUNTS_PAYABLE: '-300',
        ACCOUNTS_RECEIVABLE: '20',
        CASH: '1310',
        COST_OF_GOODS_SOLD: '120',
        INVENTORY: '380',
        OPENING_BALANCE_EQUITY: '-1000',
        OPERATING_EXPENSE: '50',
        SALES_DISCOUNT: '20',
        SALES_REVENUE: '-600',
      });
      expect(classifyBalanceSheet(first.accounts)).toMatchObject([
        {
          currency: 'PKR',
          currentResultMinor: '410',
          status: 'reconciled',
          totals: {
            assetsMinor: '1710',
            liabilitiesMinor: '300',
            openingEquityMinor: '1000',
            equityAndLiabilitiesMinor: '1710',
            reconciliationGapMinor: '0',
          },
        },
      ]);
      for (const entry of first.journal) {
        const debit = entry.lines
          .filter((line) => line.side === 'DEBIT')
          .reduce((sum, line) => sum + line.amountMinor, 0);
        const credit = entry.lines
          .filter((line) => line.side === 'CREDIT')
          .reduce((sum, line) => sum + line.amountMinor, 0);
        expect(debit).toBe(credit);
      }
    });
  });

  it('rejects inactive and foreign branches at the production authorization gate', async () => {
    await withTenantDb(ORG, async (db) => {
      const api = await caller(db);
      await expect(
        api.financialStatements({ branchId: INACTIVE_BRANCH, from: FROM, to: TO, page: 1 })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.financialStatements({ branchId: `${OTHER_BRANCH}_tenant`, from: FROM, to: TO, page: 1 })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});
