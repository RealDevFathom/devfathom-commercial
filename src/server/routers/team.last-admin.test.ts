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
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userFindUnique.mock.invocationCallOrder[0]!
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
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userFindUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it.each([{ role: 'ADMIN' as const }, { status: 'ACTIVE' as const }])(
    'locks role/status changes %j before reading the member',
    async (change) => {
      mocks.userFindUnique.mockResolvedValue({ role: 'EMPLOYEE', status: 'INACTIVE' });

      await caller().adminUpdateMember({ id: 'admin_target', ...change });

      expect(mocks.queryRaw).toHaveBeenCalledOnce();
      expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.userFindUnique.mock.invocationCallOrder[0]!
      );
      expect(mocks.userCount).not.toHaveBeenCalled();
      expect(mocks.userUpdate).toHaveBeenCalledWith({
        where: { id: 'admin_target' },
        data: change,
        select: expect.objectContaining({ id: true, role: true, status: true }),
      });
      // Credential and session columns must never be selected for the response.
      const [{ select }] = mocks.userUpdate.mock.calls[0] as [{ select: Record<string, unknown> }];
      expect(select).not.toHaveProperty('password');
      expect(select).not.toHaveProperty('tokenVersion');
    }
  );

  describe.each([
    { role: 'ADMIN', status: 'INACTIVE' },
    { role: 'ADMIN', status: 'ON_LEAVE' },
    { role: 'EMPLOYEE', status: 'ACTIVE' },
  ])('when the target starts as $status $role', (initial) => {
    it.each(['demote', 'deactivate', 'layoff'] as const)(
      'rechecks the member before a delayed %s can remove the last active admin',
      async (operation) => {
        const users = new Map([
          ['admin_actor', { id: 'admin_actor', role: 'ADMIN', status: 'ACTIVE' }],
          ['admin_target', { id: 'admin_target', ...initial }],
        ]);
        let firstTransaction = true;
        const raceDb: TeamDb = {
          ...db,
          user: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
              ...users.get(where.id)!,
              name: 'Admin',
              email: 'admin@example.test',
            })),
            count: vi.fn(
              async () =>
                [...users.values()].filter((u) => u.role === 'ADMIN' && u.status === 'ACTIVE')
                  .length
            ),
            update: vi.fn(async ({ where, data }) => {
              const updated = { ...users.get(where.id)!, ...data };
              users.set(where.id, updated);
              return updated;
            }),
          },
          $transaction: async (run) => {
            if (firstTransaction) {
              firstTransaction = false;
              // Another request promotes/reactivates B and demotes A before the
              // delayed request starts its transaction. An earlier snapshot of B
              // must not let that request skip the last-admin guard.
              await caller(raceDb).adminUpdateMember({
                id: 'admin_target',
                role: 'ADMIN',
                status: 'ACTIVE',
              });
              await caller(raceDb).adminUpdateMember({ id: 'admin_actor', role: 'EMPLOYEE' });
            }
            return run(raceDb);
          },
        };

        const request =
          operation === 'layoff'
            ? caller(raceDb).layOffMember({ id: 'admin_target', reason: 'Position eliminated' })
            : caller(raceDb).adminUpdateMember({
                id: 'admin_target',
                ...(operation === 'demote'
                  ? { role: 'EMPLOYEE' as const }
                  : { status: 'INACTIVE' as const }),
              });

        await expect(request).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message:
            operation === 'layoff'
              ? 'You cannot lay off the last active admin'
              : 'Cannot demote or deactivate the last active admin.',
        });
        expect(
          [...users.values()].filter((u) => u.role === 'ADMIN' && u.status === 'ACTIVE')
        ).toEqual([{ id: 'admin_target', role: 'ADMIN', status: 'ACTIVE' }]);
        expect(mocks.sendEmail).not.toHaveBeenCalled();
      }
    );
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
        let release: (() => void) | undefined;
        const tx: TeamDb = {
          ...concurrentDb,
          // Only the row lock serializes transactions; opening one alone must
          // not make the concurrency test pass without a locking query.
          $queryRaw: vi.fn(async () => {
            const prior = transactionTail;
            transactionTail = new Promise<void>((resolve) => (release = resolve));
            await prior;
            return [{ id: 'org_a' }];
          }),
        };
        try {
          return await run(tx);
        } finally {
          release?.();
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
