import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone, workspaceToday } from '@/lib/timezone';
import { zonedWallTimeToUtc } from '@/lib/restaurant/sop-recurrence';
import { foldExpectedCash, saleTotalMinor, type DrawerMovement } from './settlement';
import { checkPharmacyCashClose, type CashCloseCheck } from './cash-close-check';

const DAY_MS = 86_400_000;
/** Page size for the void-event read; every page is read, so nothing is truncated. */
const VOID_PAGE = 1_000;

/**
 * #728 — reads one branch/business day's close evidence and runs the cash-close
 * anomaly rules. Strictly read-only: unlike the close preview it takes no
 * advisory day lock, and it writes no signal, posting, audit or notification.
 * Every query is pinned to the caller's organization and branch on top of RLS.
 */
export async function readPharmacyCashCloseCheck(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  businessDate: Date
): Promise<CashCloseCheck & { branchName: string; timezone: string }> {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { name: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pharmacy branch not found.' });
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const timezone = workspaceTimezone(organization?.timezone);
  const day = businessDate.toISOString().slice(0, 10);
  const nextDay = new Date(businessDate.getTime() + DAY_MS).toISOString().slice(0, 10);
  // A sale is voided while still OPEN, so it has no business date. Its VOIDED
  // event belongs to the day by the workspace zone the counter stamps in: read
  // exactly that local day's UTC interval, every page of it.
  const dayStart = zonedWallTimeToUtc(day, 0, timezone).instant;
  const dayEnd = zonedWallTimeToUtc(nextDay, 0, timezone).instant;

  const where = { organizationId: scope.organizationId, branchId: scope.branchId, businessDate };
  const [close, drawers, sales, refunds, voidEvents] = await Promise.all([
    db.pharmacyDailyClose.findFirst({ where, orderBy: { sequence: 'desc' } }),
    db.pharmacyDrawerSession.findMany({
      where,
      include: { movements: true },
      orderBy: { id: 'asc' },
    }),
    db.pharmacySale.findMany({
      where: { ...where, status: 'COMPLETED' },
      select: {
        id: true,
        lines: { select: { quantity: true, unitPriceMinor: true, discountMinor: true } },
      },
    }),
    db.pharmacyRefund.findMany({
      where,
      select: { id: true, saleId: true, actorId: true, amountMinor: true },
      orderBy: { createdAt: 'asc' },
    }),
    readAllVoidEvents(db, scope, dayStart, dayEnd),
  ]);
  // Belt and braces: the interval already is the local day.
  const voids = voidEvents.filter((event) => workspaceToday(timezone, event.occurredAt) === day);

  const refundedSaleIds = [...new Set(refunds.map((refund) => refund.saleId))];
  const returns = refundedSaleIds.length
    ? await db.pharmacySaleReturn.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          originalSaleId: { in: refundedSaleIds },
        },
        select: { originalSaleId: true },
      })
    : [];
  const returned = new Set(returns.map((row) => row.originalSaleId));

  const actorIds = [
    ...new Set([
      ...refunds.map((refund) => refund.actorId),
      ...voids.map((event) => event.actorId),
      ...drawers.map((drawer) => drawer.openedByActorId),
    ]),
  ];
  const users = actorIds.length
    ? await db.user.findMany({
        where: { organizationId: scope.organizationId, id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  const actorNames = Object.fromEntries(
    users.filter((user) => user.name).map((user) => [user.id, user.name as string])
  );

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const check = checkPharmacyCashClose({
    businessDate: day,
    close: close
      ? {
          id: close.id,
          sequence: close.sequence,
          cashExpectedMinor: close.cashExpectedMinor,
          cashCountedMinor: close.cashCountedMinor,
          cashVarianceMinor: close.cashVarianceMinor,
          varianceNote: close.reason,
        }
      : null,
    grossSalesMinor: sales.reduce((sum, sale) => sum + saleTotalMinor(sale.lines), 0),
    completedSales: sales.length,
    drawers: drawers.map((drawer) => ({
      id: drawer.id,
      label: `opened by ${actorNames[drawer.openedByActorId] ?? 'a team member'} at ${clock.format(drawer.openedAt)}`,
      expectedMinor: foldExpectedCash(
        drawer.movements.filter((m) => m.kind !== 'CLOSING_COUNT') as DrawerMovement[]
      ),
      countedMinor: drawer.countedCashMinor,
    })),
    refunds: refunds.map((refund) => ({
      id: refund.id,
      saleId: refund.saleId,
      actorId: refund.actorId,
      amountMinor: refund.amountMinor,
      matchedReturn: returned.has(refund.saleId),
    })),
    voids: voids.map((event) => ({
      saleId: event.saleId,
      actorId: event.actorId,
      valueMinor: saleTotalMinor(event.sale.lines),
    })),
    actorNames,
  });
  return { ...check, branchName: branch.name, timezone };
}

async function readAllVoidEvents(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  dayStart: Date,
  dayEnd: Date
) {
  const query = (cursor?: string) =>
    db.pharmacySaleEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        kind: 'VOIDED',
        occurredAt: { gte: dayStart, lt: dayEnd },
      },
      select: {
        id: true,
        saleId: true,
        actorId: true,
        occurredAt: true,
        sale: {
          select: {
            lines: { select: { quantity: true, unitPriceMinor: true, discountMinor: true } },
          },
        },
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: VOID_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  const events: Awaited<ReturnType<typeof query>> = [];
  for (let page = await query(); ; page = await query(page[page.length - 1].id)) {
    events.push(...page);
    if (page.length < VOID_PAGE) return events;
  }
}
