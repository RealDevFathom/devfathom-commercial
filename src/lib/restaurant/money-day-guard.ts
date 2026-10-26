import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type DailyCloseErrorReason =
  | 'UNSETTLED_BILL'
  | 'OPEN_DRAWER'
  | 'CLOSE_EXISTS'
  | 'NOTHING_TO_CORRECT'
  | 'NOT_TIP'
  | 'CO_AUTH_REQUIRED'
  | 'REASON_REQUIRED'
  | 'CLOSE_NOT_FOUND'
  | 'INVALID';

export class DailyCloseError extends Error {
  constructor(
    message: string,
    readonly reason: DailyCloseErrorReason
  ) {
    super(message);
    this.name = 'DailyCloseError';
  }
}

/** Serialize a close chain at the organization + branch + business-date grain.
 * The transaction-scoped advisory lock releases automatically on commit/rollback. */
async function lockDailyClose(
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
  await lockDailyClose(tx, branchId, businessDate.toISOString().slice(0, 10));
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
