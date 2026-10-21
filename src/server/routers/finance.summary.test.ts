import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

const db = {
  transaction: { groupBy: vi.fn() },
  invoice: { groupBy: vi.fn(), findMany: vi.fn() },
  recurringExpense: { findMany: vi.fn() },
};

function caller() {
  return financeRouter.createCaller({
    db,
    entitlements: { organizationId: 'org_1', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.transaction.groupBy.mockResolvedValue([]);
  db.invoice.groupBy.mockResolvedValue([]);
  db.recurringExpense.findMany.mockResolvedValue([]);
});

describe('finance overview summary', () => {
  it('subtracts partial payments from outstanding totals per currency', async () => {
    db.invoice.findMany.mockResolvedValue([
      { total: 100, currency: 'USD', payments: [{ amount: 35.25 }] },
      { total: 50, currency: 'USD', payments: [] },
      { total: 10_000, currency: 'PKR', payments: [{ amount: 2_500 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([
      { currency: 'USD', amount: 114.75 },
      { currency: 'PKR', amount: 7_500 },
    ]);
    expect(summary.outstandingCount).toBe(3);
    expect(db.invoice.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['SENT', 'OVERDUE'] } },
      select: {
        total: true,
        currency: true,
        payments: { select: { amount: true } },
      },
    });
  });

  it('never reports a negative outstanding balance for an overpaid open invoice', async () => {
    db.invoice.findMany.mockResolvedValue([
      { total: 20, currency: 'USD', payments: [{ amount: 20.01 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 0 }]);
    expect(summary.outstandingCount).toBe(1);
  });
});
