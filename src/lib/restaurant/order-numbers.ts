import 'server-only';

import type { Prisma } from '@/generated/prisma/client';

/**
 * M4-L1 / C5 — transactional human order-number allocation.
 *
 * The human order number is allocated from a per-(branch, businessDate) sequence
 * row. Allocation MUST run inside the caller's transaction (the same transaction
 * that creates the order) so uniqueness and monotonicity hold under concurrent
 * terminals. The allocation is a single row-locked upsert: Prisma compiles this
 * shape (a composite-unique `where`, scalar `create`/`update`) to a native
 *
 *   INSERT ... VALUES (..., nextNumber = 1)
 *   ON CONFLICT ("branchId", "businessDate")
 *   DO UPDATE SET "nextNumber" = "restaurant_order_number_sequences"."nextNumber" + 1
 *   RETURNING "nextNumber"
 *
 * — so the first allocation for a (branch, businessDate) returns 1 and each later
 * one returns the next integer. The ON CONFLICT DO UPDATE takes a row lock, so
 * two concurrent allocations serialize and never collide (the unique
 * (branchId, businessDate) index is the backstop). Numbers are guaranteed unique
 * and monotone; they are NOT guaranteed gap-free — a rolled-back order consumes a
 * number (BUILD-ASSUMPTIONS). Order numbers are not receipt numbers (§11.1).
 *
 * `organizationId` is intentionally omitted from `create`: it defaults in the DB
 * from the transaction-local `app.current_organization_id` setting (the same
 * bare RLS-guarded default as every restaurant table), so the caller cannot forge
 * or omit the wrong tenant.
 */

/** The minimal transaction-client surface this allocator needs. The Prisma
 * interactive transaction client satisfies it. */
export type OrderNumberSequenceClient = Pick<
  Prisma.TransactionClient,
  'restaurantOrderNumberSequence'
>;

export type AllocateOrderNumberInput = {
  branchId: string;
  /** The business date already resolved by business-date.ts (a UTC-midnight Date
   * for the `@db.Date` column). */
  businessDate: Date;
};

/**
 * Allocate the next order number for `(branchId, businessDate)` inside the
 * caller's transaction and return it. See the module doc for the atomicity
 * contract.
 */
export async function allocateOrderNumber(
  tx: OrderNumberSequenceClient,
  input: AllocateOrderNumberInput
): Promise<number> {
  const row = await tx.restaurantOrderNumberSequence.upsert({
    where: {
      branchId_businessDate: { branchId: input.branchId, businessDate: input.businessDate },
    },
    create: { branchId: input.branchId, businessDate: input.businessDate, nextNumber: 1 },
    update: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });
  return row.nextNumber;
}
