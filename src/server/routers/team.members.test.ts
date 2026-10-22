import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  can: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(),
  sendEmail: vi.fn(),
  templates: {
    accountDeactivated: vi.fn(() => ({ subject: 'Deactivated', html: '', text: '' })),
  },
}));
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
    mocks.can.mockResolvedValue(true);
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
      async ({ where }: { where: { organizationId: string; id: { not: string } } }) =>
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
    for (const [query, organizationId] of mocks.queryRaw.mock.calls) {
      const sql = Array.isArray(query) ? query.join('?') : String(query?.sql ?? query);
      expect(sql).toContain('FROM "users"');
      expect(sql).toContain('WHERE "organizationId" = ?');
      expect(sql).toContain('ORDER BY "id"');
      expect(sql).toContain('FOR UPDATE');
      expect(organizationId).toBe('org_a');
    }
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        id: { not: expect.any(String) },
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    for (const [{ where }] of mocks.update.mock.calls) {
      expect(where).toMatchObject({ organizationId: 'org_a' });
    }
  });

  it('shares the admin lock with layoff so the two endpoints cannot remove every admin', async () => {
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
      email: `${where.id}@example.test`,
      role: 'ADMIN',
      status: 'ACTIVE',
    }));
    mocks.count.mockImplementation(
      async ({ where }: { where: { id: { not: string } } }) =>
        [...activeAdmins].filter((adminId) => adminId !== where.id.not).length
    );
    mocks.update.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: { role?: string; status?: string } }) => {
        activeAdmins.delete(where.id);
        return {
          id: where.id,
          name: where.id,
          email: `${where.id}@example.test`,
          role: data.role ?? 'ADMIN',
          status: data.status ?? 'ACTIVE',
        };
      }
    );

    const results = await Promise.allSettled([
      caller().adminUpdateMember({ id: 'admin_a', role: 'EMPLOYEE' }),
      caller().layOffMember({ id: 'admin_b', reason: 'Role eliminated' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(activeAdmins.size).toBe(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('refuses to remove the only active admin inside the transaction', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'admin_actor',
      name: 'Only Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    mocks.count.mockResolvedValue(0);

    await expect(
      caller().adminUpdateMember({ id: 'admin_actor', status: 'INACTIVE' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote or deactivate the last active admin.',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        id: { not: 'admin_actor' },
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('fails closed when current-role layoff authorization is denied', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'admin_b',
      name: 'Protected Admin',
      email: 'admin_b@example.test',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    mocks.can.mockResolvedValue(false);

    await expect(
      caller().layOffMember({ id: 'admin_b', reason: 'Role eliminated' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to lay off this member.',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.any(Object),
      'team:layoff',
      { type: 'User', targetRole: 'ADMIN' },
      { source: 'TRPC', db }
    );
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not count an inactive admin as the last active admin', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'admin_old',
      name: 'Former Admin',
      role: 'ADMIN',
      status: 'INACTIVE',
    });
    mocks.update.mockResolvedValue({
      id: 'admin_old',
      name: 'Former Admin',
      role: 'EMPLOYEE',
      status: 'INACTIVE',
    });

    await expect(
      caller().adminUpdateMember({ id: 'admin_old', role: 'EMPLOYEE' })
    ).resolves.toMatchObject({ role: 'EMPLOYEE' });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'admin_old', organizationId: 'org_a' } })
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'admin_old', organizationId: 'org_a' },
      data: { role: 'EMPLOYEE' },
    });
  });
});
