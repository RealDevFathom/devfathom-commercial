/**
 * D20 — `team.inviteMember` must refuse a differently-cased duplicate with a
 * friendly CONFLICT, not by letting the unique index surface as a Prisma error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  queryRaw: vi.fn(),
  invitationUpsert: vi.fn(),
  departmentFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  sendEmail: vi.fn(),
  can: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn((_entitlements: unknown, key: string) => key === 'admin'),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: mocks.sendEmail,
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { teamRouter } from './team';
import { INVITE_ROLE_MISMATCH, INVITE_ROLE_NOT_OFFERED } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';

const db = {
  user: {
    findFirst: mocks.findFirst,
    create: mocks.create,
    update: mocks.update,
    count: mocks.count,
  },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  organizationRole: { findFirst: mocks.roleFindFirst },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: {
        findFirst: mocks.findFirst,
        findUnique: mocks.findUnique,
        create: mocks.create,
        update: mocks.update,
        count: mocks.count,
      },
      invitation: { upsert: mocks.invitationUpsert },
      $queryRaw: mocks.queryRaw,
    }),
};

function caller(activeSeats = 1, vertical?: string) {
  return router({ team: teamRouter }).createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats, seatLimit: 50, vertical },
    session: {
      expires: 'later',
      user: { id: 'user_admin', role: 'ADMIN', department: 'LEADERSHIP', status: 'ACTIVE' },
    },
    organization: { id: 'org_test' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).team;
}

const invite = {
  name: 'Alex Carter',
  role: 'EMPLOYEE' as const,
  department: 'ENGINEERING' as const,
  title: 'Engineer',
};

describe('team.inviteMember duplicate guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_engineering' });
    mocks.count.mockResolvedValue(1);
  });

  it.each([['ALEX@COMPANY.COM'], ['Alex@Company.com'], ['  alex@company.com  ']])(
    'rejects %j when alex@company.com is already an active member',
    async (email) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_1', status: 'ACTIVE' });

      await expect(caller().inviteMember({ ...invite, email })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'A user with this email already exists',
      });
      expect(mocks.findFirst).toHaveBeenCalledWith({
        where: { email: 'alex@company.com' },
        select: { id: true, status: true },
      });
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

  it('stores the canonical form for a genuinely new member', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});

    await caller().inviteMember({ ...invite, email: 'New.Person@Company.COM' });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new.person@company.com' }),
      })
    );
  });

  it.each(['SENT', 'FAILED'] as const)(
    'reports %s while retaining a usable invitation',
    async (delivery) => {
      mocks.findFirst.mockResolvedValue(null);
      mocks.create.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });
      mocks.invitationUpsert.mockResolvedValue({});
      mocks.sendEmail.mockResolvedValue({ messageId: 'provider-id' });
      if (delivery === 'FAILED')
        mocks.sendEmail.mockRejectedValueOnce(new Error('Provider unavailable'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await caller().inviteMember({ ...invite, email: 'alex@company.com' });
        expect(result).toEqual({
          id: 'user_invited',
          inviteUrl: expect.stringMatching(/\/invite\/.+/),
          emailDelivery: delivery,
        });
        expect(mocks.invitationUpsert).toHaveBeenCalledOnce();
        expect(mocks.sendEmail).toHaveBeenCalledOnce();
        expect(mocks.invitationUpsert.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.sendEmail.mock.invocationCallOrder[0]!
        );
      } finally {
        log.mockRestore();
      }
    }
  );

  it('stores a restaurant role template on the invited member', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_gm', name: 'General Manager' });
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});

    await caller().inviteMember({
      ...invite,
      email: 'manager@company.com',
      organizationRoleId: 'role_gm',
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationRoleId: 'role_gm' }),
      })
    );
  });

  it.each([undefined, null])(
    'preserves the pending role when no template is selected (%s)',
    async (organizationRoleId) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_invited', status: 'INVITED' });
      mocks.update.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });
      mocks.invitationUpsert.mockResolvedValue({});

      await caller().inviteMember({ ...invite, email: 'manager@company.com', organizationRoleId });

      const data = mocks.update.mock.calls[0]![0].data;
      expect(data).not.toHaveProperty('organizationRoleId');
      expect(mocks.invitationUpsert).toHaveBeenCalledOnce();
    }
  );

  it('replaces a pending role when a valid template is explicitly selected', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_invited', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_branch', name: 'Branch Manager' });

    await caller().inviteMember({
      ...invite,
      email: 'manager@company.com',
      organizationRoleId: 'role_branch',
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationRoleId: 'role_branch' }),
      })
    );
  });

  it('rejects a role template outside the tenant catalog', async () => {
    mocks.roleFindFirst.mockResolvedValue(null);

    await expect(
      caller().inviteMember({
        ...invite,
        email: 'manager@company.com',
        organizationRoleId: 'role_from_another_tenant',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid role template.' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('retains the administrator capability check without HR', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().inviteMember({ ...invite, email: 'cashier@example.com' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('retains seat limits without HR', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(50);
    await expect(
      caller(50).inviteMember({ ...invite, email: 'cashier@example.com' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('Seat limit reached'),
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('locks the organization and recounts occupied seats before creating', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(49);
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});

    await caller().inviteMember({ ...invite, email: 'cashier@example.com' });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.count).toHaveBeenCalledWith({
      where: { status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.count.mock.invocationCallOrder[0]!
    );
    expect(mocks.count.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]!
    );
  });

  it('rejects a department outside the tenant catalog', async () => {
    mocks.departmentFindFirst.mockResolvedValue(null);

    await expect(
      caller().inviteMember({ ...invite, email: 'new.person@company.com' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid department.' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

// #435: an admin with a DENY `team:setRole` override keeps `admin:access` but
// may not grant a role or role template through an invite.
describe('team.inviteMember team:setRole gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockImplementation(
      async (_subject: unknown, action: unknown) => action !== 'team:setRole'
    );
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_engineering' });
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_gm', name: 'General Manager' });
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(1);
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
  });

  it.each([
    ['an ADMIN role', { role: 'ADMIN' as const }],
    ['an HR role', { role: 'HR' as const }],
    ['a role template', { organizationRoleId: 'role_gm' }],
  ])('refuses to invite with %s', async (_label, extra) => {
    await expect(
      caller().inviteMember({ ...invite, email: 'grant@company.com', ...extra })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'team:setRole',
      expect.objectContaining({ type: 'User' }),
      expect.anything()
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ['an ADMIN role', { role: 'ADMIN', organizationRoleId: null }],
    ['an HR role', { role: 'HR', organizationRoleId: null }],
    ['a role template', { role: 'EMPLOYEE', organizationRoleId: 'role_gm' }],
  ])('refuses a baseline re-invite that would revoke %s', async (_label, current) => {
    mocks.findFirst.mockResolvedValue({ id: 'user_pending', status: 'INVITED' });
    mocks.findUnique.mockResolvedValue(current);

    await expect(
      caller().inviteMember({ ...invite, email: 'pending@company.com' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'team:setRole',
      { type: 'User', id: 'user_pending', targetRole: 'EMPLOYEE' },
      expect.anything()
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('still re-invites a pending baseline employee', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_pending', status: 'INVITED' });
    mocks.findUnique.mockResolvedValue({ role: 'EMPLOYEE', organizationRoleId: null });
    mocks.update.mockResolvedValue({ id: 'user_pending', name: 'Alex Carter' });

    await caller().inviteMember({ ...invite, email: 'pending@company.com' });

    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it('still invites a baseline employee with no role template', async () => {
    await caller().inviteMember({ ...invite, email: 'plain@company.com' });

    expect(mocks.can).not.toHaveBeenCalledWith(
      expect.anything(),
      'team:setRole',
      expect.anything(),
      expect.anything()
    );
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});

// SEC-I (DEV-827): a pharmacy invite grants exactly what the chosen role's label says.
describe('team.inviteMember pharmacy role labels', () => {
  const pharmacyInvite = { ...invite, email: 'staff@pharmacy.pk', department: 'COUNTER' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_counter' });
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(1);
    mocks.create.mockResolvedValue({ id: 'user_2', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
  });

  const template = (key: string) =>
    mocks.roleFindFirst.mockResolvedValue({ id: `role_${key}`, name: key, key });

  it.each([
    ['owner', 'ADMIN'],
    ['owner', 'EMPLOYEE'],
    ['owner-operator', 'ADMIN'],
    ['owner-operator', 'EMPLOYEE'],
  ] as const)('refuses to invite %s at %s', async (key, role) => {
    template(key);
    await expect(
      caller(1, 'PHARMACY').inviteMember({
        ...pharmacyInvite,
        role,
        organizationRoleId: `role_${key}`,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: INVITE_ROLE_NOT_OFFERED });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ['manager', 'HR'],
    ['manager', 'ADMIN'],
    ['pharmacist', 'ADMIN'],
    ['admin', 'EMPLOYEE'],
  ] as const)('refuses %s with a %s base role', async (key, role) => {
    template(key);
    await expect(
      caller(1, 'PHARMACY').inviteMember({
        ...pharmacyInvite,
        role,
        organizationRoleId: `role_${key}`,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: INVITE_ROLE_MISMATCH });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['HR', 'ADMIN'] as const)('refuses %s with no pharmacy role', async (role) => {
    await expect(
      caller(1, 'PHARMACY').inviteMember({ ...pharmacyInvite, role })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: INVITE_ROLE_MISMATCH });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ['manager', 'EMPLOYEE'],
    ['admin', 'ADMIN'],
  ] as const)('invites %s at exactly %s', async (key, role) => {
    template(key);
    await caller(1, 'PHARMACY').inviteMember({
      ...pharmacyInvite,
      role,
      organizationRoleId: `role_${key}`,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role, organizationRoleId: `role_${key}` }),
      })
    );
  });

  it('leaves the agency base role switch unconstrained', async () => {
    template('owner');
    await caller(1, 'AGENCY').inviteMember({
      ...invite,
      email: 'lead@company.com',
      role: 'HR',
      organizationRoleId: 'role_owner',
    });
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
