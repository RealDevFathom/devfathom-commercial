import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

export type LateOfflineCash = {
  commandId: string;
  receiptNumber: number;
  amountMinor: number;
  soldAt: string;
  recordedAt: string;
  shiftId: string | null;
};
export async function lateOfflineCash(
  db: ScopedDb,
  scope: LedgerScope,
  filter: { shiftId: string } | { recordedDay: Date }
): Promise<LateOfflineCash[]> {
  await db.$queryRaw`SELECT set_config('app.current_branch_id',${scope.branchId},true)`;
  const selection =
    'shiftId' in filter
      ? Prisma.sql`"shiftId"=${filter.shiftId}`
      : Prisma.sql`"recordedDay"=${filter.recordedDay}::date`;
  const rows = await db.$queryRaw<
    (Omit<LateOfflineCash, 'soldAt' | 'recordedAt'> & { soldAt: Date; recordedAt: Date })[]
  >(Prisma.sql`
    SELECT "commandId","receiptNumber","amountMinor","soldAt","recordedAt","shiftId" FROM pharmacy_late_offline_cash
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND ${selection}
    ORDER BY "recordedAt","commandId"`);
  return rows.map((row) => ({
    ...row,
    soldAt: row.soldAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  }));
}
