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

import { pharmacyDispensingRouter } from './pharmacy-dispensing';
import { router, type TRPCContext } from '../trpc';
const app = router({ pharmacyDispensing: pharmacyDispensingRouter });
function fixture(allow = true) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: allow ? 'ALLOW' : 'DENY' }],
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
  return { db, caller: app.createCaller(ctx).pharmacyDispensing };
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
