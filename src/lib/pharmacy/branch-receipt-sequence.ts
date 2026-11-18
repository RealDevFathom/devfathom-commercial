import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-637: draw `count` consecutive receipt numbers from the branch's one sequence and
 * return the first. Online sales draw one; an offline counter leases a block. Every
 * counter of a branch shares this sequence, so no two receipts of a branch share a number.
 *
 * The database function takes the sequence row lock, so concurrent draws from several
 * counters serialize. A branch's first draw starts above every number it already issued
 * or leased under the old per-device sequences; those receipts keep their numbers.
 */
export async function allocateBranchReceiptNumbers(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  count: number
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
    SELECT pharmacy_allocate_branch_receipt_numbers(
      ${scope.organizationId}::text, ${scope.branchId}::text, ${count}::integer
    ) AS receipt_number`);
  return rows[0]!.receipt_number;
}
