import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({ report: vi.fn(), draft: vi.fn() }));
vi.mock('./marketing-report', () => ({
  readPharmacyMarketingReport: mocks.report,
  readPharmacyMarketingReportWindow: mocks.report,
}));
vi.mock('./marketing-service', async () => {
  const { z } = await import('zod');
  return {
    MarketingWorkflowError: class MarketingWorkflowError extends Error {},
    marketingDraftInput: z.any(),
    createMarketingDraft: mocks.draft,
  };
});
import { buildPharmacyGrowthInput, growthPeriods, reviewGrowthInsight } from './growth-insights';

const scope = {
  organizationId: 'org-synthetic',
  branchId: 'branch-synthetic',
  actorId: 'actor-synthetic',
  timezone: 'UTC',
};
// Sub-day bounds skip the Meta report path; only receipt/consent/loyalty/inventory reads run.
const from = new Date('2026-09-01T06:00:00Z');
const cutoff = new Date('2026-10-01T06:00:00Z');
const now = new Date('2026-10-02T00:00:00Z');

type Rows = {
  loyalty?: number;
  wastage?: { movements: number; posted: number; reversed: number; amount: string };
  valuation?: { lots: number; value: string };
};
function fakeDb(rows: Rows) {
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn(async (query: Prisma.Sql) => {
    queries.push(query);
    const sql = query.sql;
    if (sql.includes("purpose='LOYALTY'")) return [{ count: rows.loyalty ?? 0 }];
    if (sql.includes("'PHARMACY_STOCK_WRITE_OFF'"))
      return [rows.wastage ?? { movements: 0, posted: 0, reversed: 0, amount: '0' }];
    if (sql.includes('HAVING SUM')) return [rows.valuation ?? { lots: 0, value: '0' }];
    if (sql.includes("purpose='MARKETING'")) return [{ count: 0 }];
    return [{ receipts: 0, cohort: 0, posted: 0, sales: '0', margin: '0' }];
  });
  return { db: { $queryRaw } as unknown as ScopedDb, queries };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('pharmacy loyalty and inventory-cost growth evidence', () => {
  it('publishes aggregate loyalty, posted wastage and estimated valuation with review actions', async () => {
    const { db, queries } = fakeDb({
      loyalty: 14,
      wastage: { movements: 12, posted: 12, reversed: 0, amount: '45000' },
      valuation: { lots: 30, value: '1250000' },
    });
    const input = await buildPharmacyGrowthInput(db, scope, from, cutoff, now);
    const byMetric = (metric: string) => input.facts.filter((f) => f.metric === metric);
    expect(byMetric('loyalty_eligible_count')).toHaveLength(2);
    expect(byMetric('loyalty_eligible_count')[0]).toMatchObject({
      value: '14',
      cohortSize: 14,
      coverage: 'COMPLETE',
    });
    expect(byMetric('wastage_minor')[0]).toMatchObject({
      value: '45000',
      cohortSize: 12,
      coverage: 'COMPLETE',
    });
    expect(byMetric('inventory_value_minor')[0]).toMatchObject({
      value: '1250000',
      cohortSize: 30,
      coverage: 'ESTIMATED',
    });
    expect(new Set(input.facts.map((f) => f.period))).toEqual(new Set(['CURRENT', 'COMPARISON']));
    expect(new Set(input.facts.map((f) => f.ref)).size).toBe(input.facts.length);
    expect(input.actions).toEqual([
      { ref: 'a1', kind: 'RETAIL_REVIEW' },
      { ref: 'a2', kind: 'LOYALTY_REVIEW' },
      { ref: 'a3', kind: 'INVENTORY_COST_REVIEW' },
    ]);
    // No identifiers or scope values cross into the model input.
    expect(JSON.stringify(input)).not.toMatch(/org-synthetic|branch-synthetic|actor-synthetic/);
    // Every new read is tenant- and branch-scoped.
    for (const marker of ["purpose='LOYALTY'", "'PHARMACY_STOCK_WRITE_OFF'", 'HAVING SUM']) {
      const query = queries.find((q) => q.sql.includes(marker))!;
      expect(query.values).toContain(scope.organizationId);
      expect(query.values).toContain(scope.branchId);
    }
  });

  it('withholds small loyalty, wastage and valuation cohorts and offers only retail review', async () => {
    const { db } = fakeDb({
      loyalty: 9,
      wastage: { movements: 9, posted: 9, reversed: 0, amount: '777' },
      valuation: { lots: 9, value: '888' },
    });
    const input = await buildPharmacyGrowthInput(db, scope, from, cutoff, now);
    expect(input.facts).toEqual([]);
    expect(input.actions).toEqual([{ ref: 'a1', kind: 'RETAIL_REVIEW' }]);
    expect(JSON.stringify(input)).not.toMatch(/777|888/);
  });

  it.each([
    { movements: 12, posted: 11, reversed: 0, amount: '45000' },
    { movements: 12, posted: 12, reversed: 1, amount: '45000' },
  ])('never publishes wastage money with incomplete posting coverage %j', async (wastage) => {
    const { db } = fakeDb({ wastage });
    const input = await buildPharmacyGrowthInput(db, scope, from, cutoff, now);
    expect(input.facts.some((f) => f.metric === 'wastage_minor')).toBe(false);
    expect(input.actions).toEqual([{ ref: 'a1', kind: 'RETAIL_REVIEW' }]);
  });

  it('counts customers who earned on a khata repayment in the loyalty cohort (DEV-746)', async () => {
    const { db, queries } = fakeDb({ loyalty: 10 });
    await buildPharmacyGrowthInput(db, scope, from, cutoff, now);
    const loyalty = queries.find((q) => q.sql.includes("purpose='LOYALTY'"))!;
    expect(loyalty.sql).toContain("l.kind IN ('EARN','KHATA_EARN')");
  });

  it('offers inventory review from valuation alone', async () => {
    const { db } = fakeDb({ valuation: { lots: 10, value: '5000' } });
    const input = await buildPharmacyGrowthInput(db, scope, from, cutoff, now);
    expect(input.actions).toEqual([
      { ref: 'a1', kind: 'RETAIL_REVIEW' },
      { ref: 'a2', kind: 'INVENTORY_COST_REVIEW' },
    ]);
  });
});

describe('pharmacy loyalty and inventory-cost review guardrails', () => {
  const insightId = '00000000-0000-4000-8000-000000000731';
  const snapshot = {
    vertical: 'PHARMACY',
    currency: 'PKR',
    current: { from: '2026-09-01T00:00:00Z', cutoff: '2026-10-01T00:00:00Z' },
    comparison: { from: '2026-08-01T00:00:00Z', cutoff: '2026-09-01T00:00:00Z' },
    facts: [
      {
        ref: 'e1',
        metric: 'loyalty_eligible_count',
        value: '14',
        period: 'CURRENT',
        cohortSize: 14,
        coverage: 'COMPLETE',
        freshAt: '2026-10-01T00:00:00Z',
      },
      {
        ref: 'e2',
        metric: 'wastage_minor',
        value: '45000',
        period: 'CURRENT',
        cohortSize: 12,
        coverage: 'COMPLETE',
        freshAt: '2026-10-01T00:00:00Z',
      },
    ],
    actions: [
      { ref: 'a1', kind: 'RETAIL_REVIEW' },
      { ref: 'a2', kind: 'LOYALTY_REVIEW' },
      { ref: 'a3', kind: 'INVENTORY_COST_REVIEW' },
    ],
  };
  const output = {
    recommendations: [
      {
        evidenceRefs: ['e1'],
        actionRef: 'a2',
        hypothesis: 'REVIEW_RETENTION',
        limitations: ['OBSERVATIONAL'],
      },
      {
        evidenceRefs: ['e2'],
        actionRef: 'a3',
        hypothesis: 'REVIEW_INVENTORY_COST',
        limitations: ['OBSERVATIONAL'],
      },
    ],
  };
  function reviewDb() {
    const $queryRaw = vi.fn(async (query: Prisma.Sql) =>
      query.sql.includes('FROM growth_insights')
        ? [{ id: insightId, status: 'READY', snapshot, output, createdAt: new Date() }]
        : []
    );
    const $executeRaw = vi.fn(async () => 1);
    return { db: { $queryRaw, $executeRaw } as unknown as ScopedDb, $executeRaw };
  }
  const edit = {
    name: 'Synthetic review',
    templateId: 'template-synthetic',
    scheduledAt: new Date(Date.now() + 86400000),
  };

  it.each([0, 1])(
    'refuses to create a campaign or save edits for review-only recommendation %i',
    async (recommendation) => {
      for (const decision of ['APPROVE', 'EDIT'] as const) {
        const { db, $executeRaw } = reviewDb();
        await expect(
          reviewGrowthInsight(db, scope, {
            branchId: scope.branchId,
            insightId,
            recommendation,
            decision,
            edit,
          })
        ).rejects.toThrow('review-only');
        expect($executeRaw).not.toHaveBeenCalled();
      }
      expect(mocks.draft).not.toHaveBeenCalled();
    }
  );

  it.each([0, 1])('records a human rejection without a campaign for %i', async (recommendation) => {
    const { db, $executeRaw } = reviewDb();
    await expect(
      reviewGrowthInsight(db, scope, {
        branchId: scope.branchId,
        insightId,
        recommendation,
        decision: 'REJECT',
      })
    ).resolves.toEqual({ decision: 'REJECT', campaignId: null, replay: false });
    expect($executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.draft).not.toHaveBeenCalled();
  });
});

describe('workspace-local growth periods', () => {
  const report = {
    contradictory: 0,
    delivered: 0,
    attribution: { excludedUnverifiedLinks: 0, recoveredSalesMinor: 0 },
  };

  it('reads Meta campaign evidence over exact Pakistan-time day bounds', async () => {
    mocks.report.mockResolvedValue(report);
    const { db } = fakeDb({});
    await buildPharmacyGrowthInput(
      db,
      { ...scope, timezone: 'Asia/Karachi' },
      new Date('2026-08-31T19:00:00Z'),
      new Date('2026-09-30T19:00:00Z'),
      now
    );
    expect(mocks.report).toHaveBeenCalledWith(db, scope.organizationId, [scope.branchId], {
      gte: new Date('2026-08-31T19:00:00Z'),
      lt: new Date('2026-09-30T19:00:00Z'),
    });
    expect(mocks.report).toHaveBeenCalledWith(db, scope.organizationId, [scope.branchId], {
      gte: new Date('2026-08-01T19:00:00Z'),
      lt: new Date('2026-08-31T19:00:00Z'),
    });
  });

  it('still skips the Meta report for sub-day bounds in the workspace zone', async () => {
    const { db } = fakeDb({});
    await buildPharmacyGrowthInput(db, { ...scope, timezone: 'Asia/Karachi' }, from, cutoff, now);
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('counts calendar days across daylight-saving changes and keeps elapsed limits otherwise', () => {
    const later = new Date('2027-01-01T00:00:00Z');
    // 8 March 2026 in New York lasts 23 hours.
    const shortDay = [new Date('2026-03-08T05:00:00Z'), new Date('2026-03-09T04:00:00Z')] as const;
    expect(growthPeriods(...shortDay, later, 'America/New_York')).toEqual({
      current: { from: '2026-03-08T05:00:00.000Z', cutoff: '2026-03-09T04:00:00.000Z' },
      comparison: { from: '2026-03-07T05:00:00.000Z', cutoff: '2026-03-08T05:00:00.000Z' },
    });
    expect(() => growthPeriods(...shortDay, later)).toThrow('one to ninety days');
    // 90 calendar days spanning the November fall-back last 90 days and one hour.
    expect(() =>
      growthPeriods(
        new Date('2026-09-01T04:00:00Z'),
        new Date('2026-11-30T05:00:00Z'),
        later,
        'America/New_York'
      )
    ).not.toThrow();
    expect(() =>
      growthPeriods(
        new Date('2026-09-01T04:00:00Z'),
        new Date('2026-12-01T05:00:00Z'),
        later,
        'America/New_York'
      )
    ).toThrow('one to ninety days');
    // A 23-hour window that is not local midnights stays too short.
    expect(() =>
      growthPeriods(
        new Date('2026-10-01T01:00:00Z'),
        new Date('2026-10-02T00:00:00Z'),
        later,
        'Asia/Karachi'
      )
    ).toThrow('one to ninety days');
  });
});
