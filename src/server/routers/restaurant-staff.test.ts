/**
 * M2-L2 router — capability gating, credential-secret audit suppression (C4),
 * and domain-error → tRPC status mapping. Runs the REAL router and the REAL L1
 * hashing/lifecycle core against a hand-rolled in-memory db (no PostgreSQL); the
 * ABAC decision, entitlement check and audit writer are mocked so the test
 * exercises this lane's logic, not the platform middleware.
 */
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
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  userCount: vi.fn(),
  jobRoleFindFirst: vi.fn(),
  staffJobRoleCreate: vi.fn(),
  staffJobRoleAuditCreate: vi.fn(),
  departmentFindFirst: vi.fn(),
  invitationCreate: vi.fn(),
  invitationUpsert: vi.fn(),
  sendEmail: vi.fn(),
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
vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://devfathom.test',
  sendEmail: mocks.sendEmail,
  templates: { inviteMember: () => ({ subject: 'Invite', html: '<p>Invite</p>', text: 'Invite' }) },
}));
vi.mock('@/lib/restaurant/job-roles', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/job-roles')>(
    '@/lib/restaurant/job-roles'
  )),
  resolveStaffCapabilities: mocks.resolveStaffCapabilities,
}));

import { restaurantStaffRouter } from './restaurant-staff';
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { TRPCContext } from '../trpc';

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
    update: mocks.userUpdate,
    count: mocks.userCount,
  },
  restaurantJobRole: { findFirst: mocks.jobRoleFindFirst },
  restaurantStaffJobRole: { create: mocks.staffJobRoleCreate },
  restaurantStaffJobRoleAudit: { create: mocks.staffJobRoleAuditCreate },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  invitation: { create: mocks.invitationCreate, upsert: mocks.invitationUpsert },
  restaurantOperatorCredential: {
    findMany: mocks.credFindMany,
    findFirst: mocks.credFindFirst,
    findUnique: mocks.credFindUnique,
    create: mocks.credCreate,
    update: mocks.credUpdate,
  },
};

function caller() {
  return restaurantStaffRouter.createCaller({
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
    organization: { id: 'org_workspace' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'restaurant-staff-invite-test-secret');
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
  mocks.userCreate.mockResolvedValue({ id: 'user_invited', name: 'Mina Shah' });
  mocks.userUpdate.mockResolvedValue({});
  mocks.userCount.mockResolvedValue(1);
  mocks.jobRoleFindFirst.mockImplementation(async ({ where }: { where: { key: string } }) => ({
    id: `role_${where.key}`,
    key: where.key,
  }));
  mocks.staffJobRoleCreate.mockResolvedValue({ id: 'holding_1' });
  mocks.staffJobRoleAuditCreate.mockResolvedValue({});
  mocks.departmentFindFirst.mockResolvedValue({ key: 'OPERATIONS' });
  mocks.invitationCreate.mockResolvedValue({});
  mocks.invitationUpsert.mockResolvedValue({});
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

  it('atomically creates an invited manager and linked staff profile', async () => {
    mocks.userFindFirst.mockResolvedValue(null);

    const result = await caller().invite({
      name: 'Mina Shah',
      email: 'MINA@EXAMPLE.COM',
      staffRole: 'MANAGER',
      primaryBranchId: 'branch_1',
      idempotencyKey: 'manager-invite-1',
    });

    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'mina@example.com',
        title: 'Restaurant Manager',
        role: 'EMPLOYEE',
      }),
    });
    expect(mocks.staffCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user_invited', primaryBranchId: 'branch_1' }),
    });
    expect(mocks.staffJobRoleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffProfileId: 'staff_new',
        jobRoleId: 'role_manager',
        branchId: 'branch_1',
      }),
    });
    expect(mocks.staffJobRoleAuditCreate).toHaveBeenCalledOnce();
    expect(mocks.staffCount).toHaveBeenCalledWith({
      where: { organizationId: 'org_workspace', status: 'ACTIVE' },
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith({
      where: { id: 'user_invited' },
      data: { status: 'INVITED' },
    });
    expect(mocks.invitationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user_invited', email: 'mina@example.com' }),
    });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: 'staff_new' });
  });

  it('assigns a waiter only the server job role', async () => {
    mocks.userFindFirst.mockResolvedValue(null);

    await caller().invite({
      name: 'Waleed Khan',
      email: 'waleed@example.com',
      staffRole: 'WAITER',
      primaryBranchId: 'branch_1',
      idempotencyKey: 'waiter-invite-1',
    });

    expect(mocks.jobRoleFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_workspace', key: 'server', active: true },
      select: { id: true, key: true },
    });
    expect(mocks.staffJobRoleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobRoleId: 'role_server' }),
    });
  });

  it('returns a shareable link when email delivery fails', async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.sendEmail.mockRejectedValueOnce(new Error('SMTP unavailable'));

    const result = await caller().invite({
      name: 'Mina Shah',
      email: 'mina@example.com',
      staffRole: 'MANAGER',
      primaryBranchId: 'branch_1',
      idempotencyKey: 'manager-invite-2',
    });

    expect(result).toMatchObject({
      inviteUrl: expect.stringMatching(/^https:\/\/devfathom\.test\/invite\//),
      emailDelivered: false,
      resent: false,
    });
  });

  it('rotates and resends the invitation for an already-invited restaurant staff user', async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: 'user_invited',
      name: 'Mina Shah',
      status: 'INVITED',
      restaurantStaffProfiles: [
        {
          id: 'staff_new',
          displayName: 'Mina Shah',
          primaryBranchId: 'branch_1',
          jobRoles: [{ jobRole: { key: 'manager' } }],
        },
      ],
    });

    const result = await caller().invite({
      name: 'Mina Shah',
      email: 'mina@example.com',
      staffRole: 'MANAGER',
      primaryBranchId: 'branch_1',
      idempotencyKey: 'manager-resend-1',
    });

    expect(mocks.invitationUpsert).toHaveBeenCalledWith({
      where: { userId: 'user_invited' },
      create: expect.objectContaining({ userId: 'user_invited', email: 'mina@example.com' }),
      update: expect.objectContaining({ email: 'mina@example.com', acceptedAt: null }),
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.userCount).not.toHaveBeenCalled();
    expect(mocks.staffCount).not.toHaveBeenCalled();
    expect(mocks.staffCreate).not.toHaveBeenCalled();
    expect(mocks.staffJobRoleCreate).not.toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ emailDelivered: true, resent: true });
  });

  it('keeps concurrent retries on the same idempotency key usable', async () => {
    let existingUser: Record<string, unknown> | null = null;
    let transactionTail = Promise.resolve();
    const originalTransaction = db.$transaction;
    db.$transaction = async (run: (tx: unknown) => Promise<unknown>) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run(db);
      } finally {
        release();
      }
    };
    mocks.userFindFirst.mockImplementation(async () => existingUser);
    mocks.userCreate.mockImplementation(async () => {
      existingUser = {
        id: 'user_invited',
        name: 'Mina Shah',
        status: 'INVITED',
        restaurantStaffProfiles: [
          {
            id: 'staff_new',
            displayName: 'Mina Shah',
            primaryBranchId: 'branch_1',
            jobRoles: [{ jobRole: { key: 'manager' } }],
          },
        ],
      };
      return { id: 'user_invited', name: 'Mina Shah' };
    });

    const input = {
      name: 'Mina Shah',
      email: 'mina@example.com',
      staffRole: 'MANAGER' as const,
      primaryBranchId: 'branch_1',
      idempotencyKey: 'same-logical-request',
    };
    try {
      const [first, retry] = await Promise.all([caller().invite(input), caller().invite(input)]);
      expect(first.inviteUrl).toBe(retry.inviteUrl);
      expect(mocks.invitationCreate.mock.calls[0]![0].data.tokenHash).toBe(
        mocks.invitationUpsert.mock.calls[0]![0].update.tokenHash
      );
    } finally {
      db.$transaction = originalTransaction;
    }
  });

  it('rejects changing the restaurant role on a pending invitation', async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: 'user_invited',
      name: 'Mina Shah',
      status: 'INVITED',
      restaurantStaffProfiles: [
        {
          id: 'staff_new',
          displayName: 'Mina Shah',
          primaryBranchId: 'branch_1',
          jobRoles: [{ jobRole: { key: 'server' } }],
        },
      ],
    });

    await expect(
      caller().invite({
        name: 'Mina Shah',
        email: 'mina@example.com',
        staffRole: 'MANAGER',
        primaryBranchId: 'branch_1',
        idempotencyKey: 'manager-role-change-1',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('re-counts occupied seats after taking the organization lock', async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCount.mockResolvedValue(50);

    await expect(
      caller().invite({
        name: 'No Seat',
        email: 'noseat@example.com',
        staffRole: 'WAITER',
        primaryBranchId: 'branch_1',
        idempotencyKey: 'no-seat-invite-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCount.mock.invocationCallOrder[0]!
    );
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('does not invite into a branch outside the manager scope', async () => {
    mocks.can.mockImplementation(async (...args) => args[1] === 'staff:manage');
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'manager',
        primaryBranchId: 'branch_1',
        jobRoles: [],
        directCapabilityGrants: [],
      },
    ]);

    await expect(
      caller().invite({
        name: 'Blocked User',
        email: 'blocked@example.com',
        staffRole: 'WAITER',
        primaryBranchId: 'branch_2',
        idempotencyKey: 'blocked-invite-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
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
