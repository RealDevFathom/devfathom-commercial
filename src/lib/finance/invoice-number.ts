import type { Prisma } from '@/generated/prisma/client';

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
