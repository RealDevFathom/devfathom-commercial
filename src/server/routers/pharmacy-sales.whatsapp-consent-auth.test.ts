import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const input = { branchId: 'branch-a', customerId: 'customer-a', optedIn: true };

function fixture(assigned = true) {
  const db = {
    pharmacyBranch: {
      findMany: vi.fn().mockResolvedValue([{ id: 'branch-a' }]),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue(assigned ? { id: 'assignment-a' } : null),
    },
    pharmacyCustomer: {
      findFirst: vi.fn().mockResolvedValue({ patientId: 'patient-a' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: 'patient-a' }])
      .mockResolvedValueOnce([{ patientId: 'patient-a' }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

describe('pharmacySales.setCustomerWhatsAppOptIn authorization', () => {
  beforeEach(() => mocks.can.mockReset());

  it('honours the central DENY-over-ALLOW decision before starting a write transaction', async () => {
    mocks.can.mockResolvedValue(false);
    const f = fixture();

    await expect(f.caller.setCustomerWhatsAppOptIn(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy counter permission required.',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cashier-a' }),
      'pharmacy:counter',
      undefined,
      expect.objectContaining({ db: f.db, source: 'TRPC' })
    );
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an actor who is not assigned to the supplied branch', async () => {
    mocks.can.mockResolvedValue(true);
    const f = fixture(false);

    await expect(f.caller.setCustomerWhatsAppOptIn(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it('locks consent and updates the tenant customer inside one transaction', async () => {
    mocks.can.mockResolvedValue(true);
    const f = fixture();

    await expect(f.caller.setCustomerWhatsAppOptIn(input)).resolves.toMatchObject({
      whatsappOptIn: true,
    });
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    expect(f.db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.db.pharmacyCustomer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer-a', organizationId: 'org-a', active: true },
      data: { whatsappOptIn: true, whatsappOptInChangedAt: expect.any(Date) },
    });
  });
});
