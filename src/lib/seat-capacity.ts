import type { Prisma } from '@/generated/prisma/client';

const OCCUPIED_SEAT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INVITED'] as const;

/** Serialize and validate a write that will add an occupied organization seat. */
export async function lockAndAssertSeatAvailable(
  tx: Prisma.TransactionClient,
  organizationId: string,
  seatLimit: number,
  errorForMessage: (message: string) => Error = (message) => new Error(message)
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`;
  const activeSeats = await tx.user.count({
    where: { organizationId, status: { in: [...OCCUPIED_SEAT_STATUSES] } },
  });
  if (activeSeats >= seatLimit) {
    throw errorForMessage(`Seat limit reached (${activeSeats}/${seatLimit}).`);
  }
}
