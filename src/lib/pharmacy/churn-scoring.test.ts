import { beforeEach, describe, expect, it, vi } from 'vitest';

type Run = { organizationId: string; businessDate: Date; customersScored: number };
const state = vi.hoisted(() => ({
  runs: [] as Run[],
  scores: [] as Array<Record<string, unknown>>,
  facts: new Map<string, Array<Record<string, unknown>>>(),
  organizations: [] as Array<{ id: string; timezone: string; status: string }>,
  branches: [] as Array<{ organizationId: string }>,
  tenantCalls: [] as string[],
  failFor: null as string | null,
}));

function tenantDb(organizationId: string) {
  return {
    $queryRaw: vi.fn(async (query: { strings: readonly string[]; values: unknown[] }) => {
      if (organizationId === state.failFor) throw new Error('boom');
      expect(query.values).toContain(organizationId);
      return state.facts.get(organizationId) ?? [];
    }),
    pharmacyCustomerChurnScore: {
      deleteMany: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        state.scores = state.scores.filter((row) => row.organizationId !== where.organizationId);
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.scores.push(...data);
        return { count: data.length };
      }),
    },
    pharmacyChurnScoringRun: {
      createMany: vi.fn(async ({ data }: { data: Run[] }) => {
        const [run] = data;
        const exists = state.runs.some(
          (row) =>
            row.organizationId === run!.organizationId &&
            row.businessDate.getTime() === run!.businessDate.getTime()
        );
        if (exists) return { count: 0 };
        state.runs.push({ ...run! });
        return { count: 1 };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { organizationId: string; businessDate: Date };
          data: { customersScored: number };
        }) => {
          const run = state.runs.find(
            (row) =>
              row.organizationId === where.organizationId &&
              row.businessDate.getTime() === where.businessDate.getTime()
          );
          if (run) run.customersScored = data.customersScored;
          return { count: run ? 1 : 0 };
        }
      ),
    },
  };
}

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: async (run: (db: unknown) => unknown) =>
    run({
      pharmacyBranch: {
        findMany: async () =>
          [...new Set(state.branches.map((b) => b.organizationId))].map((organizationId) => ({
            organizationId,
          })),
      },
      organization: {
        findMany: async ({
          where,
        }: {
          where: { id: { in: string[] }; status: { in: string[] } };
        }) =>
          state.organizations
            .filter((o) => where.id.in.includes(o.id) && where.status.in.includes(o.status))
            .map(({ id, timezone }) => ({ id, timezone })),
      },
      pharmacyChurnScoringRun: {
        findMany: async ({ where }: { where: { businessDate: { gte: Date } } }) =>
          state.runs.filter((run) => run.businessDate >= where.businessDate.gte),
      },
    }),
  withTenantDb: async (organizationId: string, run: (db: unknown) => unknown) => {
    state.tenantCalls.push(organizationId);
    const snapshot = { runs: state.runs.map((r) => ({ ...r })), scores: [...state.scores] };
    try {
      return await run(tenantDb(organizationId));
    } catch (error) {
      state.runs = snapshot.runs;
      state.scores = snapshot.scores;
      throw error;
    }
  },
}));

import { processDueChurnScoring, refreshOrganizationChurnScores } from './churn-scoring';

const now = new Date('2026-11-15T20:00:00Z'); // 01:00 on 16 Nov in Karachi.

beforeEach(() => {
  state.runs = [];
  state.scores = [];
  state.facts = new Map();
  state.organizations = [];
  state.branches = [];
  state.tenantCalls = [];
  state.failFor = null;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('refreshOrganizationChurnScores', () => {
  it('stores an RFM churn score per customer and branch from receipt facts only', async () => {
    state.scores = [{ organizationId: 'org-a', branchId: 'b1', customerId: 'stale' }];
    state.facts.set('org-a', [
      {
        branchId: 'b1',
        customerId: 'c-lapsed',
        lastCompletedAt: new Date(now.getTime() - 200 * 86_400_000),
        receiptCount: 1,
        monetaryMinor: BigInt(10_000),
      },
      {
        branchId: 'b2',
        customerId: 'c-loyal',
        lastCompletedAt: new Date(now.getTime() - 2 * 86_400_000),
        receiptCount: 15,
        monetaryMinor: BigInt(2_000_000),
      },
    ]);
    const db = tenantDb('org-a');
    const count = await refreshOrganizationChurnScores(db as never, 'org-a', now, '2026-11-16');
    expect(count).toBe(2);
    const sql = (db.$queryRaw.mock.calls[0]![0] as { strings: readonly string[] }).strings.join(
      '?'
    );
    expect(sql).toContain("s.status = 'COMPLETED'");
    expect(sql).toContain('pharmacy_sale_returns');
    expect(sql).not.toMatch(/pharmacy_sale_lines|medicine|prescription|patient/i);
    // Tenders are aggregated once per organization, not looked up per sale.
    expect(sql).not.toMatch(/LATERAL/i);
    expect(sql).toMatch(/GROUP BY pt\."branchId", pt\."saleId"/);
    expect(sql).toMatch(/pt\."businessDate" >= \?/);
    const values = (db.$queryRaw.mock.calls[0]![0] as { values: unknown[] }).values;
    expect(values).toContainEqual(new Date(now.getTime() - 395 * 86_400_000));
    expect(state.scores).toEqual([
      expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'b1',
        customerId: 'c-lapsed',
        score: 100,
        recencyScore: 1,
        daysSinceLastReceipt: 200,
        monetaryMinor: BigInt(10_000),
        businessDate: new Date('2026-11-16T00:00:00.000Z'),
        computedAt: now,
      }),
      expect.objectContaining({ branchId: 'b2', customerId: 'c-loyal', score: 0 }),
    ]);
  });
});

describe('processDueChurnScoring', () => {
  beforeEach(() => {
    state.branches = [{ organizationId: 'org-a' }, { organizationId: 'org-b' }];
    state.organizations = [
      { id: 'org-a', timezone: 'Asia/Karachi', status: 'ACTIVE' },
      { id: 'org-b', timezone: 'UTC', status: 'ACTIVE' },
      { id: 'org-c', timezone: 'UTC', status: 'ACTIVE' },
    ];
    state.facts.set('org-a', [
      {
        branchId: 'b1',
        customerId: 'c1',
        lastCompletedAt: new Date(now.getTime() - 100 * 86_400_000),
        receiptCount: 3,
        monetaryMinor: BigInt(200_000),
      },
    ]);
  });

  it('scores each pharmacy organization once per workspace business day', async () => {
    expect(await processDueChurnScoring(now)).toEqual({
      organizations: 2,
      customers: 1,
      failed: 0,
    });
    expect(state.runs).toEqual(
      [
        {
          organizationId: 'org-a',
          businessDate: new Date('2026-11-16T00:00:00Z'),
          customersScored: 1,
        },
        {
          organizationId: 'org-b',
          businessDate: new Date('2026-11-15T00:00:00Z'),
          customersScored: 0,
        },
      ].map((run) => expect.objectContaining(run))
    );
    // org-c has no pharmacy branch, so it is never scored.
    expect(state.tenantCalls).toEqual(['org-a', 'org-b']);

    state.tenantCalls = [];
    expect(await processDueChurnScoring(new Date(now.getTime() + 5 * 60_000))).toEqual({
      organizations: 0,
      customers: 0,
      failed: 0,
    });
    expect(state.tenantCalls).toEqual([]);

    // The next local night (UTC midnight) scores org-b again.
    expect(await processDueChurnScoring(new Date('2026-11-16T00:05:00Z'))).toMatchObject({
      organizations: 1,
    });
    expect(state.tenantCalls).toEqual(['org-b']);
  });

  it('skips suspended organizations', async () => {
    state.organizations[0]!.status = 'SUSPENDED';
    await processDueChurnScoring(now);
    expect(state.tenantCalls).toEqual(['org-b']);
  });

  it('does not rescore when another worker already claimed the day', async () => {
    state.runs.push({
      organizationId: 'org-a',
      businessDate: new Date('2026-11-16T00:00:00Z'),
      customersScored: 4,
    });
    expect(await processDueChurnScoring(now)).toMatchObject({ organizations: 1 });
    expect(state.tenantCalls).toEqual(['org-b']);
  });

  it('rolls back a failed organization so the next tick retries it', async () => {
    state.failFor = 'org-a';
    expect(await processDueChurnScoring(now)).toEqual({
      organizations: 1,
      customers: 0,
      failed: 1,
    });
    expect(state.runs.map((run) => run.organizationId)).toEqual(['org-b']);
    state.failFor = null;
    state.tenantCalls = [];
    expect(await processDueChurnScoring(now)).toMatchObject({ organizations: 1, customers: 1 });
    expect(state.tenantCalls).toEqual(['org-a']);
  });
});
