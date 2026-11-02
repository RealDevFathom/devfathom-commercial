import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real root/router/actions/service; only identity, capability and DB adapters are
// doubles. This is source integration coverage, not PostgreSQL or model proof.
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  db: vi.fn(),
  entitlements: vi.fn(),
  can: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/scoped-db', async () => ({
  ...(await vi.importActual<typeof import('@/lib/tenancy/scoped-db')>('@/lib/tenancy/scoped-db')),
  createTenantDb: mocks.db,
}));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  resolveOrganizationEntitlements: mocks.entitlements,
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

import { appRouter } from './_app';
import {
  listGrowth,
  loadGrowthReview,
  generateGrowth,
  submitGrowthReview,
} from '@/app/(app)/restaurant/growth/actions';

const query = vi.fn();
let enabledModules: string[];
let session: { user: { id: string; organizationId: string; role: string; status: string } } | null;
beforeEach(() => {
  vi.clearAllMocks();
  enabledModules = ['restaurant-core', 'restaurant-pos'];
  session = {
    user: { id: 'user-a', organizationId: 'org-a', role: 'ADMIN', status: 'ACTIVE' },
  };
  mocks.actor.mockImplementation(async () => ({
    session,
    organization: { id: 'org-a', vertical: 'RESTAURANT', isDemo: false },
  }));
  mocks.entitlements.mockImplementation(async () => ({ enabledModules, modules: [] }));
  mocks.can.mockResolvedValue(true);
  query.mockResolvedValue([]);
  const db = {
    organization: { findFirst: vi.fn(async () => ({ vertical: 'RESTAURANT' })) },
    restaurantBranch: { findFirst: vi.fn(async () => ({ id: 'branch-a' })) },
    $queryRawUnsafe: query,
  };
  mocks.db.mockReturnValue({
    ...db,
    $transaction: async (run: (tx: typeof db) => unknown) => run(db),
  });
});

describe('composed Restaurant growth entry points', () => {
  it('registers only list/generate/read/review under the root', () => {
    expect(
      Object.keys(appRouter._def.procedures).filter((name) => name.startsWith('restaurantGrowth.'))
    ).toEqual([
      'restaurantGrowth.list',
      'restaurantGrowth.generate',
      'restaurantGrowth.read',
      'restaurantGrowth.review',
    ]);
  });
  it('creates fresh context for server actions and reaches the scoped service', async () => {
    await expect(listGrowth({ branchId: 'branch-a' })).resolves.toEqual({
      status: 'AVAILABLE',
      items: [],
      truncated: false,
    });
    await expect(
      loadGrowthReview({ branchId: 'branch-a', insightId: 'insight-a' })
    ).resolves.toEqual({ status: 'NOT_FOUND' });
    expect(mocks.actor).toHaveBeenCalledTimes(2);
    expect(mocks.db).toHaveBeenCalledWith('org-a', 'user-a');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('app.current_branch_id'),
      'branch-a'
    );
  });
  it.each([
    'missing session',
    'inactive session',
    'missing core',
    'missing POS',
    'missing capability',
  ])('denies read for %s without reading insight SQL', async (state) => {
    if (state === 'missing session') session = null;
    if (state === 'inactive session') session!.user.status = 'INACTIVE';
    if (state === 'missing core') enabledModules = ['restaurant-pos'];
    if (state === 'missing POS') enabledModules = ['restaurant-core'];
    if (state === 'missing capability') mocks.can.mockResolvedValue(false);
    await expect(
      loadGrowthReview({ branchId: 'branch-a', insightId: 'insight-a' })
    ).resolves.toEqual({ status: 'DENIED' });
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects generation before evidence reads when configuration permission is absent', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');
    await expect(
      generateGrowth({
        branchId: 'branch-a',
        from: '2026-10-01',
        to: '2026-10-02',
        requestId: '11111111-1111-4111-8111-111111111111',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Restaurant growth write gate', () => {
  const generateInput = {
    branchId: 'branch-a',
    from: '2026-10-01',
    to: '2026-10-02',
    requestId: '11111111-1111-4111-8111-111111111111',
  };
  const reviewInput = {
    branchId: 'branch-a',
    insightId: 'insight-a',
    recommendation: 0,
    expectedHash: 'a'.repeat(64),
    expectedVersion: 1 as const,
    expectedRevision: 0,
    requestId: '22222222-2222-4222-8222-222222222222',
    decision: 'APPROVE' as const,
    settings: { priority: 'NORMAL' as const, objective: 'REVIEW_RETENTION' as const },
  };
  const writes: Array<[string, () => Promise<unknown>]> = [
    ['generate', () => generateGrowth(generateInput)],
    ['review', () => submitGrowthReview(reviewInput)],
  ];

  it.each(
    writes.flatMap(([name, run]) =>
      ['restaurant:configure', 'reports:financial'].map((missing) => [name, missing, run] as const)
    )
  )('%s is FORBIDDEN without %s and opens no transaction', async (_name, missing, run) => {
    session!.user.role = 'EMPLOYEE';
    mocks.can.mockImplementation(async (_subject, action) => action !== missing);
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(writes)('%s denies an unprivileged staff role by default', async (_name, run) => {
    session!.user.role = 'EMPLOYEE';
    mocks.can.mockResolvedValue(false);
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(writes)(
    '%s lets a growth manager past the gate into the scoped service',
    async (_name, run) => {
      mocks.can.mockResolvedValue(true);
      const outcome = await run().catch((error: unknown) => error);
      expect(outcome).not.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.can).toHaveBeenCalledWith(
        expect.anything(),
        'restaurant:configure',
        undefined,
        expect.anything()
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('app.current_branch_id'),
        'branch-a'
      );
    }
  );
});
