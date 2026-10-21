import { describe, expect, it } from 'vitest';

import { type StationRoutingRule, resolveStation } from './station-routing';

const productRule = (productId: string, stationId: string, priority = 0): StationRoutingRule => ({
  stationId,
  productId,
  categoryId: null,
  priority,
});

const categoryRule = (categoryId: string, stationId: string, priority = 0): StationRoutingRule => ({
  stationId,
  productId: null,
  categoryId,
  priority,
});

describe('resolveStation — most-specific-wins precedence', () => {
  const rules = [productRule('burger', 'grill'), categoryRule('mains', 'expo')];

  it('a product rule outranks a category rule for the same item', () => {
    expect(resolveStation({ productId: 'burger', categoryId: 'mains' }, rules, 'default')).toEqual({
      stationId: 'grill',
      matchedBy: 'product',
    });
  });

  it('falls back to the category rule when no product rule matches', () => {
    expect(resolveStation({ productId: 'salad', categoryId: 'mains' }, rules, 'default')).toEqual({
      stationId: 'expo',
      matchedBy: 'category',
    });
  });

  it('falls back to the branch default when neither product nor category matches', () => {
    expect(resolveStation({ productId: 'water', categoryId: 'drinks' }, rules, 'bar')).toEqual({
      stationId: 'bar',
      matchedBy: 'default',
    });
  });

  it('ignores the category when the item is uncategorised', () => {
    expect(resolveStation({ productId: 'salad', categoryId: null }, rules, 'default')).toEqual({
      stationId: 'default',
      matchedBy: 'default',
    });
  });

  it('returns null when nothing matches and there is no default station', () => {
    expect(resolveStation({ productId: 'water', categoryId: 'drinks' }, rules, null)).toBeNull();
  });
});

describe('resolveStation — tie-breaking within a level', () => {
  it('the highest priority wins among product rules', () => {
    const rules = [productRule('burger', 'grill', 1), productRule('burger', 'flattop', 5)];
    expect(resolveStation({ productId: 'burger', categoryId: null }, rules, null)?.stationId).toBe(
      'flattop'
    );
  });

  it('the highest priority wins among category rules', () => {
    const rules = [categoryRule('mains', 'expo', 2), categoryRule('mains', 'grill', 9)];
    expect(resolveStation({ productId: 'x', categoryId: 'mains' }, rules, null)?.stationId).toBe(
      'grill'
    );
  });

  it('equal priority breaks deterministically by station id (ascending)', () => {
    const forward = [productRule('burger', 'zeta', 3), productRule('burger', 'alpha', 3)];
    const reversed = [productRule('burger', 'alpha', 3), productRule('burger', 'zeta', 3)];
    // Order-independent: both yield the lexicographically smallest station id.
    expect(
      resolveStation({ productId: 'burger', categoryId: null }, forward, null)?.stationId
    ).toBe('alpha');
    expect(
      resolveStation({ productId: 'burger', categoryId: null }, reversed, null)?.stationId
    ).toBe('alpha');
  });

  it('a lower-priority product rule still outranks a higher-priority category rule', () => {
    const rules = [productRule('burger', 'grill', 1), categoryRule('mains', 'expo', 99)];
    expect(resolveStation({ productId: 'burger', categoryId: 'mains' }, rules, null)).toEqual({
      stationId: 'grill',
      matchedBy: 'product',
    });
  });
});

describe('resolveStation — empty inputs', () => {
  it('with no rules, resolves to the default (or null)', () => {
    expect(resolveStation({ productId: 'p', categoryId: 'c' }, [], 'default')?.matchedBy).toBe(
      'default'
    );
    expect(resolveStation({ productId: 'p', categoryId: 'c' }, [], null)).toBeNull();
  });
});
