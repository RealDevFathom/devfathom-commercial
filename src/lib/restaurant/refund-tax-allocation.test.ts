import { describe, expect, it } from 'vitest';

import { allocateIncrementalTaxRefundCents } from './refund-tax-allocation';

const FROZEN = [15, 15, 9, 5, 5, 2];

/** Run successive refunds to the given cumulative tax totals; return each delta. */
function refundSequence(original: readonly number[], cumulativeTotals: readonly number[]) {
  const already = original.map(() => 0);
  const deltas: number[][] = [];
  for (const cumulative of cumulativeTotals) {
    const delta = allocateIncrementalTaxRefundCents(original, already, cumulative);
    expect(delta).not.toBeNull();
    delta!.forEach((cents, index) => {
      already[index] = already[index]! + cents;
    });
    deltas.push(delta!);
  }
  return { already, deltas };
}

describe('allocateIncrementalTaxRefundCents', () => {
  it('accepts a second partial refund after a 25-cent refund across six buckets', () => {
    const first = allocateIncrementalTaxRefundCents(FROZEN, [0, 0, 0, 0, 0, 0], 25);
    expect(first).toEqual([7, 7, 4, 3, 3, 1]);

    // A fresh cumulative allocation of 26 would be [8,8,5,2,2,1]: two buckets
    // would go backwards. The increment must be non-negative everywhere.
    const second = allocateIncrementalTaxRefundCents(FROZEN, first!, 26);
    expect(second).not.toBeNull();
    expect(second!.every((cents) => cents >= 0)).toBe(true);
    expect(second!.reduce((total, cents) => total + cents, 0)).toBe(1);
    second!.forEach((cents, index) => {
      expect(first![index]! + cents).toBeLessThanOrEqual(FROZEN[index]!);
    });
  });

  it('exhausts exact frozen cents on the final refund', () => {
    const { already } = refundSequence(FROZEN, [25, 26, 51]);
    expect(already).toEqual(FROZEN);
  });

  it('handles successive one-cent refunds without exceeding any bucket', () => {
    const totals = Array.from({ length: 51 }, (_, index) => index + 1);
    const { already, deltas } = refundSequence(FROZEN, totals);
    for (const delta of deltas) {
      expect(delta.every((cents) => cents >= 0)).toBe(true);
      expect(delta.reduce((total, cents) => total + cents, 0)).toBe(1);
    }
    expect(already).toEqual(FROZEN);
  });

  it('keeps every partition non-negative, capped and exhaustive', () => {
    let seed = 772;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let run = 0; run < 200; run += 1) {
      const original = Array.from({ length: 1 + (next() % 8) }, () => next() % 20);
      const total = original.reduce((sum, cents) => sum + cents, 0);
      const cuts = new Set<number>([total]);
      const pieces = next() % 6;
      for (let index = 0; index < pieces; index += 1) cuts.add(next() % (total + 1));
      const cumulativeTotals = [...cuts].sort((left, right) => left - right);
      const already = original.map(() => 0);
      for (const cumulative of cumulativeTotals) {
        const delta = allocateIncrementalTaxRefundCents(original, already, cumulative);
        expect(delta).not.toBeNull();
        delta!.forEach((cents, index) => {
          expect(cents).toBeGreaterThanOrEqual(0);
          already[index] = already[index]! + cents;
          expect(already[index]).toBeLessThanOrEqual(original[index]!);
        });
        expect(already.reduce((sum, cents) => sum + cents, 0)).toBe(cumulative);
      }
      expect(already).toEqual(original);
    }
  });

  it('rejects inconsistent prior evidence', () => {
    expect(allocateIncrementalTaxRefundCents([5, 5], [6, 0], 6)).toBeNull();
    expect(allocateIncrementalTaxRefundCents([5, 5], [3, 3], 5)).toBeNull();
    expect(allocateIncrementalTaxRefundCents([5, 5], [0, 0], 11)).toBeNull();
  });

  it('returns no rows for a tender with no frozen tax', () => {
    expect(allocateIncrementalTaxRefundCents([], [], 0)).toEqual([]);
  });
});
