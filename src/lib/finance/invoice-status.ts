export const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const;

// Backwards-compatible name used by the REST invoice contract.
export const INVOICE_STATUS_VALUES = INVOICE_STATUSES;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoiceStatusValue = InvoiceStatus;

export const PAID_STATUS_ERROR = 'Record a payment to mark an invoice as paid.';

// PAID is intentionally not a destination: an invoice may only become paid via
// the payment flow, which preserves the invoice/payment money invariants.
export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['OVERDUE', 'CANCELLED', 'DRAFT'],
  OVERDUE: ['CANCELLED', 'SENT'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function getInvoiceStatusTransitions(status: InvoiceStatus): readonly InvoiceStatus[] {
  return INVOICE_STATUS_TRANSITIONS[status];
}

export function canTransitionInvoiceStatus(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return from !== to && to !== 'PAID' && getInvoiceStatusTransitions(from).includes(to);
}

export function invoiceStatusTransitionError(
  prior: InvoiceStatus,
  next: InvoiceStatus
): string | null {
  if (next === 'PAID') return PAID_STATUS_ERROR;
  if (prior === next || canTransitionInvoiceStatus(prior, next)) return null;
  return `Cannot change an invoice from ${prior} to ${next}.`;
}

/** Fields changed by every non-no-op status transition, shared by every API surface. */
export function invoiceStatusUpdate(
  prior: InvoiceStatus,
  next: InvoiceStatus,
  changedAt: Date
): { status: InvoiceStatus; sentAt?: Date | null; paidAt?: null } {
  const data: { status: InvoiceStatus; sentAt?: Date | null; paidAt?: null } = { status: next };
  if (next === 'SENT') data.sentAt = changedAt;
  else if (prior === 'SENT') data.sentAt = null;
  if (prior === 'PAID' || next === 'DRAFT') data.paidAt = null;
  return data;
}
