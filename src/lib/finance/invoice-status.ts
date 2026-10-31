export const INVOICE_STATUS_VALUES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const;

export type InvoiceStatusValue = (typeof INVOICE_STATUS_VALUES)[number];

export const PAID_STATUS_ERROR = 'Record a payment to mark an invoice as paid.';

const TRANSITIONS: Record<InvoiceStatusValue, readonly InvoiceStatusValue[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['OVERDUE', 'CANCELLED', 'DRAFT'],
  OVERDUE: ['CANCELLED', 'SENT'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function invoiceStatusTransitionError(
  prior: InvoiceStatusValue,
  next: InvoiceStatusValue
): string | null {
  if (next === 'PAID') return PAID_STATUS_ERROR;
  if (prior === next || TRANSITIONS[prior].includes(next)) return null;
  return `Cannot change an invoice from ${prior} to ${next}.`;
}

/**
 * Fields owned by a status transition, shared by every API surface.
 *
 * `sentAt` is deliberately omitted when leaving SENT for OVERDUE or CANCELLED so
 * Prisma preserves the original delivery timestamp. Returning to DRAFT is the
 * only transition that clears it.
 */
export function invoiceStatusUpdate(
  prior: InvoiceStatusValue,
  next: InvoiceStatusValue,
  changedAt: Date,
  total?: number
): { status: InvoiceStatusValue; sentAt?: Date | null; paidAt?: Date | null } {
  // A fully discounted draft is issued and settled together; no cash changed hands.
  if (next === 'SENT' && total === 0) {
    return { status: 'PAID', sentAt: changedAt, paidAt: changedAt };
  }
  const data: { status: InvoiceStatusValue; sentAt?: Date | null; paidAt?: Date | null } = {
    status: next,
  };
  if (next === 'SENT') data.sentAt = changedAt;
  else if (next === 'DRAFT') data.sentAt = null;
  if (prior === 'PAID' || next === 'DRAFT') data.paidAt = null;
  return data;
}
