import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  branches: vi.fn(),
  branch: vi.fn(),
  account: vi.fn(),
  queryRaw: vi.fn(),
  ledger: vi.fn(),
  collect: vi.fn(),
  remind: vi.fn(),
  annotateAudit: vi.fn(),
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
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/pharmacy/family-khata', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/family-khata')>(
    '@/lib/pharmacy/family-khata'
  )),
  listKhataLedger: mocks.ledger,
  collectKhataPayment: mocks.collect,
}));
vi.mock('@/lib/pharmacy/whatsapp/khata-reminders', () => ({
  processDueWhatsAppKhataReminders: mocks.remind,
}));
import type { TRPCContext } from '@/server/trpc';
import { FamilyKhataError } from '@/lib/pharmacy/family-khata';
import { PharmacyBookkeepingError } from '@/lib/pharmacy/bookkeeping';
import { pharmacyKhataRouter } from './khata-router';

function caller({ role = 'ADMIN', organizationId = 'org-a', vertical = 'PHARMACY' } = {}) {
  const db = {
    pharmacyBranch: { findMany: mocks.branches, findFirst: mocks.branch },
    pharmacyFamilyAccount: { findFirst: mocks.account },
    $queryRaw: mocks.queryRaw,
    $transaction: (run: (tx: unknown) => unknown) => run(db),
  };
  return pharmacyKhataRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'owner-a', organizationId, role, status: 'ACTIVE' },
    },
    entitlements: { organizationId: 'org-a', modules: [], enabledModules: ['pharmacy-counter'] },
    organization: { id: 'org-a', vertical },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
const trusted = { organizationId: 'org-a', actorId: 'owner-a', branchId: 'branch-a' };
const payment = {
  branchId: 'branch-a',
  familyAccountId: 'fam-a',
  amountMinor: 2_500,
  method: 'CASH' as const,
  idempotencyKey: 'key-0001',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.branches.mockResolvedValue([{ id: 'branch-a', name: 'Main' }]);
  mocks.branch.mockResolvedValue({ id: 'branch-a' });
  mocks.account.mockResolvedValue({ id: 'fam-a' });
  mocks.queryRaw.mockResolvedValue([]);
  mocks.ledger.mockResolvedValue({ accounts: [], truncated: false });
  mocks.collect.mockResolvedValue({ replayed: false, paidMinor: 2_500, remainingBalanceMinor: 0 });
  mocks.remind.mockResolvedValue({ configured: true, sent: 1 });
});

describe('DEV-730 Khata router', () => {
  it('reads the ledger with trusted scope after binding the branch', async () => {
    await caller().ledger({ branchId: 'branch-a' });
    expect(mocks.branch).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a', active: true },
      select: { id: true },
    });
    expect(mocks.queryRaw.mock.calls[0]![0].values).toEqual(['branch-a']);
    expect(mocks.ledger).toHaveBeenCalledWith(expect.anything(), trusted);
  });

  it('denies a non-owner before any Khata read or write', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller({ role: 'MEMBER' }).ledger({ branchId: 'branch-a' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    await expect(caller({ role: 'MEMBER' }).collectPayment(payment)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('denies without the counter package, another tenant, or a non-pharmacy workspace', async () => {
    mocks.licensed.mockImplementation((_: unknown, key: string) => key !== 'pharmacy-counter');
    await expect(caller().ledger({ branchId: 'branch-a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.licensed.mockReturnValue(true);
    await expect(
      caller({ organizationId: 'org-b' }).ledger({ branchId: 'branch-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller({ vertical: 'HOTEL' }).ledger({ branchId: 'branch-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it('refuses an inactive or foreign branch', async () => {
    mocks.branch.mockResolvedValue(null);
    await expect(caller().collectPayment(payment)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('collects with server scope, validates input and audits the payment', async () => {
    await caller().collectPayment(payment);
    expect(mocks.collect).toHaveBeenCalledWith(expect.anything(), trusted, payment);
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyKhata.collectPayment',
        targetId: 'fam-a',
        metadata: expect.objectContaining({ amountMinor: 2_500, method: 'CASH' }),
      })
    );
    await expect(caller().collectPayment({ ...payment, amountMinor: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().collectPayment({ ...payment, amountMinor: 1.5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it('maps a refused settlement to a typed error', async () => {
    mocks.collect.mockRejectedValue(new FamilyKhataError('PAYMENT_EXCEEDS_BALANCE'));
    await expect(caller().collectPayment(payment)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PAYMENT_EXCEEDS_BALANCE',
    });
  });

  it('maps a closed accounting period to a typed refusal', async () => {
    mocks.collect.mockRejectedValue(new PharmacyBookkeepingError('PERIOD_CLOSED'));
    await expect(caller().collectPayment(payment)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PERIOD_CLOSED',
    });
  });

  it('sends a reminder for exactly the selected account through the gated job', async () => {
    await caller().sendReminder({ branchId: 'branch-a', familyAccountId: 'fam-a' });
    expect(mocks.account).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-a', id: 'fam-a', active: true },
      select: { id: true },
    });
    expect(mocks.remind).toHaveBeenCalledWith({
      limit: 1,
      account: { organizationId: 'org-a', branchId: 'branch-a', familyAccountId: 'fam-a' },
    });
  });

  it('requires the CRM package and a live account before reminding', async () => {
    mocks.licensed.mockImplementation((_: unknown, key: string) => key !== 'pharmacy-crm');
    await expect(
      caller().sendReminder({ branchId: 'branch-a', familyAccountId: 'fam-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.licensed.mockReturnValue(true);
    mocks.account.mockResolvedValue(null);
    await expect(
      caller().sendReminder({ branchId: 'branch-a', familyAccountId: 'fam-x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.remind).not.toHaveBeenCalled();
  });
});
