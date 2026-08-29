/**
 * WHA-288 / promotions Lane A — §6 cap arithmetic.
 *
 * The pure half of the cap contract: given the counter state read under the
 * lock, does this evaluation fit? Isolating that decision here means the
 * database battery (`promotion-caps.db.test.ts`) can concentrate on the thing
 * only a database can prove — that the LOCK actually serializes two concurrent
 * transactions.
 */

import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { PromotionApplication, PromotionRule } from '@/lib/restaurant/promotion-contracts';
import {
  capRequestsFor,
  planCapReservations,
  remainingCapacity,
  sortCapScopes,
  type PromotionCapCounterState,
  type PromotionCapRequest,
} from '@/lib/restaurant/promotion-caps';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function counter(overrides: Partial<PromotionCapCounterState> = {}): PromotionCapCounterState {
  return {
    promotionVersionId: 'v-1',
    scopeKind: 'GLOBAL',
    scopeKey: '',
    capCount: null,
    capAmount: null,
    consumedCount: 0,
    consumedAmount: d(0),
    reservedCount: 0,
    reservedAmount: d(0),
    ...overrides,
  };
}

function request(overrides: Partial<PromotionCapRequest> = {}): PromotionCapRequest {
  return {
    promotionVersionId: 'v-1',
    scopeKind: 'GLOBAL',
    scopeKey: '',
    applicationOrdinal: 0,
    count: 1,
    amount: d('5.00'),
    ...overrides,
  };
}

describe('promotion caps — §6 planning', () => {
  it('grants exactly the remaining capacity and refuses one more', () => {
    const nearlyFull = counter({ capCount: 10, consumedCount: 9 });
    expect(planCapReservations([nearlyFull], [request()]).granted).toBe(true);

    const full = counter({ capCount: 10, consumedCount: 10 });
    const plan = planCapReservations([full], [request()]);
    expect(plan.granted).toBe(false);
    if (!plan.granted) expect(plan.exhausted.scopeKind).toBe('GLOBAL');
  });

  it('counts LIVE reservations, so a concurrent unsettled checkout still blocks', () => {
    // The whole point of a reservation ledger: the other transaction has taken
    // the last slot but has not settled it yet.
    const held = counter({ capCount: 1, consumedCount: 0, reservedCount: 1 });
    expect(planCapReservations([held], [request()]).granted).toBe(false);
  });

  it('applies a budget cap by amount, not by count', () => {
    const budget = counter({
      scopeKind: 'BUDGET',
      capAmount: d('100.00'),
      consumedAmount: d('96.00'),
    });
    expect(
      planCapReservations([budget], [request({ scopeKind: 'BUDGET', amount: d('4.00') })]).granted
    ).toBe(true);
    expect(
      planCapReservations([budget], [request({ scopeKind: 'BUDGET', amount: d('4.01') })]).granted
    ).toBe(false);
  });

  it('accumulates several applications of ONE promotion within a single order', () => {
    // Two applications against a cap of one: checking each in isolation would
    // wrongly pass both.
    const single = counter({ capCount: 1 });
    const plan = planCapReservations(
      [single],
      [request({ applicationOrdinal: 0 }), request({ applicationOrdinal: 1 })]
    );
    expect(plan.granted).toBe(false);
  });

  it('is all-or-nothing across scopes', () => {
    // The global cap has room; the per-customer cap does not. §6 requires
    // rejecting ALL rather than granting the part that fits.
    const counters = [
      counter({ scopeKind: 'GLOBAL', capCount: 100 }),
      counter({ scopeKind: 'CUSTOMER', scopeKey: 'customer-1', capCount: 1, consumedCount: 1 }),
    ];
    const plan = planCapReservations(counters, [
      request({ scopeKind: 'GLOBAL' }),
      request({ scopeKind: 'CUSTOMER', scopeKey: 'customer-1' }),
    ]);
    expect(plan.granted).toBe(false);
    if (!plan.granted) expect(plan.exhausted.scopeKind).toBe('CUSTOMER');
  });

  it('an unconfigured scope has no counter row and reserves nothing', () => {
    expect(planCapReservations([], [request()]).granted).toBe(true);
  });

  it('a counter with a null cap is unlimited', () => {
    const unlimited = counter({ capCount: null, capAmount: null, consumedCount: 10_000 });
    expect(planCapReservations([unlimited], [request()]).granted).toBe(true);
  });

  it('orders scopes stably, which is what makes concurrent checkouts queue', () => {
    const scrambled = [
      { promotionVersionId: 'v-2', scopeKind: 'GLOBAL' as const, scopeKey: '' },
      { promotionVersionId: 'v-1', scopeKind: 'CUSTOMER' as const, scopeKey: 'b' },
      { promotionVersionId: 'v-1', scopeKind: 'CUSTOMER' as const, scopeKey: 'a' },
      { promotionVersionId: 'v-1', scopeKind: 'BUDGET' as const, scopeKey: '' },
    ];
    const ordered = sortCapScopes(scrambled).map(
      (scope) => `${scope.promotionVersionId}/${scope.scopeKind}/${scope.scopeKey}`
    );
    expect(ordered).toEqual(['v-1/BUDGET/', 'v-1/CUSTOMER/a', 'v-1/CUSTOMER/b', 'v-2/GLOBAL/']);
    // Any input permutation yields the same acquisition order.
    expect(sortCapScopes([...scrambled].reverse()).map((s) => s.scopeKey)).toEqual(
      sortCapScopes(scrambled).map((s) => s.scopeKey)
    );
  });
});

describe('promotion caps — §6 which scopes a rule reserves', () => {
  const application = (ordinal: number): PromotionApplication => ({
    applicationOrdinal: ordinal,
    promotionId: 'promo-1',
    promotionVersionId: 'v-1',
    ruleHash: 'hash-1',
    benefitKind: 'AMOUNT_OFF',
    unroundedBenefit: d('5.00'),
    roundedBenefit: d('5.00'),
    qualifyingAmount: d('50.00'),
    discountedQuantity: 1,
    selectedUnits: [],
    allocations: [],
  });

  const rule = (overrides: Partial<PromotionRule>): PromotionRule =>
    ({
      versionId: 'v-1',
      globalCap: null,
      perCustomerCap: null,
      budgetAmount: null,
      ...overrides,
    }) as PromotionRule;

  it('an uncapped rule reserves nothing at all', () => {
    expect(capRequestsFor(rule({}), [application(0)], 'customer-1')).toEqual([]);
  });

  it('reserves one request per capped scope per application', () => {
    const requests = capRequestsFor(
      rule({ globalCap: 100, perCustomerCap: 2, budgetAmount: d('500.00') }),
      [application(0), application(1)],
      'customer-1'
    );
    expect(requests).toHaveLength(6); // 3 scopes x 2 applications
    expect(new Set(requests.map((r) => r.scopeKind))).toEqual(
      new Set(['GLOBAL', 'CUSTOMER', 'BUDGET'])
    );
  });

  it('skips the per-customer scope for an anonymous guest', () => {
    const requests = capRequestsFor(rule({ perCustomerCap: 2 }), [application(0)], null);
    expect(requests).toEqual([]);
  });

  it('ignores applications belonging to other promotion versions', () => {
    const other = { ...application(0), promotionVersionId: 'v-other' };
    expect(capRequestsFor(rule({ globalCap: 10 }), [other], 'customer-1')).toEqual([]);
  });
});

describe('promotion caps — remaining headroom', () => {
  it('subtracts both consumed and reserved, and never reports negative', () => {
    const state = counter({
      capCount: 10,
      consumedCount: 7,
      reservedCount: 2,
      capAmount: d('100.00'),
      consumedAmount: d('80.00'),
      reservedAmount: d('30.00'),
    });
    const remaining = remainingCapacity(state);
    expect(remaining.count).toBe(1);
    // Over-held by 10.00; reported as zero rather than a negative headroom.
    expect(remaining.amount?.toFixed(2)).toBe('0.00');
  });

  it('reports null for an uncapped scope', () => {
    const remaining = remainingCapacity(counter());
    expect(remaining.count).toBeNull();
    expect(remaining.amount).toBeNull();
  });
});
