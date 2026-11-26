import { CASH_CLOSE_CHECK_POLICY } from './cash-close-check';

/**
 * DEV-733 — review flags for the owner command-centre KPI cards. Pure and read-only: a flag is
 * a prompt to look at the close and refund evidence, never proof of misconduct. The refund
 * threshold reuses the cash-close check policy so the report never disagrees with the close
 * check the owner already sees.
 */
export type PharmacyReportKpiFlags = Partial<
  Record<'refundsMinor' | 'cashVarianceMinor', { detail: string }>
>;

type KpiMetrics = {
  salesMinor: number | null;
  refundsMinor: number | null;
  cashVarianceMinor: number | null;
};

const known = (value: number | null): value is number =>
  value != null && Number.isSafeInteger(value);

export function reportRatePercent(amount: number, base: number) {
  return base > 0 ? Math.round((amount * 10_000) / base) / 100 : null;
}

export function pharmacyReportKpiFlags(
  metrics: KpiMetrics,
  policy = CASH_CLOSE_CHECK_POLICY
): PharmacyReportKpiFlags {
  const flags: PharmacyReportKpiFlags = {};
  const { salesMinor, refundsMinor, cashVarianceMinor } = metrics;

  if (known(refundsMinor) && known(salesMinor) && refundsMinor >= policy.refundRate.minimumMinor) {
    if (salesMinor <= 0) {
      flags.refundsMinor = { detail: 'Refunds recorded with no completed sales in this period.' };
    } else {
      const rateBps = Math.round(reportRatePercent(refundsMinor, salesMinor)! * 100);
      if (rateBps >= policy.refundRate.minimumRateBps) {
        flags.refundsMinor = {
          detail: `Refunds are ${(rateBps / 100).toFixed(2)}% of sales, at or above the ${(
            policy.refundRate.minimumRateBps / 100
          ).toFixed(2)}% review threshold.`,
        };
      }
    }
  }

  if (known(cashVarianceMinor) && cashVarianceMinor !== 0) {
    flags.cashVarianceMinor = {
      detail: `Counted cash is ${cashVarianceMinor > 0 ? 'over' : 'short'} of expected on final closes. Review the close notes.`,
    };
  }

  return flags;
}
