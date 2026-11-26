import 'server-only';

import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCashCloseCheck } from './cash-close-check-operations';
import { buildShiftHandover, type ShiftHandoverFacts } from './shift-handover';

/** A drawer-specific snapshot, independent of the irreversible day-close lock. */
export async function readPharmacyShiftHandover(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  drawerSessionId: string
) {
  // The router's scope also carries `actorId`, which is not a drawer column; only
  // tenant and branch may reach the Prisma filter.
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: drawerSessionId,
      status: 'CLOSED',
    },
    select: { businessDate: true },
  });
  if (!drawer) throw new TRPCError({ code: 'NOT_FOUND', message: 'Closed drawer not found.' });

  // pharmacy_restock_interests is FORCE RLS keyed on the transaction-local branch
  // setting; the explicit predicates below do not satisfy the policy on their own.
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );

  // Counts, signed movement totals and subtraction stay in SQL. No names, drugs,
  // contact details or free-text customer fields are read into the note.
  const [row] = await db.$queryRaw<
    Array<Record<keyof ShiftHandoverFacts, bigint | number>>
  >(Prisma.sql`
    WITH cash AS (
      SELECT d."countedCashMinor" AS counted,
        COALESCE(SUM(CASE
          WHEN m.kind IN ('CASH_REFUND', 'PAID_OUT') THEN -m."amountMinor"::bigint
          WHEN m.kind IN ('OPENING_FLOAT', 'CASH_SALE', 'PAID_IN', 'REJECTED_OFFLINE_CASH') THEN m."amountMinor"::bigint
          ELSE 0 END), 0) AS expected
      FROM pharmacy_drawer_sessions d
      LEFT JOIN pharmacy_drawer_movements m
        ON m."organizationId" = d."organizationId" AND m."drawerSessionId" = d.id
      WHERE d."organizationId" = ${scope.organizationId} AND d."branchId" = ${scope.branchId}
        AND d.id = ${drawerSessionId} AND d.status = 'CLOSED'
      GROUP BY d.id, d."countedCashMinor"
    )
    SELECT counted AS "countedMinor", expected AS "expectedMinor",
      counted - expected AS "varianceMinor",
      (SELECT COUNT(*) FROM pharmacy_emergency_rx_follow_ups
        WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
          AND status = 'OPEN') AS "pendingRx",
      (SELECT COUNT(*) FROM pharmacy_customer_orders
        WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
          AND status IN ('PROPOSED', 'ACCEPTED', 'PACKING', 'READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY')) AS "openOrders",
      (SELECT COUNT(*) FROM pharmacy_restock_interests
        WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
          AND status = 'OPEN' AND "orderLineId" IS NULL) AS "restockPromises"
    FROM cash
  `);
  if (!row || row.countedMinor === null)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Closed drawer not found.' });
  const facts = Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number))
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Handover figures unavailable.',
        });
      return [key, number];
    })
  ) as ShiftHandoverFacts;
  // Reuse DEV-84 unchanged: no second detector, threshold or write. Staff aliases
  // also keep personally identifying names out of the copyable draft.
  const check = await readPharmacyCashCloseCheck(db, scope, drawer.businessDate, {
    anonymizeStaff: true,
  });
  return {
    draft: true as const,
    readOnly: true as const,
    preparedAt: new Date(),
    businessDate: check.businessDate,
    currency: check.currency,
    facts,
    findings: check.findings,
    policyVersion: check.policyVersion,
    note: buildShiftHandover(facts, check.businessDate, check.currency, check.findings),
  };
}
