import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { DailyCloseError } from './daily-close-errors';

/** Serialize money writes at the organization + branch + business-date grain. */
export async function lockMoneyDay(
  tx: ScopedDb,
  branchId: string,
  businessDate: string
): Promise<void> {
  const branch = await tx.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { organizationId: true },
  });
  if (!branch) throw new DailyCloseError('The branch does not exist.', 'INVALID');
  const key = `${branch.organizationId}:${branchId}:${businessDate}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Money writers hold the same lock as cut/correct until their transaction ends.
 * ponytail: branch-day serialization; use shared writer locks if throughput requires it. */
export async function assertMoneyDayOpen(
  tx: ScopedDb,
  branchId: string,
  businessDate: Date
): Promise<void> {
  await lockMoneyDay(tx, branchId, businessDate.toISOString().slice(0, 10));
  const close = await tx.restaurantDailyClose.findFirst({
    where: { branchId, businessDate },
    select: { id: true },
  });
  if (close) {
    throw new DailyCloseError(
      'This business day is closed; no money can be posted.',
      'CLOSE_EXISTS'
    );
  }
}
