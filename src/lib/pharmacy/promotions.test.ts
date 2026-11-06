import { describe, expect, it, vi } from 'vitest';
import type { PharmacyPromotion } from '@/generated/prisma/client';
import {
  evaluatePharmacyPromotion,
  pharmacyPromotionInput,
  priceCounterPromotion,
} from './promotions';

const start = new Date('2026-11-01T19:00:00.000Z'); // Midnight in Pakistan.
const end = new Date('2026-11-02T19:00:00.000Z');
const scope = { organizationId: 'org-727', branchId: 'branch-727', actorId: 'cashier' };
const base = {
  ...scope,
  medicineId: 'otc',
  regulated: false,
  grossMinor: 1005,
  costMinor: 500,
  at: start,
};
function offer(overrides: Partial<PharmacyPromotion> = {}): PharmacyPromotion {
  return {
    id: 'offer',
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    name: 'November offer',
    medicineId: null,
    effectiveFrom: start,
    effectiveTo: end,
    benefitBasisPoints: 1000,
    benefitMinor: null,
    priority: 0,
    active: true,
    createdByUserId: 'owner',
    createdAt: start,
    ...overrides,
  };
}
const evaluate = (overrides: Partial<Parameters<typeof evaluatePharmacyPromotion>[0]> = {}) =>
  evaluatePharmacyPromotion({ ...base, promotions: [offer()], ...overrides });

describe('#727 pharmacy date-based promotion evaluation', () => {
  it('includes the start instant and excludes the end, independent of host timezone', () => {
    expect(evaluate({ at: new Date(start.getTime() - 1) })).toBeNull();
    expect(evaluate()?.discountMinor).toBe(101);
    expect(evaluate({ at: new Date(end.getTime() - 1) })?.discountMinor).toBe(101);
    expect(evaluate({ at: end })).toBeNull();
  });
  it('rounds a percentage once at the line level with exact half-up money', () => {
    expect(evaluate({ grossMinor: 15, costMinor: 0 })?.discountMinor).toBe(2);
    expect(
      evaluate({ grossMinor: 3, costMinor: 0, promotions: [offer({ benefitBasisPoints: 5000 })] })
        ?.discountMinor
    ).toBe(2);
  });
  it('applies a fixed benefit once and caps it at the gross, never creating credit', () => {
    expect(
      evaluate({ promotions: [offer({ benefitBasisPoints: null, benefitMinor: 125 })] })
        ?.discountMinor
    ).toBe(125);
    expect(
      evaluate({
        costMinor: 0,
        promotions: [offer({ benefitBasisPoints: null, benefitMinor: 9999 })],
      })?.discountMinor
    ).toBe(1005);
  });
  it.each([
    { active: false },
    { organizationId: 'other' },
    { branchId: 'other' },
    { medicineId: 'other' },
  ])('refuses ineligible offers: %j', (change) => {
    expect(evaluate({ promotions: [offer(change)] })).toBeNull();
  });
  it('accepts an exact medicine target and never discounts regulated medicine', () => {
    expect(evaluate({ promotions: [offer({ medicineId: 'otc' })] })?.discountMinor).toBe(101);
    expect(evaluate({ regulated: true })).toBeNull();
  });
  it('skips below-cost offers and deterministically selects one safe offer without stacking', () => {
    const candidates = [
      offer({ id: 'unsafe', priority: 10, benefitBasisPoints: 9000 }),
      offer({ id: 'b', priority: 1, benefitBasisPoints: 2000 }),
      offer({ id: 'a', priority: 1 }),
    ];
    for (const promotions of [candidates, [...candidates].reverse()]) {
      const result = evaluate({ promotions });
      expect(result?.promotion.id).toBe('a');
      expect(result?.discountMinor).toBe(101);
    }
    expect(evaluate({ costMinor: 905 })).toBeNull();
    expect(evaluate({ costMinor: 904 })?.discountMinor).toBe(101);
  });
  it('queries only active scoped offers at the server instant and avoids regulated queries', async () => {
    const findMany = vi.fn().mockResolvedValue([offer()]);
    const db = { pharmacyPromotion: { findMany } };
    expect((await priceCounterPromotion(db as never, scope, base))?.discountMinor).toBe(101);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        active: true,
        effectiveFrom: { lte: start },
        effectiveTo: { gt: start },
        OR: [{ medicineId: null }, { medicineId: 'otc' }],
      },
    });
    findMany.mockClear();
    expect(
      await priceCounterPromotion(db as never, scope, { ...base, regulated: true })
    ).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
  it('rejects unsafe amounts rather than rounding them into an offer', () => {
    expect(() => evaluate({ grossMinor: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
  });
});

describe('#727 promotion command validation', () => {
  const input = {
    branchId: scope.branchId,
    name: 'November offer',
    effectiveFrom: start,
    effectiveTo: end,
    benefitBasisPoints: 1000,
  };
  it('accepts percentage and fixed discounts with ordered instants', () => {
    expect(pharmacyPromotionInput.parse(input).priority).toBe(0);
    expect(
      pharmacyPromotionInput.safeParse({ ...input, benefitBasisPoints: undefined, benefitMinor: 1 })
        .success
    ).toBe(true);
  });
  it.each([
    { effectiveTo: start },
    { effectiveTo: new Date(start.getTime() - 1) },
    { benefitMinor: 1 },
    { benefitBasisPoints: undefined },
    { benefitBasisPoints: 10001 },
    { benefitBasisPoints: 0 },
    { benefitBasisPoints: 1.5 },
    { name: 'bad\nname' },
    { name: 'Offer\u202e' },
    { name: 'Offer\u2066x' },
    { name: ' ' },
    { name: 'x'.repeat(81) },
    { createdByUserId: 'spoof' },
  ])('rejects invalid or forged rule content: %j', (change) => {
    expect(pharmacyPromotionInput.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
