import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  departmentFindFirst: vi.fn(),
  can: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
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
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const storedUser = {
  id: 'member_1',
  name: 'Casey',
  email: 'casey@example.test',
  role: 'HR',
  department: 'PEOPLE',
  title: 'People Partner',
  avatar: null,
  phone: null,
  bio: null,
  skills: ['Hiring'],
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  status: 'ACTIVE',
  lastActiveAt: null,
  password: '$2b$12$credential-hash',
  tokenVersion: 7,
  passwordChangedAt: new Date('2026-01-02T00:00:00.000Z'),
  mustChangePassword: true,
  preferences: { private: true },
  notificationPrefs: { private: true },
  twoFactorSecret: 'TOPSECRET',
  twoFactorEnabledAt: new Date('2026-01-03T00:00:00.000Z'),
};

function caller() {
  const db = {
    user: { findUnique: mocks.findUnique, update: mocks.update, count: mocks.count },
    organizationDepartment: { findFirst: mocks.departmentFindFirst },
    $queryRaw: vi.fn(async () => [{ id: 'org_test' }]),
    // adminUpdateMember runs its read/check/write inside an interactive transaction.
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return router({ team: teamRouter }).createCaller({
    db,
    entitlements: { enabledModules: ['hr'], modules: [], activeSeats: 2, seatLimit: 50 },
    session: {
      expires: 'later',
      user: { id: 'admin_1', role: 'ADMIN', department: 'LEADERSHIP', status: 'ACTIVE' },
    },
    organization: { id: 'org_test', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).team;
}

describe('team.adminUpdateMember response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findUnique.mockResolvedValue({
      name: 'Casey',
      email: 'casey@example.test',
      role: 'EMPLOYEE',
      department: 'PEOPLE',
      title: 'Recruiter',
      phone: null,
      bio: null,
      skills: ['Hiring'],
      status: 'ACTIVE',
    });
    mocks.departmentFindFirst.mockResolvedValue({ id: 'department_1' });
    mocks.update.mockImplementation(async ({ select }: { select: Record<string, true> }) =>
      Object.fromEntries(
        Object.keys(select).map((key) => [key, storedUser[key as keyof typeof storedUser]])
      )
    );
  });

  it('uses an allowlist and never returns credential or session fields', async () => {
    const member = await caller().adminUpdateMember({ id: 'member_1', title: 'People Partner' });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'member_1' },
      data: { title: 'People Partner' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        title: true,
        avatar: true,
        phone: true,
        bio: true,
        skills: true,
        startDate: true,
        status: true,
        lastActiveAt: true,
      },
    });
    expect(member).toMatchObject({ id: 'member_1', name: 'Casey', title: 'People Partner' });
    expect(member).not.toHaveProperty('password');
    expect(member).not.toHaveProperty('tokenVersion');
    expect(member).not.toHaveProperty('passwordChangedAt');
    expect(member).not.toHaveProperty('mustChangePassword');
    expect(member).not.toHaveProperty('preferences');
    expect(member).not.toHaveProperty('notificationPrefs');
    expect(member).not.toHaveProperty('twoFactorSecret');
    expect(member).not.toHaveProperty('twoFactorEnabledAt');
  });
});

// #435: `admin:access` alone must not let an admin grant or revoke roles; a
// DENY `team:setRole` override is enforced before the member row is written.
describe('team.adminUpdateMember team:setRole gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockImplementation(
      async (_subject: unknown, action: unknown) => action !== 'team:setRole'
    );
    mocks.findUnique.mockResolvedValue({
      name: 'Casey',
      email: 'casey@example.test',
      role: 'EMPLOYEE',
      department: 'PEOPLE',
      title: 'Recruiter',
      phone: null,
      bio: null,
      skills: ['Hiring'],
      status: 'ACTIVE',
    });
    mocks.count.mockResolvedValue(2);
    mocks.update.mockResolvedValue({ id: 'member_1', name: 'Casey' });
  });

  it.each(['ADMIN', 'HR'] as const)('refuses to change the role to %s', async (role) => {
    await expect(caller().adminUpdateMember({ id: 'member_1', role })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'team:setRole',
      { type: 'User', id: 'member_1', targetRole: role },
      expect.anything()
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses to revoke an admin role', async () => {
    mocks.findUnique.mockResolvedValue({ name: 'Casey', role: 'ADMIN', status: 'ACTIVE' });

    await expect(
      caller().adminUpdateMember({ id: 'member_1', role: 'EMPLOYEE' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('still saves a profile edit that resends the unchanged role', async () => {
    await caller().adminUpdateMember({ id: 'member_1', role: 'EMPLOYEE', title: 'Lead' });

    expect(mocks.can).not.toHaveBeenCalledWith(
      expect.anything(),
      'team:setRole',
      expect.anything(),
      expect.anything()
    );
    expect(mocks.update).toHaveBeenCalledOnce();
  });
});
