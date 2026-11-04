/**
 * #424 regression for batched tRPC mutations. The HTTP handler runs every
 * mutation of a batch concurrently inside ONE tenant transaction, and the real
 * `withTenantDb` facade makes nested `$transaction` calls reuse it. The
 * organization row lock is therefore already held by every sibling, so only
 * in-process serialization of the guard-and-update section keeps an admin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Member = { id: string; name: string; email: string; role: string; status: string };

const state = vi.hoisted(() => ({ users: new Map<string, Member>() }));

// The pg-backed interactive transaction: one client, async round trips, and a
// row lock that is re-entrant for the transaction that already holds it.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const fakeTx = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(fakeTx),
  },
}));
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
  sendEmail: vi.fn(),
  templates: {
    accountDeactivated: vi.fn(() => ({ subject: 'subject', html: 'html', text: 'text' })),
  },
}));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import { teamRouter } from './team';

const activeAdmins = () =>
  [...state.users.values()].filter((u) => u.role === 'ADMIN' && u.status === 'ACTIVE');

Object.assign(fakeTx, {
  $queryRawUnsafe: async () => {
    await tick();
    return [];
  },
  // Already owned by this transaction: never blocks a sibling in the batch.
  $queryRaw: async () => {
    await tick();
    return [{ id: 'org_a' }];
  },
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      await tick();
      const user = state.users.get(where.id);
      return user ? { ...user } : null;
    },
    count: async () => {
      await tick();
      return activeAdmins().length;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Member> }) => {
      await tick();
      const updated = { ...state.users.get(where.id)!, ...data };
      state.users.set(where.id, updated);
      return updated;
    },
  },
});

function caller(db: ScopedDb, userId: string) {
  return teamRouter.createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats: 2, seatLimit: 10 },
    session: {
      expires: 'later',
      user: {
        id: userId,
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

describe('team last-admin guard inside one batched tenant transaction', () => {
  beforeEach(() => {
    state.users = new Map(
      ['admin_a', 'admin_b'].map((id) => [
        id,
        { id, name: id, email: `${id}@example.test`, role: 'ADMIN', status: 'ACTIVE' },
      ])
    );
  });

  it.each([
    {
      name: 'two demotions',
      run: (db: ScopedDb) => [
        caller(db, 'admin_a').adminUpdateMember({ id: 'admin_a', role: 'EMPLOYEE' }),
        caller(db, 'admin_a').adminUpdateMember({ id: 'admin_b', role: 'EMPLOYEE' }),
      ],
    },
    {
      name: 'a deactivation and a demotion',
      run: (db: ScopedDb) => [
        caller(db, 'admin_a').adminUpdateMember({ id: 'admin_b', status: 'INACTIVE' }),
        caller(db, 'admin_a').adminUpdateMember({ id: 'admin_a', role: 'EMPLOYEE' }),
      ],
    },
    {
      name: 'a layoff and a demotion',
      run: (db: ScopedDb) => [
        caller(db, 'admin_a').layOffMember({ id: 'admin_b', reason: 'Position eliminated' }),
        caller(db, 'admin_a').adminUpdateMember({ id: 'admin_a', role: 'EMPLOYEE' }),
      ],
    },
  ])('keeps one active admin when a batch runs $name', async ({ run }) => {
    const results = await withTenantDb('org_a', async (db) => Promise.allSettled(run(db)), {
      skipDrain: true,
    });

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'BAD_REQUEST' });
    expect(activeAdmins()).toHaveLength(1);
  });
});
