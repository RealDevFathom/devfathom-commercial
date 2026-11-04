import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  branchAssignmentFindMany: vi.fn(),
  overrideUpsert: vi.fn(),
  overrideDeleteMany: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import type { AuthzDb } from '@/lib/authz';
import { actorCanProcure } from '@/lib/pharmacy/procurement-access';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { organizationAdminRouter } from './organization-admin';

const db = {
  user: { findFirst: mocks.userFindFirst, findUnique: mocks.userFindUnique },
  pharmacyBranchAssignment: { findMany: mocks.branchAssignmentFindMany },
  userPermissionOverride: {
    upsert: mocks.overrideUpsert,
    deleteMany: mocks.overrideDeleteMany,
  },
};

function caller(organizationId = 'org_a') {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('organization member Goods-in access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.overrideUpsert.mockReset();
    mocks.userFindFirst.mockResolvedValue({ id: 'member_a', email: 'member@example.test' });
    // The granting administrator: tenant ADMIN without a role, organization-wide scope.
    mocks.userFindUnique.mockResolvedValue({
      role: 'ADMIN',
      organizationRole: null,
      permissionOverrides: [],
    });
    mocks.branchAssignmentFindMany.mockResolvedValue([]);
  });

  it('persists a canonical procurement denial and reports the audited state', async () => {
    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: false })
    ).resolves.toEqual({ granted: false });

    expect(mocks.overrideUpsert).toHaveBeenCalledWith({
      where: {
        userId_capability: { userId: 'member_a', capability: 'pharmacy:procurement' },
      },
      update: {
        effect: 'DENY',
        reason: 'Goods-in access revoked by workspace administrator',
        expiresAt: null,
      },
      create: {
        organizationId: 'org_a',
        userId: 'member_a',
        capability: 'pharmacy:procurement',
        effect: 'DENY',
        reason: 'Goods-in access revoked by workspace administrator',
        createdById: 'admin_a',
      },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'member_a',
        description: 'Removed Goods-in access for member@example.test',
        metadata: {
          capability: 'pharmacy:procurement',
          granted: false,
          grantedByUserId: 'admin_a',
          targetUserId: 'member_a',
          branchScope: 'organization',
        },
      })
    );
  });

  it('replaces a canonical denial with the requested grant and audits the result', async () => {
    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: true })
    ).resolves.toEqual({ granted: true });

    expect(mocks.overrideUpsert).toHaveBeenCalledWith({
      where: {
        userId_capability: { userId: 'member_a', capability: 'pharmacy:procurement' },
      },
      update: {
        effect: 'ALLOW',
        reason: 'Goods-in access granted by workspace administrator',
        expiresAt: null,
      },
      create: {
        organizationId: 'org_a',
        userId: 'member_a',
        capability: 'pharmacy:procurement',
        effect: 'ALLOW',
        reason: 'Goods-in access granted by workspace administrator',
        createdById: 'admin_a',
      },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'User',
        targetId: 'member_a',
        description: 'Granted Goods-in access for member@example.test',
        metadata: {
          capability: 'pharmacy:procurement',
          granted: true,
          grantedByUserId: 'admin_a',
          targetUserId: 'member_a',
          branchScope: 'organization',
        },
      })
    );
  });

  it.each(['ALLOW', 'DENY'] as const)(
    'renews an expired %s override so a confirmed grant authorizes procurement',
    async (effect) => {
      const { can } = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
      const rule = {
        capability: 'pharmacy:procurement',
        effect,
        expiresAt: new Date(0) as Date | null,
      };
      const authDb = {
        user: {
          findUnique: vi.fn(async () => ({
            organizationRole: null,
            permissionOverrides:
              rule.expiresAt === null || rule.expiresAt > new Date() ? [rule] : [],
          })),
        },
      } as unknown as AuthzDb;
      const subject = { id: 'member_a', role: 'EMPLOYEE', department: null, status: 'ACTIVE' };
      mocks.overrideUpsert.mockImplementationOnce(async ({ update }) => {
        Object.assign(rule, update);
        return rule;
      });

      await expect(can(subject, 'pharmacy:procurement', undefined, { db: authDb })).resolves.toBe(
        false
      );
      await expect(
        caller().setMemberGoodsInAccess({ id: 'member_a', granted: true })
      ).resolves.toEqual({ granted: true });
      await expect(can(subject, 'pharmacy:procurement', undefined, { db: authDb })).resolves.toBe(
        true
      );
      expect(rule.expiresAt).toBeNull();
    }
  );

  it('preserves a denial when removing a grant, keeping administrator procurement access denied', async () => {
    const { can } = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
    let rules = [{ capability: 'pharmacy:procurement', effect: 'DENY' as const }];
    const authDb = {
      user: {
        findUnique: vi.fn(async () => ({
          organizationRole: null,
          permissionOverrides: rules,
        })),
      },
    } as unknown as AuthzDb;
    const subject = { id: 'member_a', role: 'ADMIN', department: null, status: 'ACTIVE' };
    mocks.overrideUpsert.mockImplementationOnce(async ({ update }) => {
      rules = [{ capability: 'pharmacy:procurement', effect: update.effect }];
      return rules[0];
    });

    await expect(can(subject, 'pharmacy:procurement', undefined, { db: authDb })).resolves.toBe(
      false
    );
    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: false })
    ).resolves.toEqual({ granted: false });
    await expect(can(subject, 'pharmacy:procurement', undefined, { db: authDb })).resolves.toBe(
      false
    );
    expect(rules).toEqual([{ capability: 'pharmacy:procurement', effect: 'DENY' }]);
  });

  it.each(['pharmacy:procurement', 'pharmacy:*', '*'])(
    'revokes inherited %s access for receiving and ABAC, then supports regranting',
    async (capability) => {
      const { can } = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
      let overrides: Array<{
        capability: string;
        effect: 'ALLOW' | 'DENY';
        expiresAt: Date | null;
      }> = [];
      const authDb = {
        user: {
          findUnique: vi.fn(async () => ({
            organizationRole: { permissions: [{ capability, effect: 'ALLOW' }] },
            permissionOverrides: overrides.filter(
              (rule) => rule.expiresAt === null || rule.expiresAt > new Date()
            ),
          })),
        },
      } as unknown as ScopedDb;
      const subject = { id: 'member_a', role: 'EMPLOYEE', department: null, status: 'ACTIVE' };
      mocks.overrideUpsert.mockImplementation(async ({ update, create }) => {
        overrides = [{ ...create, ...update }];
        return overrides[0];
      });

      expect(await actorCanProcure(authDb, subject.id)).toBe(true);
      expect(await can(subject, 'pharmacy:procurement', undefined, { db: authDb })).toBe(true);
      await caller().setMemberGoodsInAccess({ id: subject.id, granted: false });
      expect(await actorCanProcure(authDb, subject.id)).toBe(false);
      expect(await can(subject, 'pharmacy:procurement', undefined, { db: authDb })).toBe(false);
      // Removing a previous DENY a second time must not restore inherited access.
      await caller().setMemberGoodsInAccess({ id: subject.id, granted: false });
      expect(await actorCanProcure(authDb, subject.id)).toBe(false);
      await caller().setMemberGoodsInAccess({ id: subject.id, granted: true });
      expect(await actorCanProcure(authDb, subject.id)).toBe(true);
      expect(await can(subject, 'pharmacy:procurement', undefined, { db: authDb })).toBe(true);
    }
  );

  it.each(['pharmacy:procurement', 'pharmacy:*', '*'])(
    'keeps a role %s denial effective for receiving and ABAC after a direct grant',
    async (capability) => {
      const { can } = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
      const overrides: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }> = [];
      const authDb = {
        user: {
          findUnique: vi.fn(async () => ({
            organizationRole: { permissions: [{ capability, effect: 'DENY' }] },
            permissionOverrides: overrides,
          })),
        },
      } as unknown as ScopedDb;
      const subject = { id: 'member_a', role: 'EMPLOYEE', department: null, status: 'ACTIVE' };
      mocks.overrideUpsert.mockImplementationOnce(async ({ create }) => {
        overrides.push(create);
        return create;
      });

      await caller().setMemberGoodsInAccess({ id: subject.id, granted: true });
      expect(overrides).toContainEqual(expect.objectContaining({ effect: 'ALLOW' }));
      expect(await can(subject, 'pharmacy:procurement', undefined, { db: authDb })).toBe(false);
      expect(await actorCanProcure(authDb, subject.id)).toBe(false);
    }
  );

  it.each([true, false])(
    'does not mutate or audit a member outside the current organization when granted is %s',
    async (granted) => {
      mocks.userFindFirst.mockResolvedValue(null);

      await expect(
        caller().setMemberGoodsInAccess({ id: 'member_b', granted })
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Member not found.' });

      expect(mocks.userFindFirst).toHaveBeenCalledWith({
        where: { id: 'member_b', organizationId: 'org_a' },
        select: { id: true, email: true },
      });
      expect(mocks.overrideUpsert).not.toHaveBeenCalled();
      expect(mocks.overrideDeleteMany).not.toHaveBeenCalled();
      expect(mocks.annotateAudit).not.toHaveBeenCalled();
    }
  );

  it('checks the granting administrator procurement permission before granting', async () => {
    mocks.userFindUnique.mockResolvedValue({
      role: 'ADMIN',
      organizationRole: null,
      permissionOverrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }],
    });

    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'admin_a' } })
    );
    expect(mocks.overrideUpsert).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('refuses a grant from an administrator whose role lacks procurement', async () => {
    mocks.userFindUnique.mockResolvedValue({
      role: 'ADMIN',
      organizationRole: { permissions: [{ capability: 'reports:operational', effect: 'ALLOW' }] },
      permissionOverrides: [],
    });

    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.overrideUpsert).not.toHaveBeenCalled();
  });

  it('still lets an administrator without procurement revoke access', async () => {
    mocks.userFindUnique.mockResolvedValue({
      role: 'ADMIN',
      organizationRole: null,
      permissionOverrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }],
    });

    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: false })
    ).resolves.toEqual({ granted: false });
    expect(mocks.overrideUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ effect: 'DENY' }) })
    );
  });

  it.each([true, false])(
    'refuses a branch-scoped administrator changing a member of another branch (granted %s)',
    async (granted) => {
      mocks.branchAssignmentFindMany.mockImplementation(async ({ where }) =>
        where.userId === 'admin_a' ? [{ branchId: 'branch_a' }] : [{ branchId: 'branch_b' }]
      );

      await expect(
        caller().setMemberGoodsInAccess({ id: 'member_a', granted })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Member is outside your branch scope.',
      });

      expect(mocks.branchAssignmentFindMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_a',
          userId: 'admin_a',
          active: true,
          branch: { active: true },
        },
        select: { branchId: true },
      });
      expect(mocks.branchAssignmentFindMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_a',
          userId: 'member_a',
          active: true,
          branch: { active: true },
        },
        select: { branchId: true },
      });
      expect(mocks.overrideUpsert).not.toHaveBeenCalled();
      expect(mocks.annotateAudit).not.toHaveBeenCalled();
    }
  );

  it('refuses a branch-scoped administrator changing an unassigned member', async () => {
    mocks.branchAssignmentFindMany.mockImplementation(async ({ where }) =>
      where.userId === 'admin_a' ? [{ branchId: 'branch_a' }] : []
    );

    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.overrideUpsert).not.toHaveBeenCalled();
  });

  it('lets a branch-scoped administrator grant a member of a shared branch and audits who granted whom', async () => {
    mocks.branchAssignmentFindMany.mockImplementation(async ({ where }) =>
      where.userId === 'admin_a'
        ? [{ branchId: 'branch_a' }, { branchId: 'branch_c' }]
        : [{ branchId: 'branch_a' }, { branchId: 'branch_b' }]
    );

    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: true })
    ).resolves.toEqual({ granted: true });

    expect(mocks.overrideUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: 'member_a', createdById: 'admin_a' }),
      })
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      targetType: 'User',
      targetId: 'member_a',
      targetLabel: 'member@example.test',
      description: 'Granted Goods-in access for member@example.test',
      metadata: {
        capability: 'pharmacy:procurement',
        granted: true,
        grantedByUserId: 'admin_a',
        targetUserId: 'member_a',
        branchScope: ['branch_a'],
      },
    });
  });
});
