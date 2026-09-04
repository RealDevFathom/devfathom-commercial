import { describe, expect, it } from 'vitest';

import {
  detectPharmacyAnomalies,
  PHARMACY_ANOMALY_POLICY,
  type AnomalyFactSet,
} from './anomaly-signals';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-05T00:00:00.000Z');
const empty = (): AnomalyFactSet => ({
  shrinkage: [],
  discountOverride: [],
  ghostReturn: [],
  cashVariance: [],
  purchasePriceDrift: [],
});
const detect = (facts: AnomalyFactSet, computedAt = NOW) =>
  detectPharmacyAnomalies(facts, { windowStart: START, windowEnd: END, computedAt });

describe('AI-04 deterministic anomaly thresholds and explanations', () => {
  it('raises shrinkage only above the approved count threshold', () => {
    const facts = empty();
    facts.shrinkage.push({
      countLineId: 'line_1',
      branchId: 'branch_1',
      medicineId: 'med_1',
      batchId: 'batch_1',
      expectedUnits: 100,
      countedUnits: 94,
      varianceUnits: -6,
      approvedThresholdUnits: 5,
      occurredAt: NOW,
      sourceObservedAt: NOW,
    });
    const signal = detect(facts)[0]!;
    expect(signal.kind).toBe('SHRINKAGE');
    expect(signal.exactNumbers).toMatchObject({ missingUnits: 6, approvedThresholdUnits: 5 });
    expect(signal.explanation).toContain('100 expected, 94 counted');
    expect(signal.explanation).toContain('does not assign blame');
    facts.shrinkage[0]!.countedUnits = 95;
    facts.shrinkage[0]!.varianceUnits = -5;
    expect(detect(facts)).toEqual([]);
  });

  it('requires both the discount event-count and rate thresholds', () => {
    const facts = empty();
    facts.discountOverride.push({
      branchId: 'branch_1',
      userId: 'user_1',
      affectedLines: 3,
      approvedOverrideLines: 2,
      grossMinor: 100_000,
      discountMinor: 10_000,
      occurredAt: NOW,
      sourceObservedAt: NOW,
    });
    const signal = detect(facts)[0]!;
    expect(signal.exactNumbers).toMatchObject({ affectedLines: 3, discountRateBps: 1_000 });
    expect(signal.explanation).toContain('not a staff ranking or finding of misconduct');
    facts.discountOverride[0]!.affectedLines = 2;
    expect(detect(facts)).toEqual([]);
  });

  it('flags the bounded unmatched-refund event pattern without alleging misconduct', () => {
    const facts = empty();
    facts.ghostReturn.push({
      branchId: 'branch_1',
      userId: 'user_1',
      unmatchedRefunds: 2,
      unmatchedAmountMinor: 25_000,
      occurredAt: NOW,
      sourceObservedAt: NOW,
    });
    const signal = detect(facts)[0]!;
    expect(signal.kind).toBe('GHOST_RETURN');
    expect(signal.explanation).toContain('no matching stock-return record');
    expect(signal.explanation).toContain('does not imply misconduct');
    facts.ghostReturn[0]!.unmatchedRefunds = 1;
    expect(detect(facts)).toEqual([]);
  });

  it('uses the greater absolute/proportional cash materiality threshold', () => {
    const facts = empty();
    facts.cashVariance.push({
      closeId: 'close_1',
      branchId: 'branch_1',
      businessDate: '2026-09-04',
      expectedMinor: 20_000_000,
      countedMinor: 20_200_000,
      varianceMinor: 200_000,
      occurredAt: NOW,
      sourceObservedAt: NOW,
    });
    const signal = detect(facts)[0]!;
    expect(signal.exactNumbers).toMatchObject({ materialityMinor: 200_000, varianceRateBps: 100 });
    expect(signal.explanation).toContain('no posting is created');
    facts.cashVariance[0]!.varianceMinor = 199_999;
    expect(detect(facts)).toEqual([]);
  });

  it('compares receipt cost only after the minimum same-medicine/pack history', () => {
    const facts = empty();
    facts.purchasePriceDrift.push({
      receiptLineId: 'receipt_line_1',
      branchId: 'branch_1',
      supplierId: 'supplier_1',
      medicineId: 'med_1',
      packLevelId: 'pack_1',
      batchId: 'batch_1',
      currentUnitCostMinor: 120,
      trailingUnitCostMinor: 100,
      comparisonReceipts: 2,
      occurredAt: NOW,
      sourceObservedAt: NOW,
    });
    const signal = detect(facts)[0]!;
    expect(signal.exactNumbers).toMatchObject({ driftMinor: 20, driftRateBps: 2_000 });
    expect(signal.estimateMethod).toContain('same medicine and pack');
    expect(signal.estimateWindow).toContain('Trailing 30 days');
    expect(signal.estimateExclusions).toContain('draft/reversed');
    expect(signal.estimateConfidence).toBe('LOW');
    facts.purchasePriceDrift[0]!.comparisonReceipts = 1;
    expect(detect(facts)).toEqual([]);
  });

  it('marks qualifying evidence unusable instead of open when its source is stale', () => {
    const facts = empty();
    facts.ghostReturn.push({
      branchId: 'branch_1',
      userId: 'user_1',
      unmatchedRefunds: 2,
      unmatchedAmountMinor: 25_000,
      occurredAt: START,
      sourceObservedAt: START,
    });
    const signal = detect(
      facts,
      new Date(START.getTime() + (PHARMACY_ANOMALY_POLICY.freshnessSeconds + 1) * 1_000)
    )[0]!;
    expect(signal.status).toBe('STALE');
    expect(signal.explanation).toMatch(/^Unusable until refreshed:/);
  });
});
