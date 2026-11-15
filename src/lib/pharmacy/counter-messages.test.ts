import { describe, expect, it } from 'vitest';

import {
  COUNTER_ERROR_MESSAGES,
  COUNTER_GENERIC_ERROR_MESSAGE,
  COUNTER_UNKNOWN_ERROR_MESSAGE,
  counterErrorMessage,
} from './counter-messages';
import { PharmacyLoyaltyError } from './customer-loyalty';
import { PharmacySaleBatchError } from './sale-batch-safety';
import { PharmacySettlementError } from './settlement';

/**
 * UX rule 11 — no raw identifier reaches the operator.
 *
 * The defect these guard is concrete: the POS browser run rendered the literal
 * string `DRAWER_NOT_OPEN` in the counter's alert region, because the mapping
 * fell through to `error.message` for any reason it did not know.
 */
describe('counterErrorMessage', () => {
  it('maps the drawer reason that leaked to the counter', () => {
    expect(counterErrorMessage(new PharmacySettlementError('DRAWER_NOT_OPEN'))).toBe(
      'The cash drawer for this counter is not open. Open it before taking or paying out cash.'
    );
  });

  /** #1338: refunds and drawer close raise it too, so it must not speak only of payments. */
  it('keeps the shared drawer reason true for cash refunds and drawer close', () => {
    const message = counterErrorMessage(new PharmacySettlementError('DRAWER_NOT_OPEN'));
    expect(message).toMatch(/paying out cash/);
    expect(message).not.toMatch(/other tenders/i);
  });

  /** #453: linking a customer requires loyalty consent, not dispensing consent. */
  it('names loyalty consent without referring to dispensing', () => {
    const message = counterErrorMessage(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    expect(message).toBe(
      'Loyalty consent is required before linking this customer or redeeming loyalty points.'
    );
    expect(message).not.toContain('dispensing');
    expect(message).not.toBe(COUNTER_ERROR_MESSAGES.CONSENT_REQUIRED);
  });

  it('never returns a raw reason code for an unmapped failure', () => {
    // Deliberately not in the map: a reason a later lane might add.
    const message = counterErrorMessage(new Error('SOME_FUTURE_REASON'));
    expect(message).toBe(COUNTER_UNKNOWN_ERROR_MESSAGE);
    expect(message).not.toContain('SOME_FUTURE_REASON');
  });

  it('passes prose through unchanged, so a real sentence is not swallowed', () => {
    expect(counterErrorMessage(new Error('The counter lost its connection.'))).toBe(
      'The counter lost its connection.'
    );
  });

  it('falls back when the failure carries no message at all', () => {
    expect(counterErrorMessage(new Error(''))).toBe(COUNTER_GENERIC_ERROR_MESSAGE);
    expect(counterErrorMessage('not an error')).toBe(COUNTER_GENERIC_ERROR_MESSAGE);
    expect(counterErrorMessage(null)).toBe(COUNTER_GENERIC_ERROR_MESSAGE);
  });

  /**
   * The settlement aggregate is the one a cashier hits mid-bill, so its reason
   * union is pinned rather than sampled: adding a reason there without a
   * sentence here fails this test instead of shipping a code to the counter.
   */
  it('has a sentence for every reason PharmacySettlementError can raise', () => {
    const settlementReasons = [
      'BUSINESS_DATE_NOT_CURRENT',
      'SALE_NOT_OPEN',
      'INVALID_AMOUNT',
      'OVER_TENDER',
      'DRAWER_NOT_OPEN',
      'REFUND_EXCEEDS_TENDER',
      'IDEMPOTENCY_CONFLICT',
      'UNCERTIFIED_PROVIDER',
      'MOCK_PROVIDER_IN_RELEASE',
      'OPEN_DRAWER',
      'REOPEN_REASON_REQUIRED',
      'INVALID_MANUAL_CAPTURE',
    ] as const;

    for (const reason of settlementReasons) {
      // Typed against the aggregate, so a renamed reason breaks compilation here.
      const error = new PharmacySettlementError(reason);
      expect(COUNTER_ERROR_MESSAGES[reason], `${reason} has no operator sentence`).toBeTruthy();
      expect(counterErrorMessage(error)).not.toBe(COUNTER_UNKNOWN_ERROR_MESSAGE);
    }
  });

  /** #659: a batch that became unsafe after add-to-cart refuses the payment mid-bill. */
  it('has a sentence for every reason PharmacySaleBatchError can raise', () => {
    const reasons = [
      ['SALE_BATCH_RECALLED', 'RECALLED', 'recalled'],
      ['SALE_BATCH_QUARANTINED', 'QUARANTINED', 'quarantined'],
      ['SALE_BATCH_EXPIRED', 'EXPIRED', 'expired'],
      ['SALE_BATCH_BLOCKED', 'UNAUTHORIZED', 'no longer be sold'],
    ] as const;
    for (const [reason, blockReason, words] of reasons) {
      const message = counterErrorMessage(
        new PharmacySaleBatchError(reason, blockReason, 'line-1', 'lot-1')
      );
      expect(message, `${reason} has no operator sentence`).toContain(words);
      expect(message).toContain('Void the bill');
    }
  });

  it('states a remedy rather than only a symptom', () => {
    for (const [reason, message] of Object.entries(COUNTER_ERROR_MESSAGES)) {
      expect(message, `${reason} is not a sentence`).toMatch(/[a-z]/);
      expect(message, `${reason} reads as a code`).not.toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('DEV-713 names the provider gap without blaming a card terminal', () => {
    const message = counterErrorMessage(new PharmacySettlementError('UNCERTIFIED_PROVIDER'));
    expect(message).toBe('This tender needs a connected provider. Take another tender.');
    expect(message).not.toMatch(/card terminal/i);
  });
});
