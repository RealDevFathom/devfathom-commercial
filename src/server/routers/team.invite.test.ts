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
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
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
      user: {
        id: 'user_admin',
        organizationId: 'org_1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
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
    mocks.queryRaw.mockResolvedValue([]);
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
        where: { organizationId: 'org_1', email: 'alex@company.com' },
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
        data: expect.objectContaining({
          organizationId: 'org_1',
          email: 'new.person@company.com',
        }),
      })
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findFirst.mock.invocationCallOrder[0]!
    );
    expect(mocks.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.count.mock.invocationCallOrder[0]!
    );
  });

  it('retains the administrator capability check without HR', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().inviteMember({ ...invite, email: 'cashier@example.com' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('locks and recounts occupied seats before creating a new invite', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.count.mockResolvedValue(50);

    await expect(
      caller(1).inviteMember({ ...invite, email: 'cashier@example.com' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Seat limit reached (50/50). Increase the organization license before inviting another member.',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    const [query, lockedOrganizationId] = mocks.queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
    ];
    expect(query.join(' ')).toContain('FROM "organizations" WHERE "id" =');
    expect(query.join(' ')).toContain('FOR UPDATE');
    expect(lockedOrganizationId).toBe('org_1');
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] },
      },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('re-invites an existing pending member without consuming another seat', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_invited', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_invited', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});

    await caller(50).inviteMember({ ...invite, email: 'alex@company.com' });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_id: { organizationId: 'org_1', id: 'user_invited' } },
      })
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a department outside the tenant catalog', async () => {
    mocks.departmentFindFirst.mockResolvedValue(null);

    await expect(
      caller().inviteMember({ ...invite, email: 'new.person@company.com' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid department.' });
    expect(mocks.departmentFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', key: 'ENGINEERING', active: true },
      select: { id: true },
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
