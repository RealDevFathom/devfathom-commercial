/**
 * M2-L2 router — capability gating, credential-secret audit suppression (C4),
 * and domain-error → tRPC status mapping. Runs the REAL router and the REAL L1
 * hashing/lifecycle core against a hand-rolled in-memory db (no PostgreSQL); the
 * ABAC decision, entitlement check and audit writer are mocked so the test
 * exercises this lane's logic, not the platform middleware.
 */
import { hashSync } from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  resolveStaffCapabilities: vi.fn(),
  annotateAudit: vi.fn(),
  // db delegate methods
  staffFindMany: vi.fn(),
  staffFindFirst: vi.fn(),
  staffFindUnique: vi.fn(),
  staffCreate: vi.fn(),
  staffUpdate: vi.fn(),
  staffCount: vi.fn(),
  raw: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindUnique: vi.fn(),
  deviceFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  credFindMany: vi.fn(),
  credFindFirst: vi.fn(),
  credFindUnique: vi.fn(),
  credCreate: vi.fn(),
  credUpdate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/job-roles', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/job-roles')>(
    '@/lib/restaurant/job-roles'
  )),
  resolveStaffCapabilities: mocks.resolveStaffCapabilities,
}));

import { restaurantStaffRouter } from './restaurant-staff';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { TRPCContext } from '../trpc';

const password = 'synthetic-manager-password';
const passwordHash = hashSync(password, 4);
const db = {
  notification: { create: vi.fn() },
  $queryRaw: mocks.raw,
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  restaurantStaffProfile: {
    findMany: mocks.staffFindMany,
    findFirst: mocks.staffFindFirst,
    findUnique: mocks.staffFindUnique,
    create: mocks.staffCreate,
    update: mocks.staffUpdate,
    count: mocks.staffCount,
  },
  restaurantBranch: { findMany: mocks.branchFindMany, findUnique: mocks.branchFindUnique },
  restaurantRegisteredDevice: { findUnique: mocks.deviceFindUnique },
  user: {
    findMany: mocks.userFindMany,
    findFirst: mocks.userFindFirst,
    findUnique: mocks.userFindUnique,
  },
  restaurantOperatorCredential: {
    findMany: mocks.credFindMany,
    findFirst: mocks.credFindFirst,
    findUnique: mocks.credFindUnique,
    create: mocks.credCreate,
    update: mocks.credUpdate,
  },
};

function staffParty(
  id: string,
  role: 'ADMIN' | 'HR' | 'EMPLOYEE',
  organizationRole: { key: string; isSystem: boolean; permissions: unknown[] } | null = null
) {
  return { id, role, status: 'ACTIVE', organizationRole, permissionOverrides: [] };
}

function caller(enabledModules = ['restaurant-core']) {
  return restaurantStaffRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_workspace',
      enabledModules,
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'restaurant.operators.max': 50 },
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_gm',
        organizationId: 'org_workspace',
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_workspace' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.resolveStaffCapabilities.mockResolvedValue(new Set(['staff:manage']));
  mocks.staffFindMany.mockResolvedValue([]);
  mocks.staffCount.mockResolvedValue(0);
  mocks.raw.mockImplementation(async (sql: TemplateStringsArray) =>
    Array.isArray(sql) && sql.join('').includes('FROM restaurant_staff_profiles')
      ? [await mocks.staffFindUnique()]
      : [{ id: 'org_1' }]
  );
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindMany.mockImplementation(async (args?: { where?: { id?: { in?: string[] } } }) => {
    const ids = args?.where?.id?.in;
    if (!ids) return [{ id: 'branch_1' }];
    return ids.map((id) => ({ id }));
  });
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.deviceFindUnique.mockResolvedValue({ branchId: 'branch_1' });
  mocks.userFindFirst.mockResolvedValue({ id: 'user_1' });
  // DEV-974: live hierarchy parties. The manager and linked staff are ordinary members.
  mocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    staffParty(where.id, 'EMPLOYEE')
  );
  mocks.userFindMany.mockResolvedValue([]);
  mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE', userId: null });
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    ...data,
  }));
  mocks.staffUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      displayName: 'Existing',
      ...data,
    })
  );
  mocks.credFindFirst.mockResolvedValue(null);
  mocks.credCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'cred_new',
    createdAt: new Date('2026-08-18T12:00:00Z'),
    ...data,
  }));
  mocks.credFindUnique.mockResolvedValue({
    id: 'cred_1',
    staffProfileId: 'staff_1',
    deviceId: 'device_1',
    device: { branchId: 'branch_1' },
    type: 'PIN',
    revokedAt: null,
  });
  mocks.credUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      type: 'PIN',
      updatedAt: new Date('2026-08-18T12:30:00Z'),
      ...data,
    })
  );
});

describe('capability gating', () => {
  it('rejects every procedure when the ABAC decision denies staff:manage', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().create({ displayName: 'Blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });
});

describe('staff CRUD', () => {
  it('organization-scopes both staff-dialog directories', async () => {
    await caller().listBranches();
    expect(mocks.branchFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_workspace', id: { in: ['branch_1'] } },
      })
    );

    await caller().listEligibleUsers();
    expect(mocks.staffFindMany).toHaveBeenLastCalledWith({
      where: { userId: 'user_gm', status: 'ACTIVE' },
      select: {
        id: true,
        primaryBranchId: true,
        jobRoles: { select: { branchId: true } },
        directCapabilityGrants: { select: { branchId: true } },
      },
      orderBy: { id: 'asc' },
      take: 2,
    });
    expect(mocks.branchFindMany).toHaveBeenLastCalledWith({
      where: { organizationId: 'org_workspace', active: true },
      select: { id: true },
    });
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_workspace' },
        select: expect.objectContaining({
          restaurantStaffProfiles: {
            select: { id: true, displayName: true },
            orderBy: { id: 'asc' },
            take: 1,
          },
        }),
      })
    );
  });

  it('limits users and multi-profile results to all eligible manager linkage paths', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValue(false);
    mocks.staffFindMany.mockResolvedValueOnce([
      {
        id: 'staff_manager',
        primaryBranchId: 'branch_1',
        jobRoles: [{ branchId: 'branch_1' }],
        directCapabilityGrants: [{ branchId: 'branch_2' }],
      },
    ]);

    await caller().listEligibleUsers();

    const eligibleProfileWhere = {
      organizationId: 'org_workspace',
      OR: [
        { primaryBranchId: { in: ['branch_1', 'branch_2'] } },
        { jobRoles: { some: { branchId: { in: ['branch_1', 'branch_2'] } } } },
        { directCapabilityGrants: { some: { branchId: { in: ['branch_1', 'branch_2'] } } } },
      ],
    };
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_workspace',
          restaurantStaffProfiles: { some: eligibleProfileWhere },
        },
        select: expect.objectContaining({
          restaurantStaffProfiles: expect.objectContaining({
            where: eligibleProfileWhere,
            orderBy: { id: 'asc' },
            take: 1,
          }),
        }),
      })
    );
  });

  it('does not query users when a manager has no active authorized branch', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValue(false);
    mocks.staffFindMany.mockResolvedValueOnce([
      {
        id: 'staff_manager',
        primaryBranchId: 'branch_1',
        jobRoles: [{ branchId: 'branch_1' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.branchFindMany.mockResolvedValueOnce([]);

    await expect(caller().listEligibleUsers()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it('does not expose users linked only to an inactive authorized branch', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValue(false);
    mocks.staffFindMany.mockResolvedValueOnce([
      {
        id: 'staff_manager',
        primaryBranchId: 'branch_inactive',
        jobRoles: [{ branchId: 'branch_inactive' }, { branchId: 'branch_active' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.branchFindMany.mockResolvedValueOnce([{ id: 'branch_active' }]);

    await caller().listEligibleUsers();

    expect(mocks.branchFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_workspace',
        active: true,
        id: { in: ['branch_inactive', 'branch_active'] },
      },
      select: { id: true },
    });
    const eligibleProfileWhere = {
      organizationId: 'org_workspace',
      OR: [
        { primaryBranchId: { in: ['branch_active'] } },
        { jobRoles: { some: { branchId: { in: ['branch_active'] } } } },
        { directCapabilityGrants: { some: { branchId: { in: ['branch_active'] } } } },
      ],
    };
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_workspace',
          restaurantStaffProfiles: { some: eligibleProfileWhere },
        },
        select: expect.objectContaining({
          restaurantStaffProfiles: expect.objectContaining({ where: eligibleProfileWhere }),
        }),
      })
    );
  });

  it('creates a staff profile and audits it', async () => {
    const result = await caller().create({ displayName: 'Dana', email: 'Dana@R.com' });
    expect(result).toMatchObject({ id: 'staff_new', email: 'dana@r.com' });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'RestaurantStaffProfile', targetId: 'staff_new' })
    );
  });

  it('maps a duplicate email to CONFLICT', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_existing' });
    await expect(
      caller().create({ displayName: 'Dupe', email: 'taken@r.com' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not reveal whether an unauthorized primary branch exists', async () => {
    mocks.branchFindUnique.mockResolvedValue(null);
    await expect(
      caller().create({ displayName: 'x', primaryBranchId: 'branch_gone' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not reveal whether an unauthorized profile exists', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    await expect(caller().update({ id: 'gone', displayName: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('sets a profile status', async () => {
    const result = await caller().setStatus({ id: 'staff_1', status: 'SUSPENDED' });
    expect(result).toMatchObject({ status: 'SUSPENDED' });
  });
});

describe('branch-authorized account enrollment by exact email', () => {
  beforeEach(() => {
    mocks.can.mockImplementation(async (...args) => args[1] === 'staff:manage');
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'staff_manager',
        primaryBranchId: 'branch_1',
        jobRoles: [{ branchId: 'branch_1' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.staffFindUnique.mockResolvedValue({
      id: 'staff_1',
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
    });
  });

  it('creates and links an unlisted account without disclosing the user directory', async () => {
    const result = await caller().create({
      displayName: 'Dana',
      primaryBranchId: 'branch_1',
      userEmail: ' Dana@R.com ',
    });

    expect(result).toMatchObject({ userId: 'user_1', primaryBranchId: 'branch_1' });
    expect(result).not.toHaveProperty('userEmail');
    expect(mocks.userFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: 'org_workspace',
        email: 'dana@r.com',
        status: 'ACTIVE',
        restaurantStaffProfiles: { none: {} },
      },
      select: { id: true },
    });
    // The existing lifecycle path must still validate account availability.
    expect(mocks.userFindFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'user_1', status: 'ACTIVE', restaurantStaffProfiles: { none: {} } },
      select: { id: true },
    });
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it('links an existing authorized profile while preserving lifecycle validation', async () => {
    await caller().update({ id: 'staff_1', userEmail: 'dana@r.com' });

    expect(mocks.userFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: 'org_workspace',
        email: 'dana@r.com',
        status: 'ACTIVE',
        restaurantStaffProfiles: { every: { id: 'staff_1' } },
      },
      select: { id: true },
    });
    expect(mocks.staffUpdate).toHaveBeenCalledWith({
      where: { id: 'staff_1' },
      data: { userId: 'user_1' },
    });
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)(
    'rejects an unavailable account on %s',
    async (operation) => {
      mocks.userFindFirst.mockResolvedValueOnce(null);
      const call =
        operation === 'create'
          ? caller().create({
              displayName: 'Dana',
              primaryBranchId: 'branch_1',
              userEmail: 'missing@r.com',
            })
          : caller().update({ id: 'staff_1', userEmail: 'missing@r.com' });
      await expect(call).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'The selected organization user is unavailable.',
      });
      expect(mocks.staffCreate).not.toHaveBeenCalled();
      expect(mocks.staffUpdate).not.toHaveBeenCalled();
    }
  );

  it.each(['create', 'update'] as const)(
    'authorizes the branch before resolving an account on %s',
    async (operation) => {
      mocks.staffFindUnique.mockResolvedValue({
        primaryBranchId: 'branch_other',
        jobRoles: [],
        directCapabilityGrants: [],
      });
      const call =
        operation === 'create'
          ? caller().create({
              displayName: 'Dana',
              primaryBranchId: 'branch_other',
              userEmail: 'dana@r.com',
            })
          : caller().update({ id: 'staff_other', userEmail: 'dana@r.com' });
      await expect(call).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
      expect(mocks.staffCreate).not.toHaveBeenCalled();
      expect(mocks.staffUpdate).not.toHaveBeenCalled();
    }
  );

  it.each(['create', 'update'] as const)(
    'rejects conflicting account selectors on %s',
    async (operation) => {
      const selectors = { userId: 'user_1', userEmail: 'other@r.com' };
      const call =
        operation === 'create'
          ? caller().create({ displayName: 'Dana', primaryBranchId: 'branch_1', ...selectors })
          : caller().update({ id: 'staff_1', ...selectors });
      await expect(call).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
    }
  );
});

describe('DEV-974: a manager never sets the PIN of an administrator or the owner', () => {
  const owner = staffParty('user_owner', 'ADMIN', {
    key: 'owner',
    isSystem: true,
    permissions: [{ capability: '*', effect: 'ALLOW' }],
  });
  beforeEach(() => {
    mocks.userFindFirst.mockImplementation(async ({ where, select }) =>
      select.password
        ? { password: passwordHash }
        : select.phone
          ? { phone: null }
          : mocks.userFindUnique({ where })
    );
    mocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'user_owner'
        ? owner
        : where.id === 'user_admin'
          ? staffParty('user_admin', 'ADMIN')
          : staffParty(where.id, 'EMPLOYEE')
    );
  });

  it.each(['user_owner', 'user_admin'])(
    'refuses issuing and rotating on a profile linked to %s',
    async (userId) => {
      mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE', userId });
      mocks.credFindUnique.mockResolvedValue({
        id: 'cred_1',
        type: 'PIN',
        revokedAt: null,
        staffProfileId: 'staff_1',
        deviceId: 'device_1',
        device: { branchId: 'branch_1' },
      });
      await expect(
        caller().issueCredential({
          staffProfileId: 'staff_1',
          type: 'PIN',
          secret: '4821',
          deviceId: 'device_1',
          confirmPin: '4821',
          currentPassword: password,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller().rotateCredential({
          credentialId: 'cred_1',
          secret: '99887',
          confirmPin: '99887',
          currentPassword: password,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.credCreate).not.toHaveBeenCalled();
      expect(mocks.credUpdate).not.toHaveBeenCalled();
    }
  );

  it('refuses linking a profile to the owner account', async () => {
    mocks.userFindFirst.mockResolvedValue({ id: 'user_owner' });
    await expect(
      caller().update({ id: 'staff_1', userEmail: 'owner@r.com' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller().create({ displayName: 'Owner', primaryBranchId: 'branch_1', userId: 'user_owner' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.staffUpdate).not.toHaveBeenCalled();
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('still sets the PIN of a staff member below the manager', async () => {
    mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE', userId: 'user_1' });
    await expect(
      caller().issueCredential({
        staffProfileId: 'staff_1',
        type: 'PIN',
        secret: '4821',
        deviceId: 'device_1',
        confirmPin: '4821',
        currentPassword: password,
      })
    ).resolves.toMatchObject({ type: 'PIN' });
  });
});

describe('shared pharmacy approval PINs', () => {
  it.each([null, 'another-member'])(
    'self-only revocation rechecks the locked profile link (%s)',
    async (userId) => {
      mocks.credFindFirst.mockResolvedValueOnce({
        staffProfileId: 'staff_1',
        type: 'BADGE',
        deviceId: null,
      });
      mocks.raw.mockResolvedValueOnce([{ userId, status: 'ACTIVE' }]);
      await expect(
        caller().revokeMyTerminalCredential({ credentialId: 'cred_1', currentPassword: password })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You are not authorized to administer staff for this branch.',
      });
      expect(mocks.credFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ staffProfile: { userId: 'user_gm' } }),
        })
      );
      expect(mocks.raw).toHaveBeenCalledOnce();
      expect(mocks.credUpdate).not.toHaveBeenCalled();
      expect(db.notification.create).not.toHaveBeenCalled();
    }
  );

  it.each(['restaurant-core', 'pharmacy-core', 'pharmacy-counter'])(
    'directs issue, rotation and revocation to the password-protected PIN procedures with %s',
    async (pharmacyModule) => {
      const mixed = caller(['restaurant-core', pharmacyModule]);
      mocks.raw.mockResolvedValue([{ userId: 'user_1', status: 'ACTIVE' }]);
      mocks.staffFindUnique.mockResolvedValue({
        id: 'staff_1',
        status: 'ACTIVE',
        userId: 'user_1',
      });
      mocks.credFindUnique.mockResolvedValue({
        id: 'cred_1',
        staffProfileId: 'staff_1',
        type: 'PIN',
        deviceId: null,
        revokedAt: null,
      });
      // The test double cannot persist a credential, even if a guard is missing.
      const unexpectedWrite = new Error('Unexpected credential write');
      mocks.credCreate.mockRejectedValue(unexpectedWrite);
      mocks.credUpdate.mockRejectedValue(unexpectedWrite);
      await expect(
        mixed.issueCredential({
          staffProfileId: 'staff_1',
          type: 'PIN',
          secret: '4821',
          currentPassword: password,
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the member can set their approval PIN. Use Settings, Your PIN to reset it.',
      });
      await expect(
        mixed.rotateCredential({
          credentialId: 'cred_1',
          secret: '4821',
          currentPassword: password,
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the member can set their approval PIN. Use Settings, Your PIN to reset it.',
      });
      await expect(
        mixed.revokeCredential({ credentialId: 'cred_1', currentPassword: password })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Manage this approval PIN in Settings under Your PIN.',
      });
      expect(mocks.credCreate).not.toHaveBeenCalled();
      expect(mocks.credUpdate).not.toHaveBeenCalled();
    }
  );

  it('refuses to move an active approval PIN to a different account', async () => {
    mocks.raw.mockResolvedValue([{ userId: 'user_1' }]);
    mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', userId: 'user_1' });
    mocks.credFindFirst.mockResolvedValue({ id: 'cred_1' });
    mocks.staffUpdate.mockRejectedValue(new Error('Unexpected profile write'));
    await expect(
      caller(['restaurant-core', 'pharmacy-core']).update({ id: 'staff_1', userId: 'user_2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.staffUpdate).not.toHaveBeenCalled();
  });
});

describe('credential mutations suppress the plaintext secret (C4)', () => {
  it('issues a credential, skips audit input, and never returns a hash', async () => {
    const result = await caller().issueCredential({
      staffProfileId: 'staff_1',
      type: 'PIN',
      secret: '4821',
    });

    // The very first audit annotation sets skipInput, protecting the failure path too.
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    // The stored hash is a real, verifiable bcrypt hash — never the plaintext.
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      metadata: { staffProfileId: 'staff_1', forUserId: null, byUserId: 'user_gm' },
    });
    const stored = mocks.credCreate.mock.calls[0][0].data.credentialHash;
    expect(stored).not.toBe('4821');
    expect(await verifyOperatorCredential('PIN', '4821', stored)).toBe(true);
    // The response exposes no secret and no hash.
    expect(result).not.toHaveProperty('credentialHash');
    expect(result).not.toHaveProperty('secret');
    expect(result).toMatchObject({ id: 'cred_new', type: 'PIN' });
  });

  it('maps a weak PIN (L1 policy floor) to BAD_REQUEST and still skips input', async () => {
    await expect(
      caller().issueCredential({ staffProfileId: 'staff_1', type: 'PIN', secret: '12' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    expect(mocks.credCreate).not.toHaveBeenCalled();
  });

  it('maps issuing over an existing active credential to CONFLICT', async () => {
    mocks.credFindFirst.mockResolvedValue({ id: 'cred_existing' });
    await expect(
      caller().issueCredential({ staffProfileId: 'staff_1', type: 'PIN', secret: '4821' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rotates a credential with skipInput and no hash in the response', async () => {
    const result = await caller().rotateCredential({ credentialId: 'cred_1', secret: '99887' });
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    const stored = mocks.credUpdate.mock.calls[0][0].data.credentialHash;
    expect(await verifyOperatorCredential('PIN', '99887', stored)).toBe(true);
    expect(result).not.toHaveProperty('credentialHash');
  });

  it('maps rotating a revoked credential to CONFLICT', async () => {
    mocks.credFindUnique.mockResolvedValue({
      id: 'cred_1',
      type: 'PIN',
      revokedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await expect(
      caller().rotateCredential({ credentialId: 'cred_1', secret: '99887' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('revokes a credential immediately with skipInput', async () => {
    const result = await caller().revokeCredential({ credentialId: 'cred_1' });
    expect(mocks.annotateAudit.mock.calls[0][1]).toEqual({ skipInput: true });
    expect(mocks.credUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
    expect(result.revokedAt).toBeInstanceOf(Date);
  });
});

describe('credential device branch authorization', () => {
  function branchManager(...authorizedBranchIds: string[]) {
    mocks.can.mockImplementation(async (...args) => args[1] === 'staff:manage');
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'manager',
        primaryBranchId: authorizedBranchIds[0] ?? null,
        jobRoles: authorizedBranchIds.map((branchId) => ({ branchId })),
        directCapabilityGrants: [],
      },
    ]);
    mocks.staffFindUnique.mockResolvedValue({
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
    });
  }

  it('denies issue, rotate, and revoke against an unauthorized device branch', async () => {
    branchManager('branch_1');
    mocks.deviceFindUnique.mockResolvedValue({ branchId: 'branch_2' });
    mocks.credFindUnique.mockResolvedValue({
      staffProfileId: 'staff_1',
      deviceId: 'device_2',
      device: { branchId: 'branch_2' },
    });

    await expect(
      caller().issueCredential({
        staffProfileId: 'staff_1',
        type: 'PIN',
        secret: '4821',
        deviceId: 'device_2',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller().rotateCredential({ credentialId: 'cred_1', secret: '99887' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().revokeCredential({ credentialId: 'cred_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.deviceFindUnique.mockResolvedValue(null);
    await expect(
      caller().issueCredential({
        staffProfileId: 'staff_1',
        type: 'PIN',
        secret: '4821',
        deviceId: 'missing_or_foreign',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.credCreate).not.toHaveBeenCalled();
    expect(mocks.credUpdate).not.toHaveBeenCalled();
  });

  it('allows device-bound credential mutations when profile and device branches are authorized', async () => {
    branchManager('branch_1', 'branch_2');
    mocks.deviceFindUnique.mockResolvedValue({ branchId: 'branch_2' });
    mocks.credFindUnique.mockResolvedValue({
      id: 'cred_1',
      staffProfileId: 'staff_1',
      deviceId: 'device_2',
      device: { branchId: 'branch_2' },
      type: 'PIN',
      revokedAt: null,
    });

    await expect(
      caller().issueCredential({
        staffProfileId: 'staff_1',
        type: 'PIN',
        secret: '4821',
        deviceId: 'device_2',
      })
    ).resolves.toMatchObject({ id: 'cred_new' });
    await expect(
      caller().rotateCredential({ credentialId: 'cred_1', secret: '99887' })
    ).resolves.toMatchObject({ id: 'cred_1' });
    await expect(caller().revokeCredential({ credentialId: 'cred_1' })).resolves.toMatchObject({
      id: 'cred_1',
    });
  });

  it('denies organization-wide credentials to a branch manager but allows a configurator', async () => {
    branchManager('branch_1');
    await expect(
      caller().issueCredential({ staffProfileId: 'staff_1', type: 'PIN', secret: '4821' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    mocks.can.mockResolvedValue(true);
    await expect(
      caller().issueCredential({ staffProfileId: 'staff_1', type: 'PIN', secret: '4821' })
    ).resolves.toMatchObject({ id: 'cred_new', deviceId: null });
  });
});

describe('credential listing', () => {
  it('never selects the credential hash', async () => {
    mocks.credFindMany.mockResolvedValue([]);
    await caller().listCredentials({ staffProfileId: 'staff_1' });
    const { select, where } = mocks.credFindMany.mock.calls[0][0];
    expect(select.credentialHash).toBeUndefined();
    expect('credentialHash' in select).toBe(false);
    // Active-only by default.
    expect(where).toMatchObject({ revokedAt: null });
  });

  it('includes revoked credentials only when asked', async () => {
    mocks.credFindMany.mockResolvedValue([]);
    await caller().listCredentials({ staffProfileId: 'staff_1', includeRevoked: true });
    const { where } = mocks.credFindMany.mock.calls[0][0];
    expect(where.revokedAt).toBeUndefined();
  });
});
