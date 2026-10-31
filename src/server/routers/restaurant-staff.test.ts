/**
 * M2-L2 router — capability gating, credential-secret audit suppression (C4),
 * and domain-error → tRPC status mapping. Runs the REAL router and the REAL L1
 * hashing/lifecycle core against a hand-rolled in-memory db (no PostgreSQL); the
 * ABAC decision, entitlement check and audit writer are mocked so the test
 * exercises this lane's logic, not the platform middleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  userCreate: vi.fn(),
  userCount: vi.fn(),
  invitationCreate: vi.fn(),
  invitationUpdateMany: vi.fn(),
  departmentFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  roleFindMany: vi.fn(),
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

vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://example.test',
  sendEmail: mocks.sendEmail,
  templates: { inviteMember: () => ({ subject: 'Invite', html: '<p>Invite</p>', text: 'Invite' }) },
}));

import { restaurantStaffRouter } from './restaurant-staff';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { hashInviteToken } from '@/lib/invite-token';
import { router, type TRPCContext } from '../trpc';

const db = {
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
    create: mocks.userCreate,
    count: mocks.userCount,
  },
  invitation: { create: mocks.invitationCreate, updateMany: mocks.invitationUpdateMany },
  organizationDepartment: { findFirst: mocks.departmentFindFirst, findMany: vi.fn(async () => []) },
  organizationRole: { findFirst: mocks.roleFindFirst, findMany: mocks.roleFindMany },
  restaurantOperatorCredential: {
    findMany: mocks.credFindMany,
    findFirst: mocks.credFindFirst,
    findUnique: mocks.credFindUnique,
    create: mocks.credCreate,
    update: mocks.credUpdate,
  },
};

function caller(isDemo = false) {
  return router({ restaurantStaff: restaurantStaffRouter }).createCaller({
    db,
    entitlements: {
      organizationId: 'org_workspace',
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'restaurant.operators.max': 50 },
    },
    session: {
      expires: 'later',
      user: { id: 'user_gm', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: { id: 'org_workspace', isDemo },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).restaurantStaff;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.resolveStaffCapabilities.mockResolvedValue(new Set(['staff:manage']));
  mocks.staffFindMany.mockResolvedValue([]);
  mocks.staffCount.mockResolvedValue(0);
  mocks.raw.mockResolvedValue([{ id: 'org_1' }]);
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindMany.mockImplementation(async (args?: { where?: { id?: { in?: string[] } } }) => {
    const ids = args?.where?.id?.in;
    if (!ids) return [{ id: 'branch_1' }];
    return ids.map((id) => ({ id }));
  });
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.deviceFindUnique.mockResolvedValue({ branchId: 'branch_1' });
  mocks.userFindFirst.mockResolvedValue({ id: 'user_1' });
  mocks.userFindMany.mockResolvedValue([]);
  mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE' });
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
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_workspace' } })
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

describe('staff invitations', () => {
  const input = {
    displayName: 'New Manager',
    email: 'new@example.test',
    title: 'Manager',
    department: 'OPERATIONS',
    organizationRoleId: 'role_manager',
    primaryBranchId: 'branch_1',
  };
  const permissions = [{ capability: 'staff:manage', effect: 'ALLOW' }];

  beforeEach(() => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'staff:manage');
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'actor',
        primaryBranchId: 'branch_1',
        jobRoles: [{ branchId: 'branch_1' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_manager', name: 'Manager', permissions });
    mocks.roleFindMany.mockResolvedValue([]);
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_1' });
    mocks.userFindFirst.mockImplementation(async ({ where }) =>
      where.email ? null : { id: 'new_user' }
    );
    mocks.userCount.mockResolvedValue(1);
    mocks.userCreate.mockImplementation(async ({ data }) => ({ id: 'new_user', ...data }));
    mocks.invitationCreate.mockResolvedValue({ id: 'invitation_1' });
    mocks.invitationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.sendEmail.mockResolvedValue({ messageId: 'sent' });
    mocks.staffFindUnique.mockResolvedValue({
      id: 'staff_1',
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
      user: {
        id: 'new_user',
        name: 'New Manager',
        email: input.email,
        status: 'INVITED',
        role: 'EMPLOYEE',
        permissionOverrides: [],
        department: 'OPERATIONS',
        organizationRole: { name: 'Manager', permissions },
      },
    });
  });

  it('creates a linked invitation with only a hash stored and audits the profile', async () => {
    const result = await caller().invite(input);
    const token = result.inviteUrl.split('/').pop()!;
    expect(result).toMatchObject({ id: 'staff_new', userId: 'new_user', emailDelivered: true });
    expect(mocks.invitationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_workspace',
        userId: 'new_user',
        tokenHash: hashInviteToken(token),
      }),
    });
    expect(JSON.stringify(mocks.invitationCreate.mock.calls)).not.toContain(token);
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetId: 'staff_new' })
    );
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCount.mock.invocationCallOrder[0]
    );
  });

  it.each(['*', 'admin:*', 'admin:access', 'restaurant:configure', 'team:setRole'])(
    'rejects unassignable permission %s before identity writes or email',
    async (capability) => {
      mocks.roleFindFirst.mockResolvedValue({
        id: 'role_manager',
        name: 'Innocuous name',
        permissions: [{ capability, effect: 'ALLOW' }],
      });
      await expect(caller().invite(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.invitationCreate).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    }
  );

  it('lets an organization administrator invite an owner role', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.roleFindFirst.mockResolvedValue({
      id: 'owner',
      name: 'Owner',
      permissions: [{ capability: '*', effect: 'ALLOW' }],
    });
    await expect(caller().invite({ ...input, organizationRoleId: 'owner' })).resolves.toMatchObject(
      { userId: 'new_user' }
    );
  });

  it('filters unassignable roles out of the invite options', async () => {
    mocks.roleFindMany.mockResolvedValue([
      { id: 'manager', key: 'manager', name: 'Manager', permissions },
      {
        id: 'owner',
        key: 'owner',
        name: 'Owner',
        permissions: [{ capability: '*', effect: 'ALLOW' }],
      },
    ]);
    await expect(caller().inviteOptions()).resolves.toMatchObject({
      roles: [{ id: 'manager', key: 'manager', name: 'Manager' }],
    });
  });

  it('does not treat a DENY rule as a delegated grant', async () => {
    mocks.roleFindFirst.mockResolvedValue({
      id: 'role_manager',
      name: 'Manager',
      permissions: [...permissions, { capability: 'admin:*', effect: 'DENY' }],
    });
    await expect(caller().invite(input)).resolves.toMatchObject({ id: 'staff_new' });
  });

  it.each(['invite', 'resendInvite'] as const)(
    'blocks %s in demo before email or writes',
    async (procedure) => {
      const request =
        procedure === 'invite'
          ? caller(true).invite(input)
          : caller(true).resendInvite({ staffProfileId: 'staff_1' });
      await expect(request).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Not available in demo.',
      });
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.invitationUpdateMany).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    }
  );

  it.each(['SUSPENDED', 'ARCHIVED'] as const)(
    'allows %s staff at the active operator ceiling while enforcing seats',
    async (status) => {
      mocks.staffCount.mockResolvedValue(50);
      await expect(caller().invite({ ...input, status })).resolves.toMatchObject({ status });
      expect(mocks.staffCount).not.toHaveBeenCalled();
      expect(mocks.raw).toHaveBeenCalled();
      mocks.userCreate.mockClear();
      mocks.userCount.mockResolvedValue(50);
      await expect(caller().invite({ ...input, status })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('Seat limit reached'),
      });
      expect(mocks.userCreate).not.toHaveBeenCalled();
    }
  );

  it('still blocks active invitations at the operator ceiling', async () => {
    mocks.staffCount.mockResolvedValue(50);
    await expect(caller().invite(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('active restaurant operators'),
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('rejects unauthorized branches and invalid departments or roles', async () => {
    await expect(caller().invite({ ...input, primaryBranchId: 'other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.departmentFindFirst.mockResolvedValueOnce(null);
    await expect(caller().invite(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    mocks.roleFindFirst.mockResolvedValueOnce(null);
    await expect(caller().invite(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('returns a manual link on delivery failure and resends without creating another account or staff profile', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.sendEmail.mockRejectedValueOnce(new Error('delivery unavailable'));
    const first = await caller().invite(input);
    expect(first).toMatchObject({
      emailDelivered: false,
      inviteUrl: expect.stringContaining('/invite/'),
    });
    const resent = await caller().resendInvite({ staffProfileId: first.id });
    expect(resent).toMatchObject({ emailDelivered: true, email: input.email });
    expect(resent.inviteUrl).not.toBe(first.inviteUrl);
    expect(mocks.invitationUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_workspace', userId: 'new_user', acceptedAt: null },
      data: {
        tokenHash: hashInviteToken(resent.inviteUrl.split('/').pop()!),
        expiresAt: expect.any(Date),
        invitedById: 'user_gm',
      },
    });
    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    expect(mocks.staffCreate).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it('does not resend invitations for unauthorized profiles or privileged accounts', async () => {
    mocks.staffFindUnique.mockResolvedValueOnce({
      primaryBranchId: 'other',
      jobRoles: [],
      directCapabilityGrants: [],
    });
    await expect(caller().resendInvite({ staffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.staffFindUnique.mockResolvedValue({
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
      user: {
        status: 'INVITED',
        permissionOverrides: [],
        organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    await expect(caller().resendInvite({ staffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.invitationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('cannot reopen accepted or missing invitations', async () => {
    mocks.staffFindUnique
      .mockResolvedValueOnce({
        primaryBranchId: 'branch_1',
        jobRoles: [],
        directCapabilityGrants: [],
      })
      .mockResolvedValueOnce({ user: { status: 'ACTIVE' } });
    await expect(caller().resendInvite({ staffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    mocks.invitationUpdateMany.mockResolvedValue({ count: 0 });
    await expect(caller().resendInvite({ staffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('cannot resend a legacy administrator account with no role template', async () => {
    mocks.staffFindUnique.mockResolvedValue({
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
      user: { status: 'INVITED', role: 'ADMIN', organizationRole: null, permissionOverrides: [] },
    });
    await expect(caller().resendInvite({ staffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.invitationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('cannot recover an account with an administrator permission override', async () => {
    mocks.staffFindUnique.mockResolvedValue({
      primaryBranchId: 'branch_1',
      jobRoles: [],
      directCapabilityGrants: [],
      user: {
        status: 'INVITED',
        role: 'EMPLOYEE',
        organizationRole: null,
        permissionOverrides: [{ capability: 'admin:access', effect: 'ALLOW' }],
      },
    });
    await expect(caller().resendInvite({ staffProfileId: 'staff_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.invitationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
