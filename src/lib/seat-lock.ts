import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';

// Statuses that consume a licensed seat. Mirrors the seat count in
// resolveOrganizationEntitlements (src/lib/entitlements.ts).
export const OCCUPIED_SEAT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INVITED'] as const;

export function occupiesSeat(status: string): boolean {
  return (OCCUPIED_SEAT_STATUSES as readonly string[]).includes(status);
}

/**
 * Serialize seat allocation inside the caller's transaction: take a row lock on
 * the organization, recount occupied seats, and refuse if the limit is already
 * met. This closes the race where concurrent requests (invite / create-member /
 * reactivation) each read a stale seat snapshot and collectively exceed the
 * license.
 *
 * MUST be awaited inside a `$transaction` before creating or activating a user
 * that will occupy a seat.
 */
export async function lockOrganizationSeat(
  tx: Prisma.TransactionClient,
  organizationId: string,
  seatLimit: number
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`;
  const activeSeats = await tx.user.count({
    where: { organizationId, status: { in: [...OCCUPIED_SEAT_STATUSES] } },
  });
  if (activeSeats >= seatLimit) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Seat limit reached (${activeSeats}/${seatLimit}).`,
    });
  }
}
