import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const db = {
  user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  organizationDepartment: { findFirst: vi.fn() },
  organizationRole: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  organizationRolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
};

function caller() {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId: 'org_a',
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

const roleInput = {
  key: 'restricted-admin',
  name: 'Restricted admin',
  description: null,
  permissions: [],
};
const memberInput = {
  id: 'member_b',
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
  organizationRoleId: null,
  title: 'Manager',
  department: 'LEADERSHIP',
};
const mutations = [
  {
    name: 'grant a base role',
    run: () => caller().updateMember(memberInput),
  },
  {
    name: 'revoke a base role',
    run: () => caller().updateMember({ ...memberInput, role: 'EMPLOYEE' }),
  },
  {
    name: 'replace a custom role',
    run: () => caller().updateMember({ ...memberInput, organizationRoleId: 'role_other' }),
  },
  {
    name: 'remove a custom role',
    run: () => caller().updateMember({ ...memberInput, id: 'admin_a' }),
  },
  {
    name: 'create an admin',
    run: () =>
      caller().createMember({
        name: 'New admin',
        email: 'admin@example.test',
        password: 'Temporary-123456',
        title: 'Manager',
        role: 'ADMIN',
        department: 'LEADERSHIP',
      }),
  },
  {
    name: 'remove the DENY from the caller’s role',
    run: () => caller().upsertRole({ ...roleInput, id: 'role_restricted' }),
  },
  {
    name: 'create a role template',
    run: () => caller().upsertRole(roleInput),
  },
  {
    name: 'delete a role template',
    run: () => caller().removeRole({ id: 'role_restricted' }),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue({ organizationRole: null, permissionOverrides: [] });
  db.organizationRole.findFirst.mockResolvedValue({
    id: 'role_restricted',
    name: 'Restricted admin',
    isSystem: false,
    _count: { users: 0 },
  });
  db.organizationRole.create.mockResolvedValue({ id: 'role_new', name: 'Restricted admin' });
  db.organizationRole.update.mockResolvedValue({
    id: 'role_restricted',
    name: 'Restricted admin',
  });
});

describe('organization role authorization with the real ABAC engine', () => {
  describe.each(['override', 'custom role'] as const)('DENY from %s', (source) => {
    it.each(mutations)('refuses to $name before reading or writing target data', async ({ run }) => {
      const deny = { capability: 'team:setRole', effect: 'DENY' };
      db.user.findUnique.mockResolvedValue({
        organizationRole: {
          permissions: [
            { capability: '*', effect: 'ALLOW' },
            ...(source === 'custom role' ? [deny] : []),
          ],
        },
        permissionOverrides: source === 'override' ? [deny] : [],
      });

      await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // admin:access succeeds; the independent team:setRole decision denies.
      expect(db.user.findUnique).toHaveBeenCalledTimes(2);
      expect(db.user.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: 'admin_a' } })
      );
      expect(db.user.findFirst).not.toHaveBeenCalled();
      expect(db.organizationDepartment.findFirst).not.toHaveBeenCalled();
      expect(db.organizationRole.findFirst).not.toHaveBeenCalled();
      expect(db.user.create).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.organizationRole.create).not.toHaveBeenCalled();
      expect(db.organizationRole.update).not.toHaveBeenCalled();
      expect(db.organizationRole.delete).not.toHaveBeenCalled();
      expect(db.organizationRolePermission.deleteMany).not.toHaveBeenCalled();
      expect(db.organizationRolePermission.createMany).not.toHaveBeenCalled();
    });
  });

  it('keeps admin:access required even when team:setRole is allowed', async () => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [
        { capability: 'admin:access', effect: 'DENY' },
        { capability: 'team:setRole', effect: 'ALLOW' },
      ],
    });

    await expect(caller().upsertRole(roleInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.organizationRole.create).not.toHaveBeenCalled();
  });

  it('fails closed if the caller disappears during the role capability lookup', async () => {
    db.user.findUnique
      .mockResolvedValueOnce({ organizationRole: null, permissionOverrides: [] })
      .mockResolvedValueOnce(null);

    await expect(caller().upsertRole(roleInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.organizationRole.create).not.toHaveBeenCalled();
  });

  it('allows an unrestricted admin to create and edit role permissions', async () => {
    await caller().upsertRole(roleInput);
    const permissions = [{ capability: 'team:view', effect: 'ALLOW' as const }];
    await caller().upsertRole({ ...roleInput, id: 'role_restricted', permissions });

    expect(db.organizationRole.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        key: roleInput.key,
        name: roleInput.name,
        description: null,
      },
    });
    expect(db.organizationRolePermission.createMany).toHaveBeenCalledWith({
      data: [{ organizationId: 'org_a', organizationRoleId: 'role_restricted', ...permissions[0] }],
    });
  });

  it('allows an unrestricted admin to remove an unused custom role', async () => {
    await expect(caller().removeRole({ id: 'role_restricted' })).resolves.toEqual({ success: true });
    expect(db.organizationRole.delete).toHaveBeenCalledWith({ where: { id: 'role_restricted' } });
  });

  it('preserves the system-role and in-use-role guards', async () => {
    db.organizationRole.findFirst.mockResolvedValue({ id: 'role_system', isSystem: true });
    await expect(caller().upsertRole({ ...roleInput, id: 'role_system' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().removeRole({ id: 'role_system' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    db.organizationRole.findFirst.mockResolvedValue({
      id: 'role_restricted',
      isSystem: false,
      _count: { users: 1 },
    });
    await expect(caller().removeRole({ id: 'role_restricted' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(db.organizationRole.update).not.toHaveBeenCalled();
    expect(db.organizationRole.delete).not.toHaveBeenCalled();
  });
});
