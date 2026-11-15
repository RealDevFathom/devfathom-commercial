import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';
import { workspaceDateRange } from '@/lib/timezone';

export type PharmacyBranchComparisonInput = {
  branches: readonly { id: string; name: string }[];
  from: string;
  to: string;
  /** Workspace zone: demand-event timestamps are bounded by its midnights (UTC when absent). */
  timeZone?: string | null;
};

/**
 * Owner-only branch comparison. Each branch is read independently because the khata ledger's
 * FORCE RLS policy requires a single active branch context. Lost demand is deliberately labelled
 * as an estimate and only sums values explicitly captured on POS unmet-demand events.
 */
export async function readPharmacyBranchComparison(
  db: ScopedDb,
  input: PharmacyBranchComparisonInput
) {
  const rows = [];
  const eventWindow = workspaceDateRange(input.from, input.to, input.timeZone);
  for (const branch of input.branches) {
    const report = await readPharmacyOwnerCommandCentre(db, {
      branchIds: [branch.id],
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
    });
    const demand = await db.unfulfilledDemandEvent.aggregate({
      where: {
        branchId: branch.id,
        createdAt: { gte: eventWindow.from, lt: eventWindow.to },
      },
      _sum: { estimatedValueMinor: true },
      _count: { _all: true },
    });
    rows.push({
      branchId: branch.id,
      branchName: branch.name,
      salesMinor: report.metrics.salesMinor,
      marginMinor: report.metrics.marginMinor,
      lostDemandEstimateMinor: demand._sum.estimatedValueMinor,
      lostDemandRecordedEvents: demand._count._all,
      expiryAtRiskMinor: report.metrics.expiryValueMinor30,
      khataAgingMinor: report.metrics.khataAgingMinor,
    });
  }
  return {
    label: 'Estimate' as const,
    estimateMethod: 'Sum of non-null values recorded on explicit POS unmet-demand events.',
    estimateExclusions: ['events without a recorded value', 'searches without an explicit event'],
    filters: { from: input.from, to: input.to },
    rows,
  };
}
