import { describe, expect, it } from 'vitest';
import { churnScoreFraction, computeChurnScore } from './churn-score';

describe('computeChurnScore', () => {
  it('scores a recent, frequent, high-value customer as retained', () => {
    expect(
      computeChurnScore({ daysSinceLastReceipt: 3, receiptCount: 20, monetaryMinor: 2_000_000 })
    ).toEqual({ score: 0, recencyScore: 5, frequencyScore: 5, monetaryScore: 5 });
  });

  it('scores a long-lapsed, one-off, low-value customer as fully churned', () => {
    expect(
      computeChurnScore({ daysSinceLastReceipt: 400, receiptCount: 0, monetaryMinor: 0 })
    ).toEqual({ score: 100, recencyScore: 1, frequencyScore: 1, monetaryScore: 1 });
  });

  it('puts exact recency boundaries in the less recent band', () => {
    expect(
      computeChurnScore({ daysSinceLastReceipt: 29, receiptCount: 1, monetaryMinor: 0 })
        .recencyScore
    ).toBe(5);
    expect(
      computeChurnScore({ daysSinceLastReceipt: 30, receiptCount: 1, monetaryMinor: 0 })
        .recencyScore
    ).toBe(4);
    expect(
      computeChurnScore({ daysSinceLastReceipt: 180, receiptCount: 1, monetaryMinor: 0 })
        .recencyScore
    ).toBe(1);
  });

  it('weights recency most: a lapsed regular outranks a recent one-off buyer', () => {
    const lapsedRegular = computeChurnScore({
      daysSinceLastReceipt: 120,
      receiptCount: 12,
      monetaryMinor: 1_500_000,
    });
    const recentOneOff = computeChurnScore({
      daysSinceLastReceipt: 5,
      receiptCount: 1,
      monetaryMinor: 50_000,
    });
    expect(lapsedRegular.score).toBe(45);
    expect(recentOneOff.score).toBe(40);
    expect(lapsedRegular.score).toBeGreaterThan(recentOneOff.score);
  });

  it('never decreases as recency worsens', () => {
    let previous = -1;
    for (const days of [0, 15, 30, 59, 60, 90, 179, 180, 1000]) {
      const { score } = computeChurnScore({
        daysSinceLastReceipt: days,
        receiptCount: 4,
        monetaryMinor: 300_000,
      });
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });

  it('rejects invalid facts', () => {
    expect(() =>
      computeChurnScore({ daysSinceLastReceipt: -1, receiptCount: 0, monetaryMinor: 0 })
    ).toThrow('daysSinceLastReceipt');
    expect(() =>
      computeChurnScore({ daysSinceLastReceipt: 0, receiptCount: Number.NaN, monetaryMinor: 0 })
    ).toThrow('receiptCount');
  });

  it('converts a stored score to the fraction win-back planning consumes', () => {
    expect(churnScoreFraction(75)).toBe(0.75);
    expect(() => churnScoreFraction(101)).toThrow();
    expect(() => churnScoreFraction(2.5)).toThrow();
  });
});
