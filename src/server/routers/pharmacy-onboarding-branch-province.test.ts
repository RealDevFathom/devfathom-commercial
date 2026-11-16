/**
 * QA-3 — an owner or admin sets a branch's province. The change is scoped to
 * this organization's active branch, refused for anyone without admin access,
 * and audited with the before and after province in the same transaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  branchFindFirst: vi.fn(),
  branchUpdateMany: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: mocks.recordAudit,
}));

import type { TRPCContext } from '../trpc';
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';

function context(role = 'ADMIN'): TRPCContext {
  return {
    db: {
      pharmacyBranch: { findFirst: mocks.branchFindFirst },
      $transaction: mocks.transaction,
    },
    entitlements: {
      organizationId: 'pharmacy-org',
      enabledModules: ['pharmacy-core'],
      modules: [{ key: 'pharmacy-core', name: 'Pharmacy', enabled: true }],
    },
    session: {
      expires: 'later',
      user: {
        id: 'owner-1',
        name: 'Owner',
        email: 'owner@example.test',
        organizationId: 'pharmacy-org',
        role,
        status: 'ACTIVE',
      },
    },
    organization: { id: 'pharmacy-org' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch-1', name: 'Main', provinceCode: 'PK-PB' });
  mocks.branchUpdateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({ pharmacyBranch: { updateMany: mocks.branchUpdateMany } })
  );
});

describe('setBranchProvince (QA-3)', () => {
  it("changes this organization's branch and audits the before and after province", async () => {
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .setBranchProvince({ branchId: 'branch-1', provinceCode: 'PK-SD' })
    ).resolves.toEqual({ branchId: 'branch-1', provinceCode: 'PK-SD', changed: true });
    expect(mocks.branchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'pharmacy-org', id: 'branch-1', active: true },
      })
    );
    expect(mocks.branchUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'pharmacy-org', id: 'branch-1', provinceCode: 'PK-PB' },
      data: { provinceCode: 'PK-SD' },
    });
    expect(mocks.recordAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        organizationId: 'pharmacy-org',
        actorId: 'owner-1',
        action: 'pharmacy.branch.province.set',
        targetType: 'PharmacyBranch',
        targetId: 'branch-1',
        changes: { provinceCode: { before: 'PK-PB', after: 'PK-SD' } },
      }),
      expect.anything()
    );
  });

  it('refuses a caller without admin access and changes nothing', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context('EMPLOYEE'))
        .setBranchProvince({ branchId: 'branch-1', provinceCode: 'PK-SD' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('refuses a branch outside this organization on the branch field', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .setBranchProvince({ branchId: 'other-tenant-branch', provinceCode: 'PK-SD' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses a province that is not a known Pakistani province', async () => {
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .setBranchProvince({ branchId: 'branch-1', provinceCode: 'XX' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
  });

  it('writes nothing when the branch already operates in that province', async () => {
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch-1', name: 'Main', provinceCode: 'SD' });
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .setBranchProvince({ branchId: 'branch-1', provinceCode: 'PK-SD' })
    ).resolves.toMatchObject({ changed: false });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('refuses a concurrent change instead of overwriting it', async () => {
    mocks.branchUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      pharmacyOnboardingRouter
        .createCaller(context())
        .setBranchProvince({ branchId: 'branch-1', provinceCode: 'PK-SD' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
