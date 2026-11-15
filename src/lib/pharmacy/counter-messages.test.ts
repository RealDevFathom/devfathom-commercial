import { describe, expect, it } from 'vitest';

import {
  COUNTER_ERROR_MESSAGES,
  COUNTER_GENERIC_ERROR_MESSAGE,
  COUNTER_UNKNOWN_ERROR_MESSAGE,
  counterBillMovedOn,
  counterErrorMessage,
  counterErrorTone,
} from './counter-messages';
import { PharmacyLoyaltyError } from './customer-loyalty';
import { PharmacySaleError } from './sales';
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
      'Open the cash drawer for this counter before taking a payment.'
    );
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
      // DEV-712: these three fell through to "Refresh and try again".
      'INVALID_MANUAL_CAPTURE',
      'INVALID_RECEIPT_LEASE',
      'LEASE_REQUIRES_SETTLEMENT',
      'DAY_CLOSED',
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
});

/**
 * DEV-712: after payment the counter told the cashier the bill "has already
 * moved on. Refresh the counter and try again" in a red banner — for a routine
 * state the counter now resolves itself.
 */
describe('counter notices after a bill moves on (DEV-712)', () => {
  it('never sends the operator to refresh for a settled bill', () => {
    for (const reason of ['INVALID_STATE', 'SALE_NOT_OPEN'] as const) {
      const message = counterErrorMessage(new Error(reason));
      expect(message).not.toMatch(/refresh/i);
      expect(message).toMatch(/next bill/);
      // A held bill can be resumed, so the sentence must not claim it was paid.
      expect(message).toMatch(/on hold/);
      expect(message).toMatch(/Resume/);
    }
  });

  it('recognises only the refusals that mean the bill is no longer open', () => {
    expect(counterBillMovedOn(new PharmacySaleError('INVALID_STATE'))).toBe(true);
    expect(counterBillMovedOn(new PharmacySettlementError('SALE_NOT_OPEN'))).toBe(true);
    expect(counterBillMovedOn(new PharmacySettlementError('DRAWER_NOT_OPEN'))).toBe(false);
    expect(counterBillMovedOn(new Error('That bill is closed.'))).toBe(false);
    expect(counterBillMovedOn('INVALID_STATE')).toBe(false);
  });

  it('shows routine state as information, not danger', () => {
    for (const reason of ['INVALID_STATE', 'SALE_NOT_OPEN', 'DRAWER_NOT_OPEN', 'NOT_FOUND'])
      expect(counterErrorTone(new Error(reason)), reason).toBe('info');
  });

  it('keeps danger for controlled-drug blocks and a payment in doubt', () => {
    for (const reason of ['COAUTH_REQUIRED', 'CONSENT_REQUIRED', 'IDEMPOTENCY_CONFLICT'])
      expect(counterErrorTone(new Error(reason)), reason).toBe('danger');
  });

  it('keeps an unknown or prose refusal as danger, so a safety denial is never quietened', () => {
    expect(counterErrorTone(new Error('SOME_FUTURE_REASON'))).toBe('danger');
    expect(counterErrorTone(new Error('Controlled medicine needs a pharmacist.'))).toBe('danger');
    expect(counterErrorTone(null)).toBe('danger');
  });

  it('names both remedies for a refused manual transfer', () => {
    const message = counterErrorMessage(new PharmacySettlementError('INVALID_MANUAL_CAPTURE'));
    expect(message).toMatch(/payer name and transaction reference/);
    // The same code covers a branch with no merchant details for the tender.
    expect(message).toMatch(/set up this payment method/);
  });

  it('shows a correctable mapped refusal as a warning', () => {
    expect(counterErrorTone(new Error('OVER_TENDER'))).toBe('warning');
    expect(counterErrorTone(new Error('INVALID_MANUAL_CAPTURE'))).toBe('warning');
    // The payment is still refused on the server; the batch needs replacing.
    expect(counterErrorTone(new Error('SALE_BATCH_RECALLED'))).toBe('warning');
    expect(counterErrorTone(new Error('REFUND_EXCEEDS_TENDER'))).toBe('warning');
  });
});
