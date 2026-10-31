import type { Prisma } from '@/generated/prisma/client';

/** Keep direct seed inserts in sync without rewinding numbers already reserved. */
export async function advanceInvoiceNumberSequence(
  tx: Prisma.TransactionClient,
  organizationId: string,
  year: number,
  lastNumber: number
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO invoice_number_sequences ("organizationId", year, "lastNumber")
    VALUES (${organizationId}, ${year}, ${lastNumber})
    ON CONFLICT ("organizationId", year) DO UPDATE
      SET "lastNumber" = GREATEST(invoice_number_sequences."lastNumber", EXCLUDED."lastNumber"),
          "updatedAt" = CURRENT_TIMESTAMP
  `;
}

/**
 * Atomically reserves the next invoice number for one tenant and calendar year.
 * Call this inside the same transaction that creates the invoice so a failed
 * create rolls the reservation back as well.
 */
export async function reserveInvoiceNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  year = new Date().getFullYear()
): Promise<string> {
  const sequence = await tx.invoiceNumberSequence.upsert({
    where: { organizationId_year: { organizationId, year } },
    create: { organizationId, year, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return `INV-${year}-${String(sequence.lastNumber).padStart(3, '0')}`;
}
