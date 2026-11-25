import type { Prisma } from '@/generated/prisma/client';

/** A withdrawn warehouse line stays on its original document for audit. */
export const outstandingTransferLine = {
  NOT: { warehouseReservation: { is: { state: 'CANCELLED' } } },
} satisfies Prisma.PharmacyInterbranchTransferLineWhereInput;
