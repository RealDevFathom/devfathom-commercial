export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PAID', 'OVERDUE', 'CANCELLED', 'DRAFT'],
  OVERDUE: ['PAID', 'CANCELLED', 'SENT'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export type InvoiceStatusUpdate = {
  status: InvoiceStatus;
  paidAt?: Date | null;
  sentAt?: Date | null;
};

/**
 * Build the timestamp changes associated with an invoice status transition.
 * `sentAt` records when an invoice was issued, so later lifecycle states retain
 * it. Returning an invoice to DRAFT is the only transition that un-issues it.
 */
export function invoiceStatusUpdate(
  prior: InvoiceStatus,
  next: InvoiceStatus,
  timestamp: Date = new Date()
): InvoiceStatusUpdate {
  const data: InvoiceStatusUpdate = { status: next };

  if (next === 'PAID') data.paidAt = timestamp;
  if (next === 'SENT') data.sentAt = timestamp;
  if (prior === 'PAID' && next !== 'PAID') data.paidAt = null;
  if (next === 'DRAFT') {
    data.sentAt = null;
    data.paidAt = null;
  }

  return data;
}
