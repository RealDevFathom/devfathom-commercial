export const PHARMACY_ANOMALY_POLICY = {
  version: 'AI04-2026-10-29',
  freshnessSeconds: 3_600,
  discount: { minimumLines: 3, minimumRateBps: 1_000 },
  staffVoid: { minimumEvents: 2, minimumRateBps: 1_000 },
  ghostReturn: { minimumUnmatchedRefunds: 2 },
  cashVariance: { minimumMinor: 100_000, minimumRateBps: 100 },
  purchasePriceDrift: { minimumComparisonReceipts: 2, minimumRateBps: 1_000 },
} as const;

export type AnomalyKind =
  | 'SHRINKAGE'
  | 'DISCOUNT_OVERRIDE'
  | 'VOID_ABUSE'
  | 'GHOST_RETURN'
  | 'TENDER_MISMATCH'
  | 'CASH_VARIANCE'
  | 'PURCHASE_PRICE_DRIFT';

export type AnomalyFactSet = {
  shrinkage: Array<{
    countLineId: string;
    branchId: string;
    userId: string;
    medicineId: string;
    batchId: string;
    expectedUnits: number;
    countedUnits: number;
    varianceUnits: number;
    approvedThresholdUnits: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
  discountOverride: Array<{
    branchId: string;
    userId: string;
    affectedLines: number;
    approvedOverrideLines: number;
    grossMinor: number;
    discountMinor: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
  staffVoid: Array<{
    branchId: string;
    userId: string;
    /** Whole bills voided plus `lineVoids`. */
    voidEvents: number;
    /**
     * DEV-1004: bill lines this person changed or removed at the counter so that fewer units
     * remained, each counted once, and the value those changes took off. A person's raise offsets
     * only their own reduction of the same line; a removal is never offset by another line.
     */
    lineVoids?: number;
    lineVoidNetMinor?: number;
    completedSales: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
  ghostReturn: Array<{
    branchId: string;
    userId: string;
    unmatchedRefunds: number;
    unmatchedAmountMinor: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
  cashVariance: Array<{
    closeId: string;
    branchId: string;
    userId: string;
    businessDate: string;
    expectedMinor: number;
    countedMinor: number;
    varianceMinor: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
  tenderMismatch: Array<{
    closeId: string;
    branchId: string;
    userId: string;
    businessDate: string;
    tenderNetMinor: number;
    closeExpectedMinor: number;
    mismatchMinor: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
  purchasePriceDrift: Array<{
    receiptLineId: string;
    branchId: string;
    supplierId: string;
    medicineId: string;
    packLevelId: string;
    batchId: string;
    currentUnitCostMinor: number;
    trailingUnitCostMinor: number;
    comparisonReceipts: number;
    occurredAt: Date;
    sourceObservedAt: Date;
  }>;
};

export type AnomalyCandidate = {
  branchId: string;
  kind: AnomalyKind;
  dedupKey: string;
  status: 'OPEN' | 'STALE';
  severity: 'NOTICE' | 'REVIEW' | 'URGENT';
  scope: Record<string, string>;
  policyVersion: string;
  exactNumbers: Record<string, number>;
  explanation: string;
  dataWindowStart: Date;
  dataWindowEnd: Date;
  sourceObservedAt: Date;
  freshnessSeconds: number;
  estimateMethod: string | null;
  estimateWindow: string | null;
  estimateExclusions: string | null;
  estimateConfidence: string | null;
  computedAt: Date;
};

type DetectionContext = {
  windowStart: Date;
  windowEnd: Date;
  computedAt: Date;
  policy?: typeof PHARMACY_ANOMALY_POLICY;
};

const abs = (value: number) => Math.abs(value);
const rateBps = (part: number, total: number) =>
  total <= 0 ? 0 : Math.round((abs(part) * 10_000) / total);
const money = (minor: number) => `PKR ${(minor / 100).toFixed(2)}`;

/**
 * DEV-1004: what the void count is made of. A bill line changed or removed counts once for each
 * person whose own changes took units off it; nothing on another line offsets it.
 */
function staffVoidBreakdown(fact: {
  voidEvents: number;
  lineVoids?: number;
  lineVoidNetMinor?: number;
}): string {
  const lines = fact.lineVoids ?? 0;
  const wholeBills = fact.voidEvents - lines;
  return `${wholeBills} ${wholeBills === 1 ? 'is a whole bill' : 'are whole bills'} voided and ${lines} ${lines === 1 ? 'is a line' : 'are lines'} this person took units off, ${money(fact.lineVoidNetMinor ?? 0)} in all. Each change counts against the person who made it, only when it leaves fewer units on the line: lowering a quantity and raising it again yourself is not a void, and nor is selling the same units as loose tablets. A removed line always counts in full; raising or adding another line does not offset it.`;
}

function finalize(
  candidate: Omit<
    AnomalyCandidate,
    | 'status'
    | 'policyVersion'
    | 'dataWindowStart'
    | 'dataWindowEnd'
    | 'freshnessSeconds'
    | 'computedAt'
  >,
  context: DetectionContext
): AnomalyCandidate {
  const policy = context.policy ?? PHARMACY_ANOMALY_POLICY;
  const stale =
    context.computedAt.getTime() - candidate.sourceObservedAt.getTime() >
    policy.freshnessSeconds * 1_000;
  return {
    ...candidate,
    status: stale ? 'STALE' : 'OPEN',
    explanation: stale
      ? `Unusable until refreshed: ${candidate.explanation}`
      : candidate.explanation,
    policyVersion: policy.version,
    dataWindowStart: context.windowStart,
    dataWindowEnd: context.windowEnd,
    freshnessSeconds: policy.freshnessSeconds,
    computedAt: context.computedAt,
  };
}

/**
 * AI-04 pure detector. It receives read-model facts and returns explainable
 * review signals only. There is deliberately no command, order, movement, or
 * posting dependency in this module.
 */
export function detectPharmacyAnomalies(
  facts: AnomalyFactSet,
  context: DetectionContext
): AnomalyCandidate[] {
  const policy = context.policy ?? PHARMACY_ANOMALY_POLICY;
  const signals: AnomalyCandidate[] = [];

  for (const fact of facts.shrinkage) {
    const missingUnits = abs(Math.min(0, fact.varianceUnits));
    if (missingUnits <= fact.approvedThresholdUnits) continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'SHRINKAGE',
          dedupKey: `shrinkage:${fact.countLineId}`,
          severity:
            missingUnits >= Math.max(1, fact.approvedThresholdUnits) * 3 ? 'URGENT' : 'REVIEW',
          scope: {
            branchId: fact.branchId,
            userId: fact.userId,
            medicineId: fact.medicineId,
            batchId: fact.batchId,
          },
          exactNumbers: {
            expectedUnits: fact.expectedUnits,
            countedUnits: fact.countedUnits,
            missingUnits,
            approvedThresholdUnits: fact.approvedThresholdUnits,
          },
          explanation: `${missingUnits} units were missing from an approved count (${fact.expectedUnits} expected, ${fact.countedUnits} counted), above its ${fact.approvedThresholdUnits}-unit threshold. Review the count and stock trail; this signal does not assign blame.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
        context
      )
    );
  }

  for (const fact of facts.discountOverride) {
    const discountRateBps = rateBps(fact.discountMinor, fact.grossMinor);
    if (
      fact.affectedLines < policy.discount.minimumLines ||
      discountRateBps < policy.discount.minimumRateBps
    )
      continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'DISCOUNT_OVERRIDE',
          dedupKey: `discount:${fact.branchId}:${fact.userId}:${context.windowStart.toISOString()}:${context.windowEnd.toISOString()}`,
          severity:
            discountRateBps >= policy.discount.minimumRateBps * 2 ||
            fact.affectedLines >= policy.discount.minimumLines * 2
              ? 'URGENT'
              : 'REVIEW',
          scope: { branchId: fact.branchId, userId: fact.userId },
          exactNumbers: {
            affectedLines: fact.affectedLines,
            approvedOverrideLines: fact.approvedOverrideLines,
            grossMinor: fact.grossMinor,
            discountMinor: fact.discountMinor,
            discountRateBps,
            thresholdLines: policy.discount.minimumLines,
            thresholdRateBps: policy.discount.minimumRateBps,
          },
          explanation: `${fact.affectedLines} discounted or approved-override lines totalled ${money(fact.discountMinor)} (${(discountRateBps / 100).toFixed(2)}% of ${money(fact.grossMinor)} gross), meeting the ${policy.discount.minimumLines}-line and ${(policy.discount.minimumRateBps / 100).toFixed(2)}% review thresholds. Review the events; this is not a staff ranking or finding of misconduct.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
        context
      )
    );
  }

  for (const fact of facts.staffVoid) {
    const voidRateBps = rateBps(fact.voidEvents, fact.voidEvents + fact.completedSales);
    if (
      fact.voidEvents < policy.staffVoid.minimumEvents ||
      voidRateBps < policy.staffVoid.minimumRateBps
    )
      continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'VOID_ABUSE',
          dedupKey: `void:${fact.branchId}:${fact.userId}:${context.windowStart.toISOString()}:${context.windowEnd.toISOString()}`,
          severity: fact.voidEvents >= policy.staffVoid.minimumEvents * 2 ? 'URGENT' : 'REVIEW',
          scope: { branchId: fact.branchId, userId: fact.userId },
          exactNumbers: {
            voidEvents: fact.voidEvents,
            lineVoids: fact.lineVoids ?? 0,
            lineVoidNetMinor: fact.lineVoidNetMinor ?? 0,
            completedSales: fact.completedSales,
            voidRateBps,
            thresholdEvents: policy.staffVoid.minimumEvents,
            thresholdRateBps: policy.staffVoid.minimumRateBps,
          },
          explanation: `${fact.voidEvents} void events were recorded for this staff member (${(voidRateBps / 100).toFixed(2)}% of completed sales plus voids), meeting the configurable review thresholds. ${staffVoidBreakdown(fact)} Review the sale-event audit trail; this pattern does not establish abuse.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
        context
      )
    );
  }

  for (const fact of facts.ghostReturn) {
    if (fact.unmatchedRefunds < policy.ghostReturn.minimumUnmatchedRefunds) continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'GHOST_RETURN',
          dedupKey: `return:${fact.branchId}:${fact.userId}:${context.windowStart.toISOString()}:${context.windowEnd.toISOString()}`,
          severity:
            fact.unmatchedRefunds >= policy.ghostReturn.minimumUnmatchedRefunds * 2
              ? 'URGENT'
              : 'REVIEW',
          scope: { branchId: fact.branchId, userId: fact.userId },
          exactNumbers: {
            unmatchedRefunds: fact.unmatchedRefunds,
            unmatchedAmountMinor: fact.unmatchedAmountMinor,
            thresholdRefunds: policy.ghostReturn.minimumUnmatchedRefunds,
          },
          explanation: `${fact.unmatchedRefunds} refunds totalling ${money(fact.unmatchedAmountMinor)} have no matching stock-return record in this window. Review the return documentation; this event pattern does not imply misconduct.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
        context
      )
    );
  }

  for (const fact of facts.cashVariance) {
    const varianceRateBps = rateBps(fact.varianceMinor, abs(fact.expectedMinor));
    const materialityMinor = Math.max(
      policy.cashVariance.minimumMinor,
      Math.round((abs(fact.expectedMinor) * policy.cashVariance.minimumRateBps) / 10_000)
    );
    if (abs(fact.varianceMinor) < materialityMinor) continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'CASH_VARIANCE',
          dedupKey: `cash:${fact.closeId}`,
          severity: abs(fact.varianceMinor) >= materialityMinor * 2 ? 'URGENT' : 'REVIEW',
          scope: { branchId: fact.branchId, userId: fact.userId },
          exactNumbers: {
            expectedMinor: fact.expectedMinor,
            countedMinor: fact.countedMinor,
            varianceMinor: fact.varianceMinor,
            varianceRateBps,
            materialityMinor,
          },
          explanation: `The ${fact.businessDate} close counted ${money(fact.countedMinor)} against ${money(fact.expectedMinor)} expected, a ${money(fact.varianceMinor)} variance (${(varianceRateBps / 100).toFixed(2)}%). Review the close evidence; no posting is created by this signal.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
        context
      )
    );
  }

  for (const fact of facts.tenderMismatch) {
    const mismatchRateBps = rateBps(fact.mismatchMinor, abs(fact.closeExpectedMinor));
    const materialityMinor = Math.max(
      policy.cashVariance.minimumMinor,
      Math.round((abs(fact.closeExpectedMinor) * policy.cashVariance.minimumRateBps) / 10_000)
    );
    if (abs(fact.mismatchMinor) < materialityMinor) continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'TENDER_MISMATCH',
          dedupKey: `tender:${fact.closeId}`,
          severity: abs(fact.mismatchMinor) >= materialityMinor * 2 ? 'URGENT' : 'REVIEW',
          scope: { branchId: fact.branchId, userId: fact.userId },
          exactNumbers: {
            tenderNetMinor: fact.tenderNetMinor,
            closeExpectedMinor: fact.closeExpectedMinor,
            mismatchMinor: fact.mismatchMinor,
            mismatchRateBps,
            materialityMinor,
          },
          explanation: `Net cash tender evidence for ${fact.businessDate} is ${money(fact.tenderNetMinor)}, while the final close expects ${money(fact.closeExpectedMinor)} after removing opening floats and paid-in/out adjustments, a ${money(fact.mismatchMinor)} mismatch. Review tender and close audit records; this signal does not change the close.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod: null,
          estimateWindow: null,
          estimateExclusions: null,
          estimateConfidence: null,
        },
        context
      )
    );
  }

  for (const fact of facts.purchasePriceDrift) {
    const driftMinor = fact.currentUnitCostMinor - fact.trailingUnitCostMinor;
    const driftRateBps = rateBps(driftMinor, fact.trailingUnitCostMinor);
    if (
      fact.comparisonReceipts < policy.purchasePriceDrift.minimumComparisonReceipts ||
      driftRateBps < policy.purchasePriceDrift.minimumRateBps
    )
      continue;
    signals.push(
      finalize(
        {
          branchId: fact.branchId,
          kind: 'PURCHASE_PRICE_DRIFT',
          dedupKey: `price:${fact.receiptLineId}`,
          severity:
            driftRateBps >= policy.purchasePriceDrift.minimumRateBps * 2 ? 'URGENT' : 'REVIEW',
          scope: {
            branchId: fact.branchId,
            supplierId: fact.supplierId,
            medicineId: fact.medicineId,
            packLevelId: fact.packLevelId,
            batchId: fact.batchId,
          },
          exactNumbers: {
            currentUnitCostMinor: fact.currentUnitCostMinor,
            trailingUnitCostMinor: fact.trailingUnitCostMinor,
            driftMinor,
            driftRateBps,
            comparisonReceipts: fact.comparisonReceipts,
            thresholdRateBps: policy.purchasePriceDrift.minimumRateBps,
          },
          explanation: `Landed unit cost is ${money(fact.currentUnitCostMinor)}, ${(driftRateBps / 100).toFixed(2)}% ${driftMinor >= 0 ? 'above' : 'below'} the ${money(fact.trailingUnitCostMinor)} trailing baseline from ${fact.comparisonReceipts} earlier receipts for the same medicine and pack. Review the invoice; no price truth or posting is changed.`,
          sourceObservedAt: fact.sourceObservedAt,
          estimateMethod:
            'Arithmetic mean of earlier posted landed unit costs for the same medicine and pack.',
          estimateWindow: 'Trailing 30 days before this receipt within the selected branch scope.',
          estimateExclusions:
            'Current receipt, draft/reversed receipts, other medicines, and other pack levels.',
          estimateConfidence:
            fact.comparisonReceipts >= 5 ? 'HIGH' : fact.comparisonReceipts >= 3 ? 'MEDIUM' : 'LOW',
        },
        context
      )
    );
  }

  return signals.sort((a, b) => a.dedupKey.localeCompare(b.dedupKey));
}
