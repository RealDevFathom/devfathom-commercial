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
import type { TRPCContext } from '../trpc';

const db = {
  user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  invitation: { upsert: mocks.invitationUpsert },
  $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      $queryRaw: mocks.queryRaw,
      user: { create: mocks.create, update: mocks.update, count: mocks.count },
      invitation: { upsert: mocks.invitationUpsert },
    }),
};

function caller() {
  return teamRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50 },
    session: {
      expires: 'later',
      user: {
        id: 'user_admin',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org_acme',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
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
    mocks.queryRaw.mockResolvedValue([]);
    // In-transaction seat recount: default to plenty of headroom.
    mocks.count.mockResolvedValue(0);
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

  it('rejects a department outside the tenant catalog', async () => {
    mocks.departmentFindFirst.mockResolvedValue(null);

    await expect(
      caller().inviteMember({ ...invite, email: 'new.person@company.com' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid department.' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

// SEC (#199): the request-time entitlement snapshot alone can't gate seats —
// concurrent invites all read the same stale snapshot and would collectively
// exceed the license. inviteMember must take the organization seat lock
// (`FOR UPDATE` + recount) inside its transaction before creating a new seat.
describe('team.inviteMember seat lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_engineering' });
    mocks.queryRaw.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: 'user_new', name: 'Alex Carter' });
    mocks.invitationUpsert.mockResolvedValue({});
  });

  it('locks the organization row and recounts seats before creating a new member', async () => {
    mocks.count.mockResolvedValue(0);

    await caller().inviteMember({ ...invite, email: 'new.person@company.com' });

    // FOR UPDATE row lock taken, then the authoritative in-transaction recount.
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_acme', status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('refuses when the in-transaction recount hits the limit despite a stale snapshot', async () => {
    // Snapshot says one seat used of 50 (the pre-check passes), but by the time
    // the transaction runs a racing invite filled the org to the 50-seat cap.
    mocks.count.mockResolvedValue(50);

    await expect(
      caller().inviteMember({ ...invite, email: 'new.person@company.com' })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Seat limit reached (50/50).',
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.invitationUpsert).not.toHaveBeenCalled();
  });

  it('does not take the seat lock when re-inviting an existing pending member', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_pending', status: 'INVITED' });
    mocks.update.mockResolvedValue({ id: 'user_pending', name: 'Alex Carter' });

    await caller().inviteMember({ ...invite, email: 'pending@company.com' });

    // Re-invite reuses an already-allocated seat, so no lock/recount is needed.
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
