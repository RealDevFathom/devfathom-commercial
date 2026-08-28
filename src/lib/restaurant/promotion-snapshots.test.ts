import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  evaluatePromotions,
  type PromotionCheckoutContext,
  type PromotionRule,
} from './promotion-rules';
import {
  buildApplicationSnapshots,
  describeBenefit,
  PromotionSnapshotError,
  recomputeSnapshotDiscount,
  reconstructCheckDiscounts,
  snapshotAgreesWithRule,
  type PromotionApplicationPlacement,
  type StoredPromotionApplication,
} from './promotion-snapshots';

/**
 * WHA-288 — SNAPSHOT RECONSTRUCTION.
 *
 * The binding claim: months later, with the promotion version SUPERSEDED, its
 * targets deleted and its code reassigned, a check's discounts must still
 * reconstruct exactly from the stored application rows ALONE. Every test here
 * works on rows only — no rule object is in scope during a reconstruction.
 */

const D = (value: string | number) => new Prisma.Decimal(value);

const PLACEMENT: PromotionApplicationPlacement = {
  organizationId: 'org_1',
  orderId: 'order_1',
  billId: 'bill_1',
  branchId: 'branch_1',
  businessDate: new Date('2026-08-28T00:00:00Z'),
  customerId: 'customer_1',
  authorizedByStaffProfileId: null,
};

function rule(overrides: Partial<PromotionRule> & { ruleCode: string }): PromotionRule {
  return {
    promotionId: `promo_${overrides.ruleCode}`,
    promotionVersionId: `version_${overrides.ruleCode}`,
    versionNumber: 3,
    promotionCode: null,
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    startMinuteOfDay: null,
    endMinuteOfDay: null,
    dayMask: 127,
    targetScope: 'ORDER',
    productIds: [],
    categoryIds: [],
    channels: [],
    branchIds: [],
    benefitKind: 'PERCENTAGE_OFF',
    benefitRate: D('0.10'),
    benefitAmount: null,
    buyQuantity: null,
    getQuantity: null,
    minimumSubtotal: null,
    minimumItemQuantity: null,
    maximumDiscountAmount: null,
    stacking: 'STACKABLE',
    priority: 0,
    authority: 'AUTOMATIC',
    ...overrides,
  };
}

const CONTEXT: PromotionCheckoutContext = {
  at: new Date('2026-08-28T09:00:00Z'),
  timeZone: 'Asia/Karachi',
  branchId: 'branch_1',
  channel: 'DINE_IN',
  items: [
    { id: 'item_a', productId: 'p1', categoryId: 'c1', quantity: 2, unitPrice: D('400.00') },
    { id: 'item_b', productId: 'p2', categoryId: 'c2', quantity: 1, unitPrice: D('200.00') },
  ],
};

function stored(
  overrides: Partial<StoredPromotionApplication> & { sequence: number }
): StoredPromotionApplication {
  return {
    promotionId: 'promo_1',
    promotionVersionId: 'version_1',
    versionNumber: 3,
    ruleCode: `RULE_${overrides.sequence}`,
    promotionCode: null,
    targetScope: 'ORDER',
    benefitKind: 'PERCENTAGE_OFF',
    benefitRate: D('0.10'),
    benefitAmount: null,
    authority: 'AUTOMATIC',
    authorizedByStaffProfileId: null,
    discountAmount: D('100.00'),
    ...overrides,
  };
}

describe('building application snapshots', () => {
  it('copies the whole rule identity onto every row', () => {
    const evaluation = evaluatePromotions([rule({ ruleCode: 'TEN_PCT' })], CONTEXT);
    const [snapshot] = buildApplicationSnapshots(evaluation, PLACEMENT);

    expect(snapshot).toMatchObject({
      organizationId: 'org_1',
      promotionId: 'promo_TEN_PCT',
      promotionVersionId: 'version_TEN_PCT',
      versionNumber: 3,
      ruleCode: 'TEN_PCT',
      targetScope: 'ORDER',
      benefitKind: 'PERCENTAGE_OFF',
      authority: 'AUTOMATIC',
      orderId: 'order_1',
      billId: 'bill_1',
      branchId: 'branch_1',
      customerId: 'customer_1',
      sequence: 1,
    });
    // 10% of (2 x 400 + 200).
    expect(snapshot!.discountAmount.toFixed(2)).toBe('100.00');
    expect(snapshot!.benefitRate!.toString()).toBe('0.1');
  });

  it('numbers a stacked set 1..n in the evaluated order', () => {
    const evaluation = evaluatePromotions(
      [
        rule({ ruleCode: 'FIRST', priority: 5, benefitRate: D('0.10') }),
        rule({ ruleCode: 'SECOND', priority: 1, benefitRate: D('0.05') }),
      ],
      CONTEXT
    );
    const snapshots = buildApplicationSnapshots(evaluation, PLACEMENT);
    expect(snapshots.map((s) => [s.sequence, s.ruleCode])).toEqual([
      [1, 'FIRST'],
      [2, 'SECOND'],
    ]);
  });

  it('requires an operator for a manager override', () => {
    const evaluation = evaluatePromotions(
      [rule({ ruleCode: 'OVERRIDE', authority: 'MANAGER_OVERRIDE' })],
      CONTEXT
    );
    expect(() => buildApplicationSnapshots(evaluation, PLACEMENT)).toThrow(PromotionSnapshotError);
    const withOperator = buildApplicationSnapshots(evaluation, {
      ...PLACEMENT,
      authorizedByStaffProfileId: 'staff_9',
    });
    expect(withOperator[0]!.authorizedByStaffProfileId).toBe('staff_9');
  });

  it('refuses to attribute an automatic discount to an operator', () => {
    const evaluation = evaluatePromotions([rule({ ruleCode: 'AUTO' })], CONTEXT);
    expect(() =>
      buildApplicationSnapshots(evaluation, {
        ...PLACEMENT,
        authorizedByStaffProfileId: 'staff_9',
      })
    ).toThrow(PromotionSnapshotError);
  });

  it('requires the presented code on a CUSTOMER_CODE application', () => {
    const evaluation = evaluatePromotions(
      [rule({ ruleCode: 'CODED', authority: 'CUSTOMER_CODE', promotionCode: 'EID25' })],
      { ...CONTEXT, presentedCodes: ['EID25'] }
    );
    expect(buildApplicationSnapshots(evaluation, PLACEMENT)[0]!.promotionCode).toBe('EID25');
  });
});

describe('reconstruction from snapshots alone', () => {
  it('rebuilds the total and the order without reading any rule', () => {
    const rows: StoredPromotionApplication[] = [
      // Deliberately out of order — reconstruction sorts by sequence.
      stored({ sequence: 2, ruleCode: 'SECOND', discountAmount: D('45.50') }),
      stored({ sequence: 1, ruleCode: 'FIRST', discountAmount: D('100.00') }),
    ];
    const result = reconstructCheckDiscounts(rows);
    expect(result.lines.map((line) => [line.sequence, line.ruleCode])).toEqual([
      [1, 'FIRST'],
      [2, 'SECOND'],
    ]);
    expect(result.totalDiscount.toFixed(2)).toBe('145.50');
  });

  it('reproduces the evaluation it came from, byte for byte', () => {
    const evaluation = evaluatePromotions(
      [
        rule({ ruleCode: 'A', priority: 5, benefitRate: D('0.125') }),
        rule({ ruleCode: 'B', priority: 2, benefitRate: D('0.075') }),
      ],
      CONTEXT
    );
    const persisted = buildApplicationSnapshots(evaluation, PLACEMENT);
    // Round-trip through the storage shape, dropping everything a reconstruction
    // is not allowed to depend on.
    const rows: StoredPromotionApplication[] = persisted.map((snapshot) => ({
      promotionId: snapshot.promotionId,
      promotionVersionId: snapshot.promotionVersionId,
      versionNumber: snapshot.versionNumber,
      ruleCode: snapshot.ruleCode,
      promotionCode: snapshot.promotionCode,
      targetScope: snapshot.targetScope,
      benefitKind: snapshot.benefitKind,
      benefitRate: snapshot.benefitRate,
      benefitAmount: snapshot.benefitAmount,
      authority: snapshot.authority,
      authorizedByStaffProfileId: snapshot.authorizedByStaffProfileId,
      sequence: snapshot.sequence,
      discountAmount: snapshot.discountAmount,
    }));

    const reconstructed = reconstructCheckDiscounts(rows);
    expect(reconstructed.totalDiscount.toFixed(2)).toBe(evaluation.totalDiscount.toFixed(2));
    expect(reconstructed.lines.map((line) => line.discountAmount.toFixed(2))).toEqual(
      evaluation.applications.map((application) => application.discountAmount.toFixed(2))
    );
  });

  it('explains each line in words from the row alone', () => {
    const result = reconstructCheckDiscounts([
      stored({ sequence: 1, benefitKind: 'PERCENTAGE_OFF', benefitRate: D('0.125') }),
      stored({
        sequence: 2,
        benefitKind: 'AMOUNT_OFF',
        benefitRate: null,
        benefitAmount: D('50.00'),
      }),
    ]);
    expect(result.lines.map((line) => line.explanation)).toEqual([
      '12.5% off (order)',
      '50.00 off (order)',
    ]);
  });

  it('describes every benefit kind without a rule', () => {
    expect(
      describeBenefit(
        stored({
          sequence: 1,
          benefitKind: 'FIXED_PRICE',
          benefitRate: null,
          benefitAmount: D('199.00'),
        })
      )
    ).toBe('fixed price 199.00 per unit (order)');
    expect(
      describeBenefit(stored({ sequence: 1, benefitKind: 'FREE_ITEM', benefitRate: null }))
    ).toBe('free item (order)');
    expect(
      describeBenefit(stored({ sequence: 1, benefitKind: 'BUY_X_GET_Y', benefitRate: null }))
    ).toBe('buy-x-get-y (order)');
  });

  it('preserves the authority and the operator behind a manager override', () => {
    const result = reconstructCheckDiscounts([
      stored({
        sequence: 1,
        authority: 'MANAGER_OVERRIDE',
        authorizedByStaffProfileId: 'staff_7',
      }),
    ]);
    expect(result.lines[0]).toMatchObject({
      authority: 'MANAGER_OVERRIDE',
      authorizedByStaffProfileId: 'staff_7',
    });
  });

  it('reconstructs an empty history as an exact zero, not as a missing value', () => {
    const result = reconstructCheckDiscounts([]);
    expect(result.lines).toEqual([]);
    expect(result.totalDiscount.toFixed(2)).toBe('0.00');
  });

  it('refuses a history with a gap rather than under-reporting the total', () => {
    expect(() =>
      reconstructCheckDiscounts([stored({ sequence: 1 }), stored({ sequence: 3 })])
    ).toThrow(PromotionSnapshotError);
  });

  it('refuses a history with a duplicated sequence', () => {
    expect(() =>
      reconstructCheckDiscounts([stored({ sequence: 1 }), stored({ sequence: 1 })])
    ).toThrow(PromotionSnapshotError);
  });

  it('refuses a non-positive stored amount', () => {
    expect(() =>
      reconstructCheckDiscounts([stored({ sequence: 1, discountAmount: D('0.00') })])
    ).toThrow(PromotionSnapshotError);
  });

  it('refuses a percentage row that lost its rate', () => {
    expect(() => reconstructCheckDiscounts([stored({ sequence: 1, benefitRate: null })])).toThrow(
      PromotionSnapshotError
    );
  });
});

describe('arithmetic audit of a stored snapshot', () => {
  it('re-derives a percentage amount from the row and the base it was taken on', () => {
    const row = stored({ sequence: 1, benefitRate: D('0.125'), discountAmount: D('125.00') });
    expect(recomputeSnapshotDiscount(row, D('1000.00'))!.toFixed(2)).toBe('125.00');
    expect(snapshotAgreesWithRule(row, D('1000.00'))).toBe(true);
  });

  it('detects a stored amount that never followed from its stored rate', () => {
    const tampered = stored({ sequence: 1, benefitRate: D('0.10'), discountAmount: D('900.00') });
    expect(snapshotAgreesWithRule(tampered, D('1000.00'))).toBe(false);
  });

  it('reports a unit-selecting kind as not re-derivable rather than as disagreeing', () => {
    const row = stored({ sequence: 1, benefitKind: 'FREE_ITEM', benefitRate: null });
    expect(recomputeSnapshotDiscount(row, D('1000.00'))).toBeNull();
    expect(snapshotAgreesWithRule(row, D('1000.00'))).toBe(true);
  });
});
