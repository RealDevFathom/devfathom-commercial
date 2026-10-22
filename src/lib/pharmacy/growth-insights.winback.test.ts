import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { listGrowthInsights, reviewGrowthInsight, type GrowthInsightRow } from './growth-insights';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'Asia/Karachi',
};
const snapshot = {
  vertical: 'PHARMACY' as const,
  current: { from: '2026-09-01T00:00:00.000Z', cutoff: '2026-10-01T00:00:00.000Z' },
  comparison: { from: '2026-08-01T00:00:00.000Z', cutoff: '2026-09-01T00:00:00.000Z' },
  currency: 'PKR' as const,
  facts: [
    {
      ref: 'e1',
      metric: 'receipt_count' as const,
      value: '20',
      period: 'CURRENT' as const,
      cohortSize: 10,
      coverage: 'COMPLETE' as const,
      freshAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  actions: [{ ref: 'a1', kind: 'RETAIL_REVIEW' as const }],
};
const output = {
  recommendations: [
    {
      evidenceRefs: ['e1'],
      actionRef: 'a1',
      hypothesis: 'REVIEW_RETAIL' as const,
      limitations: ['OBSERVATIONAL' as const],
    },
  ],
};
const insight: GrowthInsightRow = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'READY',
  failureCode: null,
  provider: 'google',
  model: 'fixture-model',
  inputHash: 'hash',
  schemaVersion: 1,
  snapshot,
  output,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
};

function values(call: unknown[]): unknown[] {
  return (call[0] as { values: unknown[] }).values;
}

describe('pharmacy winback persistence boundaries', () => {
  it('uses organization and branch predicates on every history read', async () => {
    const query = vi.fn().mockResolvedValueOnce([insight]).mockResolvedValueOnce([]);
    await listGrowthInsights({ $queryRaw: query } as unknown as ScopedDb, scope);

    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) {
      expect(values(call)).toEqual(expect.arrayContaining(['org-a', 'branch-a']));
      expect(values(call)).not.toContain('org-b');
    }
  });

  it('cannot return another organization row even when its id is known', async () => {
    const query = vi.fn().mockImplementation((sql: { values: unknown[] }) => {
      if (!sql.values.includes('org-a')) throw new Error('missing tenant predicate');
      return [];
    });
    const result = await listGrowthInsights({ $queryRaw: query } as unknown as ScopedDb, scope);
    expect(result).toEqual({ insights: [], reviews: [] });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('replays the same terminal review without creating a second campaign or audit decision', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([insight])
      .mockResolvedValueOnce([
        { decision: 'REJECT', campaignId: null, settings: null },
      ]);
    const execute = vi.fn();
    const db = { $queryRaw: query, $executeRaw: execute } as unknown as ScopedDb;
    const request = {
      branchId: 'branch-a',
      insightId: insight.id,
      recommendation: 0,
      decision: 'REJECT' as const,
    };

    await expect(
      reviewGrowthInsight(db, scope, request, new Date('2026-10-02T00:00:00.000Z'))
    ).resolves.toEqual({ decision: 'REJECT', campaignId: null, replay: true });
    expect(execute).not.toHaveBeenCalled();
    expect(values(query.mock.calls[0]!)).toEqual(
      expect.arrayContaining(['org-a', 'branch-a', insight.id])
    );
    expect(values(query.mock.calls[1]!)).toEqual(
      expect.arrayContaining(['org-a', 'branch-a', insight.id])
    );
  });

  it('rejects a cross-branch review before reading or writing', async () => {
    const query = vi.fn();
    const execute = vi.fn();
    await expect(
      reviewGrowthInsight(
        { $queryRaw: query, $executeRaw: execute } as unknown as ScopedDb,
        scope,
        {
          branchId: 'branch-b',
          insightId: insight.id,
          recommendation: 0,
          decision: 'REJECT',
        }
      )
    ).rejects.toThrow('Branch mismatch');
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
