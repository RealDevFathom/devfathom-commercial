/**
 * D20 — `team.inviteMember` must refuse a differently-cased duplicate with a
 * friendly CONFLICT, not by letting the unique index surface as a Prisma error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  roleFindFirst: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  invitationUpsert: vi.fn(),
  departmentFindFirst: vi.fn(),
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
import { invitationsRouter } from './invitations';
import { router, type TRPCContext } from '../trpc';

const db = {
  organization: { findUnique: vi.fn(async () => ({ slug: 'bistro', domains: [] })) },
  organizationRole: { findFirst: mocks.roleFindFirst },
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      user: { create: mocks.create, update: mocks.update },
      invitation: { upsert: mocks.invitationUpsert },
    }),
};

function caller(activeSeats = 1) {
  return router({ team: teamRouter }).createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats, seatLimit: 50 },
    session: {
      expires: 'later',
      user: {
        organizationId: 'org_restaurant',
        id: 'user_admin',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_restaurant', slug: 'bistro', vertical: 'RESTAURANT' },
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

  it('retains the administrator capability check without HR', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().inviteMember({ ...invite, email: 'cashier@example.com' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('retains seat limits without HR', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(
      caller(50).inviteMember({ ...invite, email: 'cashier@example.com' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('Seat limit reached'),
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a department outside the tenant catalog', async () => {
    mocks.departmentFindFirst.mockResolvedValue(null);

    await expect(
      caller().inviteMember({ ...invite, email: 'new.person@company.com' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid department.' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('restaurant invite roles and tenant host', () => {
  it.each(['cashier', 'kitchen', 'server'] as const)(
    'assigns %s without elevating the account role',
    async (role) => {
      mocks.departmentFindFirst.mockResolvedValue({ id: 'dept' });
      mocks.roleFindFirst.mockResolvedValue({ id: `role_${role}` });
      mocks.findFirst.mockResolvedValue(null);
      mocks.create.mockResolvedValue({ id: 'new_user', name: 'Alex' });
      vi.stubEnv('PLATFORM_BASE_DOMAIN', 'devfathom.com');
      try {
        const result = await caller().inviteMember({ ...invite, email: 'alex@example.com', role });
        expect(mocks.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ role: 'EMPLOYEE', organizationRoleId: `role_${role}` }),
          })
        );
        expect(mocks.roleFindFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              organizationId: 'org_restaurant',
              key: role,
              organization: { vertical: 'RESTAURANT' },
            },
          })
        );
        expect(result.inviteUrl).toMatch(/^https:\/\/bistro.devfathom.com\/invite\//);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
  it('rejects a role absent from this restaurant tenant', async () => {
    mocks.roleFindFirst.mockResolvedValue(null);
    await expect(
      caller().inviteMember({ ...invite, email: 'alex@example.com', role: 'cashier' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

it.each(['cashier', 'kitchen', 'server'] as const)(
  'preserves the invited %s assignment on acceptance',
  async (role) => {
    const user = {
      id: 'invited',
      name: 'Alex',
      email: 'alex@example.com',
      role: 'EMPLOYEE',
      organizationRoleId: `role_${role}`,
      status: 'INVITED',
    };
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept' });
    mocks.roleFindFirst.mockResolvedValue({ id: `role_${role}` });
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }) => Object.assign(user, data));
    await caller().inviteMember({ ...invite, email: user.email, role });
    const update = vi.fn(async ({ data }) => Object.assign(user, data));
    const profileCreate = vi.fn(async () => ({ id: 'floor_profile', primaryBranchId: null }));
    const acceptDb = {
      invitation: {
        findUnique: vi.fn(async () => ({
          id: 'invitation',
          userId: user.id,
          expiresAt: new Date(Date.now() + 60000),
          acceptedAt: null,
          user: {
            ...user,
            organizationId: 'org_restaurant',
            organizationRole: { key: role },
            organization: { isDemo: false, vertical: 'RESTAURANT' },
          },
        })),
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          invitation: { updateMany: vi.fn(async () => ({ count: 1 })) },
          user: { update },
          restaurantStaffProfile: { findFirst: vi.fn(async () => null), create: profileCreate },
          restaurantBranch: { findFirst: vi.fn(async () => null) },
        }),
    };
    await invitationsRouter
      .createCaller({
        db: acceptDb,
        requestMeta: { ip: null, userAgent: null },
      } as unknown as TRPCContext)
      .accept({ token: 'token', password: 'Str0ng!Passw0rd', phone: '+15550999' });
    expect(profileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: user.id,
          organizationId: 'org_restaurant',
          displayName: user.name,
        }),
      })
    );
    expect(JSON.stringify(profileCreate.mock.calls)).not.toMatch(/pin|credential/i);
    expect(user).toMatchObject({
      status: 'ACTIVE',
      role: 'EMPLOYEE',
      organizationRoleId: `role_${role}`,
    });
  }
);
