import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';
import { pharmacyBusinessDayRange, pharmacyDayEndHourField } from '@/lib/pharmacy/business-day';

export type PharmacyBranchComparisonInput = {
  /** DEV-958A: each branch's day-end hour bounds its own days (midnight when absent). */
  branches: readonly { id: string; name: string; businessDayEndsAtHour?: number | null }[];
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
  for (const branch of input.branches) {
    // DEV-958A: each branch is read on its own business days.
    const clock = { timeZone: input.timeZone, dayEndsAtHour: branch.businessDayEndsAtHour };
    const eventWindow = pharmacyBusinessDayRange(input.from, input.to, clock);
    const report = await readPharmacyOwnerCommandCentre(db, {
      branchIds: [branch.id],
      from: input.from,
      to: input.to,
      timeZone: input.timeZone,
      ...pharmacyDayEndHourField(branch.businessDayEndsAtHour),
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
