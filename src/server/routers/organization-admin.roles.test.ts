import { createHash } from 'node:crypto';
import { hash } from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed') }));
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
  organizationScimToken: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(db)),
};

function caller(enabledModules = ['identity']) {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules, activeSeats: 1, seatLimit: 10 },
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
// The editor omits an unchanged base role; every member edit is still gated.
const profileOnlyInput = {
  id: memberInput.id,
  status: memberInput.status,
  organizationRoleId: memberInput.organizationRoleId,
  title: memberInput.title,
  department: memberInput.department,
};
// Synthetic policy-valid input; never used as a credential outside these mocks.
const testPassword = 'Aa1'.repeat(4);
const scimInput = { name: 'Test directory', expiresAt: null };
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
    name: 'edit a member profile without sending a role',
    run: () => caller().updateMember({ ...profileOnlyInput, title: 'Senior manager' }),
  },
  {
    name: 'create an admin',
    run: () =>
      caller().createMember({
        name: 'New admin',
        email: 'admin@example.test',
        password: testPassword,
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
  {
    name: 'reset another member’s password to assume their permissions',
    run: () => caller().resetMemberPassword({ id: 'member_b', password: testPassword }),
  },
  {
    name: 'create a SCIM token that can assign roles',
    run: () => caller().createScimToken(scimInput),
  },
  {
    name: 'revoke a SCIM provisioning token',
    run: () => caller().revokeScimToken({ id: 'scim_token' }),
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
    it.each(mutations)(
      'refuses to $name before reading or writing target data',
      async ({ run }) => {
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
        expect(db.organizationScimToken.findFirst).not.toHaveBeenCalled();
        expect(db.organizationScimToken.create).not.toHaveBeenCalled();
        expect(db.organizationScimToken.update).not.toHaveBeenCalled();
        expect(hash).not.toHaveBeenCalled();
      }
    );
  });

  it.each(mutations)('keeps admin:access required to $name', async ({ run }) => {
    db.user.findUnique.mockResolvedValue({
      organizationRole: null,
      permissionOverrides: [
        { capability: 'admin:access', effect: 'DENY' },
        { capability: 'team:setRole', effect: 'ALLOW' },
      ],
    });

    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.organizationRole.findFirst).not.toHaveBeenCalled();
    expect(db.organizationRole.create).not.toHaveBeenCalled();
    expect(db.organizationScimToken.findFirst).not.toHaveBeenCalled();
    expect(db.organizationScimToken.create).not.toHaveBeenCalled();
  });

  it.each(mutations)(
    'fails closed if the caller disappears while authorizing $name',
    async ({ run }) => {
      db.user.findUnique
        .mockResolvedValueOnce({ organizationRole: null, permissionOverrides: [] })
        .mockResolvedValueOnce(null);

      await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.user.findFirst).not.toHaveBeenCalled();
      expect(db.organizationRole.findFirst).not.toHaveBeenCalled();
      expect(db.organizationRole.create).not.toHaveBeenCalled();
      expect(db.organizationScimToken.findFirst).not.toHaveBeenCalled();
      expect(db.organizationScimToken.create).not.toHaveBeenCalled();
    }
  );

  it('allows an unrestricted admin to reset a password and revoke existing sessions', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'member_b', email: 'member@example.test' });

    await expect(
      caller().resetMemberPassword({ id: 'member_b', password: testPassword })
    ).resolves.toEqual({ success: true });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'member_b', organizationId: 'org_a' },
      select: { id: true, email: true },
    });
    expect(hash).toHaveBeenCalledWith(testPassword, 12);
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'member_b' },
      data: {
        password: 'hashed',
        passwordChangedAt: null,
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
    });
  });

  it('keeps the stored base role when an unrestricted admin omits it', async () => {
    db.user.findFirst.mockResolvedValue({
      id: 'member_b',
      status: 'ACTIVE',
      role: 'HR',
      email: 'member@example.test',
    });
    db.organizationDepartment.findFirst.mockResolvedValue({ id: 'dept_leadership' });
    db.user.update.mockResolvedValue({ id: 'member_b', email: 'member@example.test' });

    await caller().updateMember({ ...profileOnlyInput, title: 'Senior manager' });

    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'member_b' },
      data: {
        role: 'HR',
        status: 'ACTIVE',
        organizationRoleId: null,
        title: 'Senior manager',
        department: 'LEADERSHIP',
        tokenVersion: undefined,
      },
    });
  });

  it('allows an unrestricted admin to create a tenant-scoped SCIM credential', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00Z');
    db.organizationScimToken.create.mockImplementation(async ({ data }) => ({
      id: 'scim_token',
      ...data,
    }));

    const saved = await caller().createScimToken({ ...scimInput, expiresAt });

    expect(saved.token).toMatch(/^scim_/);
    expect(db.organizationScimToken.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_a',
        name: scimInput.name,
        prefix: saved.token.slice(0, 16),
        tokenHash: createHash('sha256').update(saved.token).digest('hex'),
        expiresAt,
      },
    });
    expect(saved.tokenHash).toBeUndefined();
  });

  it('retains the identity license gate for SCIM token creation', async () => {
    await expect(caller([]).createScimToken(scimInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The identity module is not licensed.',
    });
    expect(db.organizationScimToken.create).not.toHaveBeenCalled();
  });

  it('allows an unrestricted admin to revoke a token in the caller’s tenant', async () => {
    db.organizationScimToken.findFirst.mockResolvedValue({ id: 'scim_token' });
    db.organizationScimToken.update.mockResolvedValue({ id: 'scim_token', revokedAt: new Date() });

    await caller().revokeScimToken({ id: 'scim_token' });

    expect(db.organizationScimToken.findFirst).toHaveBeenCalledWith({
      where: { id: 'scim_token', organizationId: 'org_a' },
    });
    expect(db.organizationScimToken.update).toHaveBeenCalledWith({
      where: { id: 'scim_token' },
      data: { revokedAt: expect.any(Date) },
    });
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
    await expect(caller().removeRole({ id: 'role_restricted' })).resolves.toEqual({
      success: true,
    });
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
