import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
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
import { organizationAdminRouter } from './organization-admin';

const db = {
  user: { findFirst: mocks.userFindFirst },
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
    mocks.userFindFirst.mockResolvedValue({ id: 'member_a', email: 'member@example.test' });
  });

  it('removes the canonical procurement grant and reports the audited state', async () => {
    await expect(
      caller().setMemberGoodsInAccess({ id: 'member_a', granted: false })
    ).resolves.toEqual({ granted: false });

    expect(mocks.overrideDeleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        userId: 'member_a',
        capability: 'pharmacy:procurement',
        effect: 'ALLOW',
      },
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetId: 'member_a',
        description: 'Removed Goods-in access',
        metadata: { capability: 'pharmacy:procurement', granted: false },
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
        description: 'Granted Goods-in access',
        metadata: { capability: 'pharmacy:procurement', granted: true },
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
    mocks.overrideDeleteMany.mockImplementationOnce(async ({ where }) => {
      const before = rules.length;
      rules = rules.filter(
        (rule) =>
          rule.capability !== where.capability || (where.effect && rule.effect !== where.effect)
      );
      return { count: before - rules.length };
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
});
