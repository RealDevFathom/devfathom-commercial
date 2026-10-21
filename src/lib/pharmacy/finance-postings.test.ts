/**
 * PH-FIN / FIN-01 — the pure half of the posting adapters: the apportionment
 * that lets revenue and discount be split across a sale's lot allocations
 * without unbalancing the entry.
 *
 * The adapters themselves are database-backed and are covered in
 * `finance-postings.db.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { apportion } from './finance-postings';

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe('apportion — FIN-01 pro-rata split that still balances', () => {
  it('splits evenly when the weights divide the amount', () => {
    expect(apportion(1000, [1, 1])).toEqual([500, 500]);
  });

  it('splits in proportion to the weights', () => {
    expect(apportion(1000, [3, 1])).toEqual([750, 250]);
  });

  it('keeps the total exact when the split does not divide evenly', () => {
    // 1000 over three equal parts is 333.33…; dropping the remainder would
    // leave the entry short by 1 minor unit and the balance check would refuse
    // it, so the last share absorbs it.
    const shares = apportion(1000, [1, 1, 1]);
    expect(shares).toEqual([333, 333, 334]);
    expect(sum(shares)).toBe(1000);
  });

  it.each([
    [7, [3, 5, 11]],
    [1, [1, 1, 1, 1]],
    [999_983, [17, 29, 31, 37]],
    [12_345, [1, 1]],
  ])('never loses or invents money splitting %i across %j', (total, weights) => {
    expect(sum(apportion(total, weights))).toBe(total);
  });

  it('gives every share to a single allocation', () => {
    expect(apportion(4321, [9])).toEqual([4321]);
  });

  it('returns zero shares for a zero amount, so no empty leg is ever posted', () => {
    expect(apportion(0, [4, 6])).toEqual([0, 0]);
  });

  it('returns zero shares when the weights carry no quantity at all', () => {
    expect(apportion(500, [0, 0])).toEqual([0, 0]);
  });
});
