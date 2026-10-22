import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALLET_TIERS, assertTopUpRefundAllowed, chooseBenefits, cnicHmac, cnicLast4,
  expiryIdempotencyKey, isCnicLocked, matchesCnicLast4, priceWalletPortion, selectWalletTier,
} from './stored-value-wallet';

describe('pharmacy stored-value wallet rules', () => {
  it('selects defaults and honours owner-edited thresholds', () => {
    expect(selectWalletTier(5_000_000, DEFAULT_WALLET_TIERS)?.name).toBe('Silver');
    expect(selectWalletTier(2_999, [{ name: 'Local', qualifyingTopUpMinor: 2_999, discountBps: 75 }])?.discountBps).toBe(75);
  });

  it('discounts only the wallet-funded portion when the balance is exhausted', () => {
    expect(priceWalletPortion(10_000, 4_900, 200)).toEqual({ walletDebitMinor: 4_900, discountMinor: 100, remainderMinor: 5_000 });
  });

  it('uses the best single benefit unless owner stacking is enabled', () => {
    expect(chooseBenefits({ walletDiscountMinor: 200, voucherDiscountMinor: 500, pointsDiscountMinor: 300, allowStacking: false }))
      .toEqual({ applied: [{ kind: 'VOUCHER', amountMinor: 500 }], totalMinor: 500 });
    expect(chooseBenefits({ walletDiscountMinor: 200, voucherDiscountMinor: 500, pointsDiscountMinor: 300, allowStacking: true }).totalMinor).toBe(1_000);
  });

  it('rejects wrong CNIC last four and locks either rate-limit dimension', () => {
    expect(matchesCnicLast4('1234', '1234')).toBe(true);
    expect(matchesCnicLast4('1235', '1234')).toBe(false);
    expect(isCnicLocked({ customerFailures: 5, cashierFailures: 0, limit: 5 })).toBe(true);
    expect(isCnicLocked({ customerFailures: 0, cashierFailures: 5, limit: 5 })).toBe(true);
  });

  it('retains only last four or a keyed digest', () => {
    const full = '35202-1234567-1';
    expect(cnicLast4(full)).toBe('5671');
    const digest = cnicHmac(full, 'test-only-secret');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain('3520212345671');
  });

  it('returns unused top-up only to its original method when policy permits', () => {
    expect(assertTopUpRefundAllowed({ allowUnusedRefund: true, requestedMinor: 2_000, unusedMinor: 3_000, originalTender: 'CARD' }))
      .toEqual({ amountMinor: 2_000, tender: 'CARD' });
    expect(() => assertTopUpRefundAllowed({ allowUnusedRefund: false, requestedMinor: 1, unusedMinor: 1, originalTender: 'CASH' })).toThrow('TOP_UP_REFUND_DISABLED');
    expect(() => assertTopUpRefundAllowed({ allowUnusedRefund: true, requestedMinor: 2, unusedMinor: 1, originalTender: 'CASH' })).toThrow('TOP_UP_ALREADY_USED');
  });

  it('gives expiry jobs a deterministic replay key', () => {
    expect(expiryIdempotencyKey('account-1', '2027-01-02')).toBe('wallet:expiry:account-1:2027-01-02');
  });
});
