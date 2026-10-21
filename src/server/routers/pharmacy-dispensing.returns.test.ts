import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { pharmacyPurchasingRouter } from './pharmacy-purchasing';
import { pharmacyDispensingRouter } from './pharmacy-dispensing';
import { router, type TRPCContext } from '../trpc';
const app = router({ pharmacyDispensing: pharmacyDispensingRouter });
function fixture(allow = true, capabilities: readonly string[] = ['pharmacy:dispense']) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: capabilities.map((capability) => ({
            capability,
            effect: allow ? 'ALLOW' : 'DENY',
          })),
        },
        permissionOverrides: [],
      }),
    },
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'b' }) },
    pharmacyReturnVerificationTask: {
      findMany: vi.fn().mockResolvedValue([{ id: 'task-1' }, { id: 'task-2' }]),
    },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org', modules: [] },
    session: { user: { id: 'u', status: 'ACTIVE', role: 'EMPLOYEE' } },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return {
    db,
    purchasing: pharmacyPurchasingRouter.createCaller(ctx),
    caller: app.createCaller(ctx).pharmacyDispensing,
  };
}
describe('OTC return verification queue', () => {
  it('requires pharmacist capability', async () => {
    const f = fixture(false);
    await expect(f.caller.returnVerificationQueue({ branchId: 'b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.pharmacyReturnVerificationTask.findMany).not.toHaveBeenCalled();
  });
  it('scopes repeated tasks to the authenticated tenant and selected branch', async () => {
    const f = fixture();
    await expect(f.caller.returnVerificationQueue({ branchId: 'b' })).resolves.toHaveLength(2);
    expect(f.db.pharmacyReturnVerificationTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org', branchId: 'b' } })
    );
  });
  it('refuses a branch outside the tenant', async () => {
    const f = fixture();
    f.db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(f.caller.returnVerificationQueue({ branchId: 'other' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(f.db.pharmacyReturnVerificationTask.findMany).not.toHaveBeenCalled();
  });
});

// Exercise the real capability middleware with shipped job templates, not mocked can().
describe('pharmacy job template authorization (#130)', () => {
  it('allows the pharmacist template to enter dispensing procedures', async () => {
    const f = fixture(
      true,
      PHARMACY_ROLE_TEMPLATES.find((r) => r.key === 'pharmacist')!.capabilities
    );
    await expect(f.caller.returnVerificationQueue({ branchId: 'b' })).resolves.toHaveLength(2);
  });
  it('rejects legacy dot dispense grants', async () => {
    const f = fixture(true, ['pharmacy.dispense']);
    await expect(f.caller.returnVerificationQueue({ branchId: 'b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.pharmacyReturnVerificationTask.findMany).not.toHaveBeenCalled();
  });
  it('denies goods-in to the cashier before any receipt transaction', async () => {
    const f = fixture(true, PHARMACY_ROLE_TEMPLATES.find((r) => r.key === 'cashier')!.capabilities);
    await expect(
      f.purchasing.postGoodsReceipt({ branchId: 'b', goodsReceiptId: 'receipt' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
