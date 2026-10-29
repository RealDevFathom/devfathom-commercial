import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  departmentFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userUpdate: vi.fn(),
  queryRaw: vi.fn(),
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
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://example.test'),
  sendEmail: mocks.sendEmail,
  templates: {
    accountDeactivated: vi.fn(() => ({ subject: 'subject', html: 'html', text: 'text' })),
  },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { teamRouter } from './team';

type TeamDb = {
  user: {
    findUnique: typeof mocks.userFindUnique;
    count: typeof mocks.userCount;
    update: typeof mocks.userUpdate;
  };
  organizationDepartment: { findFirst: typeof mocks.departmentFindFirst };
  $queryRaw: typeof mocks.queryRaw;
  $transaction: (run: (tx: TeamDb) => Promise<unknown>) => Promise<unknown>;
};

const db: TeamDb = {
  user: {
    findUnique: mocks.userFindUnique,
    count: mocks.userCount,
    update: mocks.userUpdate,
  },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  $queryRaw: mocks.queryRaw,
  $transaction: (run) => run(db),
};

function caller(database: TeamDb = db) {
  return teamRouter.createCaller({
    db: database,
    entitlements: { enabledModules: [], modules: [], activeSeats: 2, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: 'admin_actor',
        organizationId: 'org_a',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('team last-admin serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.departmentFindFirst.mockResolvedValue({ id: 'department' });
    mocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      name: 'Admin',
      email: 'admin@example.test',
      role: 'ADMIN',
      status: 'ACTIVE',
    }));
    mocks.userCount.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValue([{ id: 'org_a' }]);
    mocks.userUpdate.mockResolvedValue({
      id: 'admin_target',
      name: 'Admin',
      email: 'admin@example.test',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });
    mocks.can.mockResolvedValue(true);
  });

  it('locks the organization before checking and rejecting an admin demotion', async () => {
    await expect(
      caller().adminUpdateMember({ id: 'admin_target', role: 'EMPLOYEE' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote or deactivate the last active admin.',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', role: 'ADMIN', status: 'ACTIVE' },
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCount.mock.invocationCallOrder[0]!
    );
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('locks the organization before checking and rejecting an admin layoff', async () => {
    await expect(
      caller().layOffMember({ id: 'admin_target', reason: 'Position eliminated' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'You cannot lay off the last active admin',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', role: 'ADMIN', status: 'ACTIVE' },
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('serializes concurrent demotions so one of two active admins remains', async () => {
    let activeAdmins = 2;
    let transactionTail = Promise.resolve();
    const concurrentDb: TeamDb = {
      ...db,
      user: {
        ...db.user,
        count: vi.fn(async () => activeAdmins) as typeof mocks.userCount,
        update: vi.fn(async ({ data }: { data: { role?: string } }) => {
          if (data.role && data.role !== 'ADMIN') activeAdmins -= 1;
          return { id: 'updated', name: 'Admin', role: data.role, status: 'ACTIVE' };
        }) as typeof mocks.userUpdate,
      },
      $transaction: async (run) => {
        const prior = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => (release = resolve));
        await prior;
        try {
          return await run(concurrentDb);
        } finally {
          release();
        }
      },
    };

    const results = await Promise.allSettled([
      caller(concurrentDb).adminUpdateMember({ id: 'admin_b', role: 'EMPLOYEE' }),
      caller(concurrentDb).adminUpdateMember({ id: 'admin_c', role: 'EMPLOYEE' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(activeAdmins).toBe(1);
  });
});
