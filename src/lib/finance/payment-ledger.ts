import { roundMoney } from './money';

/**
 * DEV-166: recording an invoice payment posts a linked INCOME transaction
 * (`transactions.paymentId`). Revenue reports read that ledger row while the
 * invoice's settled amount is derived from the payment, so the row's money
 * fields must only change through the payment itself. Deleting the payment
 * cascades to its ledger row.
 */
export const PAYMENT_LEDGER_LOCKED_MESSAGE =
  'This income was posted by an invoice payment. Delete the payment on the invoice instead.';

type LedgerRow = {
  paymentId: string | null;
  type: string;
  amount: unknown;
  date: Date;
};

type LedgerChange = {
  type?: string | null;
  amount?: number | null;
  date?: Date | null;
};

/** Returns an error message when a delete would desynchronize a payment's revenue. */
export function paymentLedgerDeleteError(row: Pick<LedgerRow, 'paymentId'>): string | null {
  return row.paymentId ? PAYMENT_LEDGER_LOCKED_MESSAGE : null;
}

/**
 * Returns an error message when an update would change the type, amount or date
 * of a payment-posted row. Unchanged values and descriptive fields are allowed.
 */
export function paymentLedgerUpdateError(row: LedgerRow, change: LedgerChange): string | null {
  if (!row.paymentId) return null;
  if (change.type != null && change.type !== row.type) return PAYMENT_LEDGER_LOCKED_MESSAGE;
  if (change.amount != null && roundMoney(change.amount) !== roundMoney(Number(row.amount))) {
    return PAYMENT_LEDGER_LOCKED_MESSAGE;
  }
  if (change.date != null && change.date.getTime() !== row.date.getTime()) {
    return PAYMENT_LEDGER_LOCKED_MESSAGE;
  }
  return null;
}
