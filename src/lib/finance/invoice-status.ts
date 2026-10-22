export const INVOICE_STATUS_VALUES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'] as const;

export type InvoiceStatusValue = (typeof INVOICE_STATUS_VALUES)[number];

export const PAID_STATUS_ERROR = 'Record a payment to mark an invoice as paid.';

// Money is Decimal(12,2). Every paid-versus-total comparison uses a half-cent
// tolerance so a float artifact never tips an exact payoff either way.
export const PAYMENT_EPSILON = 0.005;

const TRANSITIONS: Record<InvoiceStatusValue, readonly InvoiceStatusValue[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['OVERDUE', 'CANCELLED', 'DRAFT'],
  OVERDUE: ['CANCELLED', 'SENT'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

// #398: a DRAFT is not owed yet and a CANCELLED invoice is void, so neither may
// carry recorded payments. A status-only change into either state would strand
// the payments (hidden from the payments panel, still counted nowhere) and the
// invoice could later come back "Sent" with its balance already covered.
const UNISSUED: readonly InvoiceStatusValue[] = ['DRAFT', 'CANCELLED'];

export function invoiceStatusLeavesUnissued(next: InvoiceStatusValue): boolean {
  return UNISSUED.includes(next);
}

export function invoiceStatusTransitionError(
  prior: InvoiceStatusValue,
  next: InvoiceStatusValue,
  context: { amountPaid?: number } = {}
): string | null {
  if (next === 'PAID') return PAID_STATUS_ERROR;
  if (prior === next) return null;
  if (!TRANSITIONS[prior].includes(next))
    return `Cannot change an invoice from ${prior} to ${next}.`;
  if (invoiceStatusLeavesUnissued(next) && (context.amountPaid ?? 0) > PAYMENT_EPSILON) {
    return next === 'CANCELLED'
      ? 'This invoice has recorded payments. Delete them before cancelling it.'
      : 'This invoice has recorded payments. Delete them before moving it back to draft.';
  }
  return null;
}

/** Statuses a status-only control may offer from `prior`. PAID is never one: it follows payments. */
export function invoiceStatusTargets(prior: InvoiceStatusValue): readonly InvoiceStatusValue[] {
  return TRANSITIONS[prior];
}

/** Where a PAID invoice goes when deleting a payment leaves part of it owed again. */
export function reopenedInvoiceStatus(dueDate: Date, now: Date): 'SENT' | 'OVERDUE' {
  return dueDate.getTime() < now.getTime() ? 'OVERDUE' : 'SENT';
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
