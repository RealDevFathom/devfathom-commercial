import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  sendEmail: vi.fn(),
  can: vi.fn(async () => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: ['hr'] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(),
  sendEmail: mocks.sendEmail,
  templates: {
    accountDeactivated: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
  },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { teamRouter } from './team';

type LayoffDb = {
  user: {
    findUnique: typeof mocks.findUnique;
    count: typeof mocks.count;
    update: typeof mocks.update;
  };
  $queryRaw: typeof mocks.queryRaw;
  $transaction: (run: (tx: LayoffDb) => Promise<unknown>) => Promise<unknown>;
};

const db: LayoffDb = {
  user: { findUnique: mocks.findUnique, count: mocks.count, update: mocks.update },
  $queryRaw: mocks.queryRaw,
  $transaction: (run) => run(db),
};

function caller() {
  return teamRouter.createCaller({
    db,
    entitlements: { enabledModules: ['hr'], modules: [], activeSeats: 2, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: 'admin_actor',
        name: 'Admin Actor',
        organizationId: 'org_a',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_a', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('team.layOffMember active-admin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction = (run) => run(db);
    mocks.can.mockResolvedValue(true);
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      name: where.id,
      email: `${where.id}@example.com`,
      role: 'ADMIN',
      status: 'ACTIVE',
    }));
    mocks.update.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      name: where.id,
      status: 'INACTIVE',
    }));
  });

  it('preserves one active admin when two lay-offs race', async () => {
    const activeAdmins = new Set(['admin_a', 'admin_b']);
    let transactionTail = Promise.resolve();

    db.$transaction = async (run) => {
      const previousTransaction = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previousTransaction;
      try {
        return await run(db);
      } finally {
        releaseTransaction();
      }
    };
    mocks.count.mockImplementation(
      async ({ where }: { where: { id: { not: string } } }) =>
        [...activeAdmins].filter((adminId) => adminId !== where.id.not).length
    );
    mocks.update.mockImplementation(async ({ where }: { where: { id: string } }) => {
      activeAdmins.delete(where.id);
      return { id: where.id, name: where.id, status: 'INACTIVE' };
    });

    const results = await Promise.allSettled([
      caller().layOffMember({ id: 'admin_a', reason: 'Position removed' }),
      caller().layOffMember({ id: 'admin_b', reason: 'Position removed' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(activeAdmins.size).toBe(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of mocks.queryRaw.mock.calls) {
      const sql = Array.isArray(query) ? query.join('?') : String(query?.sql ?? query);
      expect(sql).toContain('FROM "users"');
      expect(sql).toContain('FOR UPDATE');
    }
  });

  it('does not take the active-admin lock for a non-admin lay-off', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'employee_a',
      name: 'Employee A',
      email: 'employee_a@example.com',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });

    await expect(
      caller().layOffMember({ id: 'employee_a', reason: 'Position removed' })
    ).resolves.toMatchObject({ status: 'INACTIVE' });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });
});
