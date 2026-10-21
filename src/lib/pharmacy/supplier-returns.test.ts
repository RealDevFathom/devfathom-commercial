/**
 * PUR-06 — the pure return/claim kernel.
 *
 * These cases are about the decisions, not about Prisma: which transitions
 * exist, when a return window is closed, how much of a lot is still claimable
 * once INV-09 reservations are subtracted, and the arithmetic that keeps
 * expected and received credit two separate numbers. The database-backed twin
 * lives in `supplier-returns.db.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  assertAllocatable,
  assertClaimable,
  assertPurchaseReturnTransition,
  assertReturnWindowOpen,
  assertSettlementSegregation,
  claimableUnits,
  creditPosition,
  expectedCreditForLines,
  PharmacySupplierReturnError,
} from './supplier-returns';
import type { PurchaseReturnStatus } from './supplier-returns';

const AT = new Date('2026-09-02T09:00:00.000Z');

describe('PUR-06 — the return lifecycle', () => {
  it('allows only the transitions the document actually has', () => {
    const allowed: Array<[PurchaseReturnStatus, PurchaseReturnStatus]> = [
      ['DRAFT', 'SUBMITTED'],
      ['DRAFT', 'CANCELLED'],
      ['SUBMITTED', 'DISPATCHED'],
      ['SUBMITTED', 'CANCELLED'],
      ['DISPATCHED', 'SETTLED'],
    ];
    for (const [from, to] of allowed) {
      expect(() => assertPurchaseReturnTransition(from, to)).not.toThrow();
    }
  });

  it('refuses to skip submission, to reopen a settled return, or to cancel after dispatch', () => {
    const refused: Array<[PurchaseReturnStatus, PurchaseReturnStatus]> = [
      // A draft may not post movements without first taking the reservation.
      ['DRAFT', 'DISPATCHED'],
      // §8A invariant 8: once stock has left, the correction is a reversal.
      ['DISPATCHED', 'CANCELLED'],
      ['SETTLED', 'DISPATCHED'],
      ['CANCELLED', 'SUBMITTED'],
      ['SUBMITTED', 'SETTLED'],
    ];
    for (const [from, to] of refused) {
      expect(() => assertPurchaseReturnTransition(from, to)).toThrowError(
        PharmacySupplierReturnError
      );
    }
  });

  it('treats the supplier return window as closed at its deadline, not after it', () => {
    // Open one millisecond before the deadline; closed AT the deadline, so a
    // window that "ends at 09:00" cannot be used at 09:00.
    expect(() =>
      assertReturnWindowOpen({ returnWindowEndsAt: new Date(AT.getTime() + 1), at: AT })
    ).not.toThrow();
    for (const returnWindowEndsAt of [AT, new Date(AT.getTime() - 1)]) {
      try {
        assertReturnWindowOpen({ returnWindowEndsAt, at: AT });
        throw new Error('expected a rejection');
      } catch (error) {
        expect(error).toMatchObject({ reason: 'RETURN_WINDOW_CLOSED' });
      }
    }
  });

  it('keeps the actor who submitted a return off its own settlement (§8A invariant 26)', () => {
    expect(() =>
      assertSettlementSegregation({ submittedByUserId: 'u1', allocatedByUserId: 'u2' })
    ).not.toThrow();
    expect(() =>
      assertSettlementSegregation({ submittedByUserId: 'u1', allocatedByUserId: 'u1' })
    ).toThrowError(PharmacySupplierReturnError);
  });
});

describe('PUR-06 — claimable quantity is the INV-09 reservation, read once', () => {
  it('subtracts reserved units from on-hand', () => {
    expect(claimableUnits({ onHandUnits: 40, reservedUnits: 15 })).toBe(25);
  });

  it('never reports a negative claimable quantity', () => {
    expect(claimableUnits({ onHandUnits: 10, reservedUnits: 25 })).toBe(0);
  });

  it('refuses a second claim over units the first one already reserved', () => {
    // 40 on hand, 25 already reserved by an earlier claim: 15 remain. Asking for
    // 16 is exactly the double-claim PUR-06 forbids.
    expect(() =>
      assertClaimable({ onHandUnits: 40, reservedUnits: 25, requestedUnits: 15 })
    ).not.toThrow();
    try {
      assertClaimable({ onHandUnits: 40, reservedUnits: 25, requestedUnits: 16 });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'ALREADY_CLAIMED' });
    }
  });

  it('rejects a non-integer or non-positive quantity rather than rounding it', () => {
    for (const requestedUnits of [0, -5, 1.5, Number.NaN]) {
      expect(() =>
        assertClaimable({ onHandUnits: 40, reservedUnits: 0, requestedUnits })
      ).toThrowError(PharmacySupplierReturnError);
    }
  });
});

describe('PUR-06 — expected vs received credit stay two numbers', () => {
  it('freezes the expected credit as the sum of the return lines', () => {
    expect(
      expectedCreditForLines([{ expectedCreditMinor: 12_000 }, { expectedCreditMinor: 3_500 }])
    ).toBe(15_500);
  });

  it('reports an unsettled note as OPEN with the whole claim outstanding', () => {
    expect(creditPosition({ expectedCreditMinor: 15_500, allocations: [] })).toEqual({
      expectedCreditMinor: 15_500,
      receivedCreditMinor: 0,
      varianceMinor: 15_500,
      outstandingMinor: 15_500,
      status: 'OPEN',
    });
  });

  it('shows the shortfall when the supplier credits less than was claimed', () => {
    expect(
      creditPosition({ expectedCreditMinor: 15_500, allocations: [{ amountMinor: 9_000 }] })
    ).toEqual({
      expectedCreditMinor: 15_500,
      receivedCreditMinor: 9_000,
      varianceMinor: 6_500,
      outstandingMinor: 6_500,
      status: 'PARTIALLY_SETTLED',
    });
  });

  it('settles only when the received credit reaches the expected credit', () => {
    expect(
      creditPosition({
        expectedCreditMinor: 15_500,
        allocations: [{ amountMinor: 9_000 }, { amountMinor: 6_500 }],
      })
    ).toMatchObject({ receivedCreditMinor: 15_500, varianceMinor: 0, status: 'SETTLED' });
  });
});

describe('PUR-06 — allocation cannot invent money', () => {
  const base = {
    creditAmountMinor: 20_000,
    creditAlreadyAllocatedMinor: 0,
    noteExpectedCreditMinor: 15_500,
    noteAlreadyReceivedMinor: 0,
  };

  it('allows an allocation inside both ceilings', () => {
    expect(() => assertAllocatable({ ...base, amountMinor: 15_500 })).not.toThrow();
  });

  it('refuses to allocate more than the debit note is owed', () => {
    try {
      assertAllocatable({ ...base, amountMinor: 15_501 });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'OVER_ALLOCATION' });
    }
  });

  it('refuses to allocate a credit twice', () => {
    // The credit is 20 000 with 18 000 already spent elsewhere: only 2 000 left,
    // even though this note is owed far more.
    try {
      assertAllocatable({
        ...base,
        creditAlreadyAllocatedMinor: 18_000,
        amountMinor: 2_001,
      });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'OVER_ALLOCATION' });
    }
    expect(() =>
      assertAllocatable({ ...base, creditAlreadyAllocatedMinor: 18_000, amountMinor: 2_000 })
    ).not.toThrow();
  });

  it('refuses a zero, negative or fractional allocation', () => {
    for (const amountMinor of [0, -1, 12.5]) {
      expect(() => assertAllocatable({ ...base, amountMinor })).toThrowError(
        PharmacySupplierReturnError
      );
    }
  });
});
