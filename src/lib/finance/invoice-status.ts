export const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PAID', 'OVERDUE', 'CANCELLED', 'DRAFT'],
  OVERDUE: ['PAID', 'CANCELLED', 'SENT'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

export function getInvoiceStatusTransitions(status: InvoiceStatus): readonly InvoiceStatus[] {
  return INVOICE_STATUS_TRANSITIONS[status];
}

export function canTransitionInvoiceStatus(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return getInvoiceStatusTransitions(from).includes(to);
}
