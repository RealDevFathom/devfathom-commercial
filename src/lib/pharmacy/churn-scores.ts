import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Current churn scores for the given customers of one branch (segment evaluation). */
export async function readCustomerChurnScores(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  customerIds: string[]
): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db.pharmacyCustomerChurnScore.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: { in: customerIds },
    },
    select: { customerId: true, churnScore: true },
  });
  return new Map(rows.map((row) => [row.customerId, row.churnScore]));
}
