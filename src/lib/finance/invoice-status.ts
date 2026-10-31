export const INVOICE_STATUS_VALUES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const;

export type InvoiceStatusValue = (typeof INVOICE_STATUS_VALUES)[number];

export const PAID_STATUS_ERROR = 'Record a payment to mark an invoice as paid.';

const TRANSITIONS: Record<InvoiceStatusValue, readonly InvoiceStatusValue[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['OVERDUE', 'CANCELLED', 'DRAFT', 'PAID'],
  OVERDUE: ['CANCELLED', 'SENT', 'PAID'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function invoiceStatusTransitionError(
  prior: InvoiceStatusValue,
  next: InvoiceStatusValue,
  options: { recordsPayment?: boolean } = {}
): string | null {
  // Status-only callers (including REST) must not bypass the payment ledger.
  if (next === 'PAID' && !options.recordsPayment) return PAID_STATUS_ERROR;
  if (prior === next || TRANSITIONS[prior].includes(next)) return null;
  return `Cannot change an invoice from ${prior} to ${next}.`;
}

/** Fields changed by every non-no-op status transition, shared by every API surface. */
export function invoiceStatusUpdate(
  prior: InvoiceStatusValue,
  next: InvoiceStatusValue,
  changedAt: Date
): { status: InvoiceStatusValue; sentAt?: Date | null; paidAt?: null } {
  const data: { status: InvoiceStatusValue; sentAt?: Date | null; paidAt?: null } = {
    status: next,
  };
  if (next === 'SENT') data.sentAt = changedAt;
  else if (prior === 'SENT') data.sentAt = null;
  if (prior === 'PAID' || next === 'DRAFT') data.paidAt = null;
  return data;
}
