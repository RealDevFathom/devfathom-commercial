import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const branchId = 'branch-1';

function fixture(status: 'ACTIVE' | 'ONBOARDING') {
  const transaction = vi.fn();
  const profile = vi.fn().mockResolvedValue(null);
  const db = {
    $transaction: transaction,
    pharmacyBranch: {
      findMany: vi.fn().mockResolvedValue([{ id: branchId }]),
      findFirst: vi.fn().mockResolvedValue({ id: branchId }),
    },
    branchRegulatoryProfile: { findFirst: profile },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([{ branchId }]) },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', status, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
  return { caller, profile, transaction };
}

describe('pharmacy sales regulatory admission', () => {
  it('refuses sale creation while the organization is onboarding', async () => {
    const { caller, profile, transaction } = fixture('ONBOARDING');

    await expect(caller.create({ branchId, quotation: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy sales are unavailable until the organization is active.',
    });
    expect(profile).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses sale creation when the branch has no operable regulatory profile', async () => {
    const { caller, profile, transaction } = fixture('ACTIVE');

    await expect(caller.create({ branchId, quotation: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This branch does not have an operable regulatory profile.',
    });
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1', branchId }),
      })
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses settlement before a tender write when the regulatory profile is missing', async () => {
    const { caller, transaction } = fixture('ACTIVE');

    await expect(
      caller.tender({
        branchId,
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate: new Date('2026-10-22T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        cashReceivedMinor: 100,
        idempotencyKey: 'attempt-1',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'This branch does not have an operable regulatory profile.',
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
