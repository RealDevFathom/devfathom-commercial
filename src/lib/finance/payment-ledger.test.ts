import { describe, expect, it } from 'vitest';
import {
  PAYMENT_LEDGER_LOCKED_MESSAGE,
  paymentLedgerDeleteError,
  paymentLedgerUpdateError,
} from './payment-ledger';

const paidAt = new Date('2026-10-22T14:50:00.000Z');
const linked = { paymentId: 'payment-6', type: 'INCOME', amount: '100.00', date: paidAt };
const manual = { ...linked, paymentId: null };

describe('payment-posted ledger rows (DEV-166)', () => {
  it('rejects deleting a row an invoice payment posted', () => {
    expect(paymentLedgerDeleteError(linked)).toBe(PAYMENT_LEDGER_LOCKED_MESSAGE);
  });

  it('allows deleting a manually entered row', () => {
    expect(paymentLedgerDeleteError(manual)).toBeNull();
  });

  it.each([
    ['type', { type: 'EXPENSE' }],
    ['amount', { amount: 0.01 }],
    ['date', { date: new Date('2026-10-01T00:00:00.000Z') }],
    ['an unparseable date', { date: new Date('not a date') }],
  ])('rejects changing the %s of a payment-posted row', (_field, change) => {
    expect(paymentLedgerUpdateError(linked, change)).toBe(PAYMENT_LEDGER_LOCKED_MESSAGE);
  });

  it('allows resubmitting unchanged money fields with descriptive edits', () => {
    expect(
      paymentLedgerUpdateError(linked, {
        type: 'INCOME',
        amount: 100,
        date: new Date(paidAt.getTime()),
      })
    ).toBeNull();
    expect(paymentLedgerUpdateError(linked, {})).toBeNull();
    expect(paymentLedgerUpdateError(linked, { type: null, amount: null, date: null })).toBeNull();
  });

  it('leaves manually entered rows fully editable', () => {
    expect(
      paymentLedgerUpdateError(manual, { type: 'EXPENSE', amount: 5, date: new Date() })
    ).toBeNull();
  });
});
