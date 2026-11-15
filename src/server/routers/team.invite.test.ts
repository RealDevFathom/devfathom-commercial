/**
 * D20 — `team.inviteMember` must refuse a differently-cased duplicate with a
 * friendly CONFLICT, not by letting the unique index surface as a Prisma error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  queryRaw: vi.fn(),
  invitationUpsert: vi.fn(),
  departmentFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  sendEmail: vi.fn(),
  can: vi.fn(async () => true),
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
        create: mocks.create,
        update: mocks.update,
        count: mocks.count,
      },
      invitation: { upsert: mocks.invitationUpsert },
      $queryRaw: mocks.queryRaw,
    }),
};

function caller(activeSeats = 1) {
  return router({ team: teamRouter }).createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats, seatLimit: 50 },
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
