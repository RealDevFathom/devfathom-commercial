import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  assertRefundWithinTender,
  computePharmacyClose,
  PharmacySettlementError,
  requireReleaseSafeAdapter,
  saleTotalMinor,
} from './settlement';

describe('pharmacy settlement invariants', () => {
  it('uses exact integer minor units for split coverage', () => {
    expect(
      saleTotalMinor([
        { quantity: 2, unitPriceMinor: 501, discountMinor: 1 },
        { quantity: 1, unitPriceMinor: 99, discountMinor: 0 },
      ])
    ).toBe(1100);
  });

  it('caps cumulative refunds at the original tender', () => {
    expect(() => assertRefundWithinTender(1_000, 600, 401)).toThrowError(
      expect.objectContaining({ reason: 'REFUND_EXCEEDS_TENDER' })
    );
    expect(() => assertRefundWithinTender(1_000, 600, 400)).not.toThrow();
  });

  it('makes a mock adapter impossible in a release build', () => {
    const adapter = { name: 'MOCK', certified: true, execute: vi.fn() };
    expect(() => requireReleaseSafeAdapter(adapter, 'production')).toThrowError(
      expect.objectContaining({ reason: 'MOCK_PROVIDER_IN_RELEASE' })
    );
  });

  it('rejects uncertified providers in every environment', () => {
    const adapter = { name: 'wallet-demo', certified: false, execute: vi.fn() };
    expect(() => requireReleaseSafeAdapter(adapter, 'test')).toThrow(PharmacySettlementError);
  });

  it('reproduces a close from immutable sources regardless of read order', () => {
    const a = computePharmacyClose({
      sales: [
        { id: 'b', totalMinor: 700 },
        { id: 'a', totalMinor: 300 },
      ],
      refunds: [{ id: 'r', amountMinor: 125 }],
      drawers: [{ id: 'd', expectedMinor: 1_500, countedMinor: 1_490 }],
    });
    const b = computePharmacyClose({
      sales: [
        { id: 'a', totalMinor: 300 },
        { id: 'b', totalMinor: 700 },
      ],
      refunds: [{ id: 'r', amountMinor: 125 }],
      drawers: [{ id: 'd', expectedMinor: 1_500, countedMinor: 1_490 }],
    });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ netSalesMinor: 875, cashVarianceMinor: -10 });
  });
});
