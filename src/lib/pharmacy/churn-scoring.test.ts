import { describe, expect, it } from 'vitest';

import {
  CHURN_MODEL_VERSION,
  churnRiskBand,
  combineChurnScore,
  frequencyScore,
  recencyScore,
  scoreChurnRfm,
  type ChurnInputRow,
} from './churn-scoring';

const asOf = new Date('2026-11-01T00:00:00Z');
const daysAgo = (days: number) => new Date(asOf.getTime() - days * 86_400_000);
const row = (
  customerId: string,
  days: number,
  frequency: number,
  monetary: number
): ChurnInputRow => ({
  customerId,
  lastCompletedAt: daysAgo(days),
  frequency,
  monetaryMinor: BigInt(monetary),
});

describe('RFM churn scoring v1', () => {
  it.each([
    [0, 5],
    [30, 5],
    [31, 4],
    [60, 4],
    [90, 3],
    [180, 2],
    [181, 1],
    [900, 1],
  ])('scores recency of %i days as %i', (days, expected) => {
    expect(recencyScore(days)).toBe(expected);
  });

  it.each([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [8, 4],
    [9, 5],
    [40, 5],
  ])('scores frequency of %i receipts as %i', (receipts, expected) => {
    expect(frequencyScore(receipts)).toBe(expected);
  });

  it('maps RFM extremes to the 0–100 churn range and bands', () => {
    expect(combineChurnScore(5, 5, 5)).toBe(0);
    expect(combineChurnScore(1, 1, 1)).toBe(100);
    expect(churnRiskBand(0)).toBe('LOW');
    expect(churnRiskBand(39)).toBe('LOW');
    expect(churnRiskBand(40)).toBe('MEDIUM');
    expect(churnRiskBand(69)).toBe('MEDIUM');
    expect(churnRiskBand(70)).toBe('HIGH');
    expect(churnRiskBand(100)).toBe('HIGH');
  });

  it('weights recency most heavily', () => {
    // A lapsed but historically loyal customer outranks a recent one-off buyer.
    expect(combineChurnScore(1, 5, 5)).toBeGreaterThan(combineChurnScore(5, 1, 1));
  });

  it('gives tiny cohorts a neutral monetary score', () => {
    const [only] = scoreChurnRfm([row('c1', 10, 3, 999_999)], asOf);
    expect(only).toMatchObject({ monetaryScore: 3, recencyScore: 5, frequencyScore: 3 });
  });

  it('ranks monetary within the branch cohort and lets ties share a score', () => {
    const rows = [
      row('c1', 10, 3, 100),
      row('c2', 10, 3, 200),
      row('c3', 10, 3, 300),
      row('c4', 10, 3, 400),
      row('c5', 10, 3, 500),
      row('c6', 10, 3, 500),
    ];
    const scores = scoreChurnRfm(rows, asOf);
    expect(scores.map((s) => s.monetaryScore)).toEqual([1, 1, 2, 3, 4, 4]);
  });

  it('produces a complete, deterministic score row per customer', () => {
    const rows = [
      row('recent-loyal', 3, 12, 50_000),
      row('lapsed-loyal', 200, 10, 40_000),
      row('one-off', 100, 1, 500),
      row('old-only', 400, 0, 0),
      row('mid', 45, 4, 5_000),
    ];
    const first = scoreChurnRfm(rows, asOf);
    expect(scoreChurnRfm(rows, asOf)).toEqual(first);
    const byId = Object.fromEntries(first.map((s) => [s.customerId, s]));
    expect(byId['recent-loyal']).toMatchObject({
      modelVersion: CHURN_MODEL_VERSION,
      recencyDays: 3,
      frequency: 12,
      monetaryMinor: BigInt(50_000),
      recencyScore: 5,
      frequencyScore: 5,
      riskBand: 'LOW',
    });
    expect(byId['old-only']).toMatchObject({
      recencyDays: 400,
      recencyScore: 1,
      frequencyScore: 1,
      monetaryScore: 1,
      churnScore: 100,
      riskBand: 'HIGH',
    });
    // R1 F5 M4 → 0.6·4 + 0.15·1 = 2.55 → 64: loyalty softens, but recency dominates.
    expect(byId['lapsed-loyal']).toMatchObject({ churnScore: 64, riskBand: 'MEDIUM' });
    expect(byId['one-off'].churnScore).toBeGreaterThan(byId['mid'].churnScore);
    for (const score of first) {
      expect(score.churnScore).toBeGreaterThanOrEqual(0);
      expect(score.churnScore).toBeLessThanOrEqual(100);
    }
  });

  it('never emits negative recency or money', () => {
    const [future] = scoreChurnRfm(
      [
        {
          customerId: 'c1',
          lastCompletedAt: new Date(asOf.getTime() + 60_000),
          frequency: 1,
          monetaryMinor: BigInt(-5),
        },
      ],
      asOf
    );
    expect(future.recencyDays).toBe(0);
    expect(future.monetaryMinor).toBe(BigInt(0));
  });

  it('carries no clinical or identity fields beyond the customer id', () => {
    const [score] = scoreChurnRfm([row('c1', 10, 2, 100)], asOf);
    expect(Object.keys(score).sort()).toEqual(
      [
        'churnScore',
        'customerId',
        'frequency',
        'frequencyScore',
        'modelVersion',
        'monetaryMinor',
        'monetaryScore',
        'recencyDays',
        'recencyScore',
        'riskBand',
      ].sort()
    );
  });
});
