import 'server-only';

import type { Prisma } from '@/generated/prisma/client';

type InvoiceNumberDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Atomically reserve the next yearly invoice number for an organization.
 *
 * This must be called on the same transaction client that creates the invoice.
 * PostgreSQL locks the conflicting (organizationId, year) row while incrementing
 * it, so concurrent callers serialize without relying on a count of invoice rows.
 */
export async function allocateInvoiceNumber(
  tx: InvoiceNumberDb,
  organizationId: string,
  year: number
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ lastNumber: number }>>`
    INSERT INTO "invoice_number_sequences" (
      "organizationId", "year", "lastNumber", "createdAt", "updatedAt"
    )
    VALUES (${organizationId}, ${year}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("organizationId", "year") DO UPDATE
      SET "lastNumber" = "invoice_number_sequences"."lastNumber" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "lastNumber"
  `;

  const sequence = rows[0]?.lastNumber;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Invoice number sequence did not return a valid value.');
  }
  return `INV-${year}-${String(sequence).padStart(3, '0')}`;
}
