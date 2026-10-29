import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DAY = 86_400_000;

export type StaffingFootfallConfig = {
  /** Configurable planning assumption, not an asserted service-capacity fact. */
  receiptsPerStaffHour: number;
  minimumSuggestedStaff: number;
};

export type StaffingFootfallInput = StaffingFootfallConfig & {
  branchId: string;
  from: string;
  to: string;
};

export function validateStaffingFootfallInput(input: StaffingFootfallInput) {
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T00:00:00.000Z`);
  if (
    !input.branchId ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.toISOString().slice(0, 10) !== input.from ||
    to.toISOString().slice(0, 10) !== input.to ||
    from > to ||
    to.getTime() - from.getTime() >= 90 * DAY
  )
    throw new Error('Use valid UTC dates spanning at most 90 days for one authorized branch.');
  if (!Number.isInteger(input.receiptsPerStaffHour) || input.receiptsPerStaffHour < 1)
    throw new Error('Receipts per staff hour must be a positive whole number.');
  if (!Number.isInteger(input.minimumSuggestedStaff) || input.minimumSuggestedStaff < 0)
    throw new Error('Minimum suggested staff must be a non-negative whole number.');
  return { from, toExclusive: new Date(to.getTime() + DAY) };
}

export function calculateStaffingFootfall(
  completedAt: readonly Date[],
  days: number,
  config: StaffingFootfallConfig
) {
  const counts = Array.from({ length: 24 }, () => 0);
  for (const timestamp of completedAt) counts[timestamp.getUTCHours()] += 1;
  return counts.map((receiptCount, hourUtc) => {
    const averageReceipts = receiptCount / days;
    return {
      hourUtc,
      receiptCount,
      averageReceipts,
      suggestedStaff: Math.max(
        config.minimumSuggestedStaff,
        Math.ceil(averageReceipts / config.receiptsPerStaffHour)
      ),
    };
  });
}

/** Read-only receipt proxy. A receipt is an observed visit, not measured door footfall. */
export async function readStaffingFootfall(
  db: ScopedDb,
  organizationId: string,
  input: StaffingFootfallInput
) {
  const period = validateStaffingFootfallInput(input);
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId,
      branchId: input.branchId,
      status: 'COMPLETED',
      receiptNumber: { not: null },
      completedAt: { gte: period.from, lt: period.toExclusive },
    },
    select: { completedAt: true },
  });
  const completedAt = sales.flatMap((sale) => (sale.completedAt ? [sale.completedAt] : []));
  const days = Math.round((period.toExclusive.getTime() - period.from.getTime()) / DAY);
  return {
    period: { from: input.from, to: input.to, timezone: 'UTC' as const, days },
    method: 'COMPLETED_RECEIPTS_BY_UTC_HOUR' as const,
    estimated: true as const,
    config: {
      receiptsPerStaffHour: input.receiptsPerStaffHour,
      minimumSuggestedStaff: input.minimumSuggestedStaff,
    },
    hours: calculateStaffingFootfall(completedAt, days, input),
  };
}
