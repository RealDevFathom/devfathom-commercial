import { TRPCError } from '@trpc/server';

import { isPrismaError } from '@/server/trpc-database-errors';

/**
 * DEV-877: a journal posting refused because its accounting period is closed.
 *
 * Every pharmacy path that writes the ledger (counter sales and tenders,
 * refunds, purchasing deliveries, transfers, counts, write-offs, opening
 * stock, offline replay) goes through the shared journal primitive, which
 * throws `FinancePostingError('PERIOD_CLOSED')`. A writer that bypasses it is
 * stopped by the database trigger, which raises
 * `PHARMACY_ACCOUNTING_PERIOD_CLOSED`. Either way the transaction rolled back
 * and nothing was posted, so the caller gets a typed BAD_REQUEST with the same
 * `PERIOD_CLOSED` reason the khata and bookkeeping refusals already use —
 * never an INTERNAL_SERVER_ERROR. Errors are recognised by name so this module
 * stays free of the journal's database imports.
 */
export const PERIOD_CLOSED_REASON = 'PERIOD_CLOSED';
const DATABASE_PERIOD_CLOSED = 'PHARMACY_ACCOUNTING_PERIOD_CLOSED';

export function isAccountingPeriodClosedError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'FinancePostingError')
    return (value as { reason?: unknown }).reason === PERIOD_CLOSED_REASON;
  const { message, name } = value;
  return (
    (name === 'DriverAdapterError' || isPrismaError(value)) &&
    message.includes(DATABASE_PERIOD_CLOSED)
  );
}

/**
 * The typed refusal for an unexpected failure caused by a closed accounting
 * period, or null. A TRPCError a router threw on purpose keeps its own code.
 */
export function mapAccountingPeriodError(error: TRPCError): TRPCError | null {
  if (error.code !== 'INTERNAL_SERVER_ERROR' || !isAccountingPeriodClosedError(error.cause))
    return null;
  return new TRPCError({ code: 'BAD_REQUEST', message: PERIOD_CLOSED_REASON, cause: error.cause });
}
