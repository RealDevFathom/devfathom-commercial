import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import type { TRPCContext } from '../trpc';
import { teamRouter } from './team';

type TeamDb = {
  user: {
    findUnique: typeof mocks.findUnique;
    count: typeof mocks.count;
    update: typeof mocks.update;
  };
  $queryRaw: typeof mocks.queryRaw;
  $transaction: (fn: (tx: TeamDb) => Promise<unknown>) => Promise<unknown>;
};

const db: TeamDb = {
  user: { findUnique: mocks.findUnique, count: mocks.count, update: mocks.update },
  $queryRaw: mocks.queryRaw,
  $transaction: (fn) => fn(db),
};

function caller() {
  return teamRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['hr'],
      modules: [{ key: 'hr', name: 'HR', enabled: true }],
      activeSeats: 2,
      seatLimit: 10,
    },
    session: {
      expires: 'later',
      user: {
        id: 'admin_actor',
        organizationId: 'org_a',
        role: 'ADMIN',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: { id: 'org_a', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('team.adminUpdateMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction = (fn) => fn(db);
  });

  it('preserves one active admin when two demotions race', async () => {
    const activeAdmins = new Set(['admin_a', 'admin_b']);
    let transactionTail = Promise.resolve();

    db.$transaction = async (fn) => {
      const previousTransaction = transactionTail;
      let releaseTransaction!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      await previousTransaction;
      try {
        return await fn(db);
      } finally {
        releaseTransaction();
      }
    };
    mocks.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      name: where.id,
      role: 'ADMIN',
      status: 'ACTIVE',
    }));
    mocks.count.mockImplementation(
      async ({ where }: { where: { id: { not: string } } }) =>
        [...activeAdmins].filter((adminId) => adminId !== where.id.not).length
    );
    mocks.update.mockImplementation(async ({ where }: { where: { id: string } }) => {
      activeAdmins.delete(where.id);
      return { id: where.id, name: where.id, role: 'EMPLOYEE', status: 'ACTIVE' };
    });

    const results = await Promise.allSettled([
      caller().adminUpdateMember({ id: 'admin_a', role: 'EMPLOYEE' }),
      caller().adminUpdateMember({ id: 'admin_b', role: 'EMPLOYEE' }),
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
});
