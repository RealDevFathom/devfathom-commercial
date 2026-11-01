import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@/generated/prisma/client';

const OCCUPIED_SEAT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INVITED'] as const;

export function occupiesSeat(status: string): boolean {
  return (OCCUPIED_SEAT_STATUSES as readonly string[]).includes(status);
}

export async function lockOrganizationSeat(
  tx: Prisma.TransactionClient,
  organizationId: string,
  seatLimit?: number,
  existingUserId?: string
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`;
  if (existingUserId) {
    // Keep the exemption tenant-bound even when this helper is called from a
    // platform-scoped transaction. An id from another organization must never
    // make this organization look as though it is only reusing an occupied
    // seat.
    const current = await tx.user.findFirst({
      where: { id: existingUserId, organizationId },
      select: { status: true },
    });
    if (current && occupiesSeat(current.status)) return;
  }
  seatLimit ??= (await resolveOrganizationEntitlements(organizationId, tx)).seatLimit;
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

