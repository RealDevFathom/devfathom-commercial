import type { ScopedDb } from '@/lib/db';
import { readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';

export type PharmacyBranchComparisonInput = {
  branches: readonly { id: string; name: string }[];
  from: string;
  to: string;
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
  for (const branch of input.branches) {
    const report = await readPharmacyOwnerCommandCentre(db, {
      branchIds: [branch.id],
      from: input.from,
      to: input.to,
    });
    const demand = await db.unfulfilledDemandEvent.aggregate({
      where: {
        branchId: branch.id,
        createdAt: {
          gte: new Date(`${input.from}T00:00:00.000Z`),
          lt: new Date(new Date(`${input.to}T00:00:00.000Z`).getTime() + 86_400_000),
        },
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
