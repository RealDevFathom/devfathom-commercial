import 'server-only';

import type { Prisma } from '@/generated/prisma/client';

/**
 * M5-L1 / C10 — transactional receipt-number allocation.
 *
 * A bill receives its receipt number exactly once, at settlement, from a
 * per-(branch, businessDate) sequence row that is a SEPARATE seam from the order
 * numbering (§11.1: order numbers are not receipt numbers). Allocation MUST run
 * inside the caller's settlement transaction so uniqueness and monotonicity hold
 * under concurrent terminals. The allocation is a single row-locked upsert:
 * Prisma compiles this shape (a composite-unique `where`, scalar
 * `create`/`update`) to a native
 *
 *   INSERT ... VALUES (..., nextNumber = 1)
 *   ON CONFLICT ("branchId", "businessDate")
 *   DO UPDATE SET "nextNumber" = "restaurant_receipt_number_sequences"."nextNumber" + 1
 *   RETURNING "nextNumber"
 *
 * — so the first allocation for a (branch, businessDate) returns 1 and each later
 * one returns the next integer. The ON CONFLICT DO UPDATE takes a row lock, so
 * two concurrent allocations serialize and never collide (the unique
 * (branchId, businessDate) index is the backstop). Receipt numbers are
 * guaranteed unique and monotone; they are NOT guaranteed gap-free — a rolled-
 * back settlement consumes a number — and carry no fiscal/printer semantics
 * (BUILD-ASSUMPTIONS). Mirrors src/lib/restaurant/order-numbers.ts.
 *
 * `organizationId` is intentionally omitted from `create`: it defaults in the DB
 * from the transaction-local `app.current_organization_id` setting (the same
 * bare RLS-guarded default as every restaurant table), so the caller cannot forge
 * or omit the wrong tenant.
 */

/** The minimal transaction-client surface this allocator needs. The Prisma
 * interactive transaction client satisfies it. */
export type ReceiptNumberSequenceClient = Pick<
  Prisma.TransactionClient,
  'restaurantReceiptNumberSequence'
>;

export type AllocateReceiptNumberInput = {
  branchId: string;
  /** The business date already resolved by business-date.ts (a UTC-midnight Date
   * for the `@db.Date` column). */
  businessDate: Date;
};

/**
 * Allocate the next receipt number for `(branchId, businessDate)` inside the
 * caller's transaction and return it. See the module doc for the atomicity
 * contract.
 */
export async function allocateReceiptNumber(
  tx: ReceiptNumberSequenceClient,
  input: AllocateReceiptNumberInput
): Promise<number> {
  const row = await tx.restaurantReceiptNumberSequence.upsert({
    where: {
      branchId_businessDate: { branchId: input.branchId, businessDate: input.businessDate },
    },
    create: { branchId: input.branchId, businessDate: input.businessDate, nextNumber: 1 },
    update: { nextNumber: { increment: 1 } },
    select: { nextNumber: true },
  });
  return row.nextNumber;
}
