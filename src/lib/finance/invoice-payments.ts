import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import {
  invoiceStatusLeavesUnissued,
  invoiceStatusTransitionError,
  type InvoiceStatusValue,
} from './invoice-status';

type LockDb = Pick<Prisma.TransactionClient, '$queryRaw'>;
type PaymentsDb = Pick<Prisma.TransactionClient, 'payment'>;

const roundCents = (n: number) => Math.round(n * 100) / 100;

/**
 * #398: take the invoice's row lock for the rest of the transaction. Every
 * writer that reads "what has been paid" and then acts on it (recording or
 * deleting a payment, marking paid, editing the total, or a status change that
 * must not strand payments) takes this lock first, so two of them can never act
 * on the same stale balance. Row-level security still applies: an invoice the
 * tenant cannot see locks nothing and the caller's own read reports it missing.
 */
export async function lockInvoiceRow(db: LockDb, invoiceId: string): Promise<void> {
  await db.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
}

/** Sum of the payments recorded against an invoice, in cents-rounded currency units. */
export async function recordedInvoicePayments(db: PaymentsDb, invoiceId: string): Promise<number> {
  const recorded = await db.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } });
  return roundCents(Number(recorded._sum.amount ?? 0));
}

/**
 * The status-only transition check every API surface shares, including the
 * payment rule: moving to DRAFT or CANCELLED is refused while payments exist.
 * Must run inside the transaction that then writes the status, because it locks
 * the invoice row before counting payments.
 */
export async function invoiceStatusChangeError(
  db: LockDb & PaymentsDb,
  invoiceId: string,
  prior: InvoiceStatusValue,
  next: InvoiceStatusValue
): Promise<string | null> {
  const error = invoiceStatusTransitionError(prior, next);
  if (error || prior === next || !invoiceStatusLeavesUnissued(next)) return error;
  await lockInvoiceRow(db, invoiceId);
  return invoiceStatusTransitionError(prior, next, {
    amountPaid: await recordedInvoicePayments(db, invoiceId),
  });
}
