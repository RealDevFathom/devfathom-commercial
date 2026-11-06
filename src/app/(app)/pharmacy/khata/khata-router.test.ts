import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  branch: vi.fn(),
  branches: vi.fn(),
  accounts: vi.fn(),
  totals: vi.fn(),
  payment: vi.fn(),
  bind: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.licensed,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
import type { TRPCContext } from '@/server/trpc';
import { pharmacyKhataListRouter } from './khata-router';
const tx = {
  $queryRaw: mocks.bind,
  pharmacyFamilyAccount: { findMany: mocks.accounts },
  pharmacyKhataEvent: { groupBy: mocks.totals, findFirst: mocks.payment },
};
function caller(options: { role?: string; org?: string; entitlementOrg?: string } = {}) {
  return pharmacyKhataListRouter.createCaller({
    db: {
      pharmacyBranch: { findFirst: mocks.branch, findMany: mocks.branches },
      $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
    },
    session: {
      expires: 'later',
      user: {
        id: 'owner',
        organizationId: options.org ?? 'org',
        role: options.role ?? 'ADMIN',
        status: 'ACTIVE',
      },
    },
    entitlements: {
      organizationId: options.entitlementOrg ?? 'org',
      enabledModules: ['pharmacy-counter'],
      modules: [],
    },
    organization: { id: 'org', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.branch.mockResolvedValue({ id: 'b' });
  mocks.bind.mockResolvedValue([]);
  mocks.accounts.mockResolvedValue([
    {
      id: 'a',
      displayName: 'Family',
      creditLimitMinor: 5000,
      payer: { patient: { phone: '03001234567' } },
    },
  ]);
  mocks.totals.mockResolvedValue([
    { familyAccountId: 'a', kind: 'CHARGE', _sum: { amountMinor: 3000 } },
    { familyAccountId: 'a', kind: 'PAYMENT', _sum: { amountMinor: 700 } },
    { familyAccountId: 'a', kind: 'DISHONOURED_CHEQUE', _sum: { amountMinor: 200 } },
  ]);
  mocks.payment.mockResolvedValue({
    amountMinor: 700,
    occurredAt: new Date('2026-10-01T00:00:00Z'),
  });
});
describe('owner khata list', () => {
  it('uses branch-scoped ledger totals and last payment', async () => {
    const result = await caller().accounts({ branchId: 'b' });
    expect(result.rows[0]).toMatchObject({
      displayName: 'Family',
      phone: '03001234567',
      balanceMinor: 2500,
      creditLimitMinor: 5000,
      lastPayment: { amountMinor: 700 },
    });
    expect(mocks.bind).toHaveBeenCalledOnce();
    expect(mocks.accounts).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org', branchId: 'b', active: true },
        take: 51,
      })
    );
    expect(mocks.totals).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org', branchId: 'b', familyAccountId: { in: ['a'] } },
      })
    );
  });
  it('rejects non-owner and mismatched tenant before ledger access', async () => {
    await expect(caller({ role: 'MEMBER' }).accounts({ branchId: 'b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller({ entitlementOrg: 'other' }).accounts({ branchId: 'b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.accounts).not.toHaveBeenCalled();
  });
  it('rejects foreign or inactive branches before ledger access', async () => {
    mocks.branch.mockResolvedValue(null);
    await expect(caller().accounts({ branchId: 'foreign' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.accounts).not.toHaveBeenCalled();
  });
  it('returns a cursor for the next page without dropping an account', async () => {
    mocks.accounts.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({
        id: String(i).padStart(3, '0'),
        displayName: 'A',
        creditLimitMinor: 0,
        payer: { patient: { phone: null } },
      }))
    );
    const result = await caller().accounts({ branchId: 'b' });
    expect(result.rows).toHaveLength(50);
    expect(result.next).toBe('049');
    await caller().accounts({ branchId: 'b', after: result.next! });
    expect(mocks.accounts).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: '049' } }) })
    );
  });
});
