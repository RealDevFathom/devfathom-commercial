/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates model only the operations exercised by these boundary tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const rules: Record<string, { role: Rule[] | null; overrides: Rule[] }> = {};
const db: any = {
  user: {
    // The ABAC engine's rule lookup, for the caller and for the member read.
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const entry = rules[where.id];
      if (!entry) return null;
      return {
        organizationRole: entry.role ? { permissions: entry.role } : null,
        permissionOverrides: entry.overrides,
      };
    }),
    findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) =>
      where.id === 'cashier_a' && where.organizationId === 'org_a'
        ? {
            id: 'cashier_a',
            name: 'Ayesha',
            role: 'EMPLOYEE',
            department: 'COUNTER',
            status: 'ACTIVE',
            organizationRole: { name: 'Cashier', isSystem: true },
            permissionOverrides: [],
          }
        : null
    ),
    update: vi.fn(),
  },
  organizationRole: { update: vi.fn(), create: vi.fn() },
  organizationRolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
  userPermissionOverride: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
};

function caller(vertical: string, role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50, vertical },
    session: {
      expires: 'later',
      user: {
        id: role === 'ADMIN' ? 'admin_a' : 'cashier_a',
        organizationId: 'org_a',
        role,
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

beforeEach(() => {
  vi.clearAllMocks();
  rules.admin_a = { role: null, overrides: [] };
  rules.cashier_a = {
    role: [
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
      { capability: 'pharmacy:orders', effect: 'ALLOW' },
      { capability: 'sop:complete', effect: 'ALLOW' },
    ],
    overrides: [],
  };
});

function ticked(result: Awaited<ReturnType<ReturnType<typeof caller>['memberAccess']>>) {
  return result.groups
    .flatMap((group) => group.subRoles)
    .filter((subRole) => subRole.state === 'on')
    .map((subRole) => subRole.key)
    .sort();
}

describe('organizationAdmin.memberAccess', () => {
  it('reads a pharmacy member’s effective sub-roles for an administrator, changing nothing', async () => {
    const result = await caller('PHARMACY').memberAccess({ userId: 'cashier_a' });
    expect(ticked(result)).toEqual(['customer-orders', 'do-procedures', 'take-payment']);
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cashier_a', organizationId: 'org_a' } })
    );
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.organizationRolePermission.createMany).not.toHaveBeenCalled();
    expect(db.userPermissionOverride.create).not.toHaveBeenCalled();
  });

  it('follows the member-management permission: a non-administrator is refused', async () => {
    await expect(
      caller('PHARMACY', 'EMPLOYEE').memberAccess({ userId: 'cashier_a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an administrator whose admin access is denied by an exception', async () => {
    rules.admin_a = { role: null, overrides: [{ capability: 'admin:access', effect: 'DENY' }] };
    await expect(caller('PHARMACY').memberAccess({ userId: 'cashier_a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not read a member of another organization', async () => {
    await expect(caller('PHARMACY').memberAccess({ userId: 'someone_b' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('is offered to pharmacies only until the other business types get their sub-roles', async () => {
    await expect(caller('AGENCY').memberAccess({ userId: 'cashier_a' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});
