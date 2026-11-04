import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createInspectionPack: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async (_subject, action: string) => action === 'pharmacy:safety'),
}));
vi.mock('@/lib/pharmacy/inspection-pack', () => ({
  createInspectionPack: mocks.createInspectionPack,
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySafetyRouter } from './pharmacy-safety';

const app = router({ pharmacySafety: pharmacySafetyRouter });

function fixture(assignedBranchIds: string[]) {
  const db = {
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue(assignedBranchIds.map((branchId) => ({ branchId }))),
    },
    pharmacyBranch: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        assignedBranchIds.includes(where.id) ? { id: where.id } : null
      ),
    },
  };
  const ctx = {
    db,
    entitlements: { organizationId: 'org_1', modules: [] },
    session: { user: { id: 'user_1', role: 'EMPLOYEE', status: 'ACTIVE' } },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(ctx).pharmacySafety };
}

const RANGE = { from: new Date('2026-10-01'), to: new Date('2026-10-31') };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createInspectionPack.mockResolvedValue({ manifestSha256: 'f'.repeat(64) });
});

describe('createInspectionPack branch scope', () => {
  it('refuses a branch the caller is not assigned to before building anything', async () => {
    const f = fixture(['branch_mine']);
    await expect(
      f.caller.createInspectionPack({ branchId: 'branch_other', ...RANGE })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1', userId: 'user_1', active: true },
      })
    );
    expect(mocks.createInspectionPack).not.toHaveBeenCalled();
  });

  it('builds the pack for an assigned branch', async () => {
    const f = fixture(['branch_mine']);
    await expect(
      f.caller.createInspectionPack({ branchId: 'branch_mine', ...RANGE })
    ).resolves.toEqual({ manifestSha256: 'f'.repeat(64) });
    expect(mocks.createInspectionPack).toHaveBeenCalledWith(f.db, {
      branchId: 'branch_mine',
      ...RANGE,
    });
  });
});
