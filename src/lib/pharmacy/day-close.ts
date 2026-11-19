import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import { isPharmacyCurrentBusinessDate, pharmacyDayEndField } from './business-day';
import { readPharmacyDayClock } from './business-day-clock';
import type { LedgerScope } from './stock-ledger';
import { aggregateTenderTotals } from './manual-payments';
import {
  closePharmacyDrawer,
  computePharmacyClose,
  cutPharmacyDailyClose,
  drawerOperatingCashierId,
  foldExpectedCash,
  lockPharmacyDay,
  manualConfirmerNames,
  movementsByOtherThanOperator,
  PharmacySettlementError,
  saleTotalMinor,
  type DrawerMovement,
} from './settlement';

export async function readPharmacyClose(db: ScopedDb, scope: LedgerScope, businessDate: Date) {
  await lockPharmacyDay(db, scope, businessDate);
  const where = { organizationId: scope.organizationId, branchId: scope.branchId, businessDate };
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { name: true, businessDayEndsAtHistory: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pharmacy branch not found.' });
  const [close, drawers, sales, refunds, organization, tenders, unpaid] = await Promise.all([
    db.pharmacyDailyClose.findFirst({
      where,
      orderBy: { sequence: 'desc' },
      // DEV-631: an owner's reopen of the latest close opens the day for trading.
      include: { reopen: { select: { id: true, reason: true, actorId: true, createdAt: true } } },
    }),
    db.pharmacyDrawerSession.findMany({
      where,
      include: { movements: true, handovers: true },
      orderBy: { id: 'asc' },
    }),
    db.pharmacySale.findMany({
      where: { ...where, status: 'COMPLETED' },
      include: { lines: true },
    }),
    db.pharmacyRefund.findMany({ where, include: { originalTender: { select: { type: true } } } }),
    // The workspace's zone, which the close screen shows every time in: a
    // pharmacy branch has no zone of its own, and the viewer's browser zone is
    // not the pharmacy's. A stored value Intl refuses is handed over as UTC.
    db.organization.findUnique({
      where: { id: scope.organizationId },
      select: { timezone: true },
    }),
    db.pharmacyTender.findMany({
      where,
      select: { id: true, type: true, amountMinor: true, confirmedById: true },
    }),
    // DEV-623: unpaid bills hold their stock whatever their date, so the close
    // warns about every OPEN or HELD bill left in the branch.
    db.pharmacySale.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: { in: ['OPEN', 'HELD'] },
      },
      select: { status: true },
    }),
  ]);
  // DEV-821: cash moved into or out of a till by anyone but the cashier running it.
  const otherOperator = new Map(
    drawers.map((d) => [d.id, movementsByOtherThanOperator(d, d.movements, d.handovers ?? [])])
  );
  // DEV-631: a close that superseded a reopen-for-trading carries the variance note,
  // not a re-cut reason, so the screen can label it as such.
  const closeFollowsReopen = close?.supersedesCloseId
    ? Boolean(
        await db.pharmacyDayReopen.findFirst({
          where: { organizationId: scope.organizationId, closeId: close.supersedesCloseId },
          select: { id: true },
        })
      )
    : false;
  // Who opened each drawer, so the close screen can name the drawer by its
  // opener and time rather than by the counter's device identifier, plus the
  // cashiers and actors the operator check names.
  const openerIds = [
    ...new Set([
      ...drawers.map((d) => d.openedByActorId),
      ...drawers.map((d) => drawerOperatingCashierId(d)),
      ...[...otherOperator.values()].flat().map((m) => m.actorId),
    ]),
  ];
  const openers = openerIds.length
    ? await db.user.findMany({
        where: { organizationId: scope.organizationId, id: { in: openerIds } },
        select: { id: true, name: true },
      })
    : [];
  const openerNames = new Map(openers.map((user) => [user.id, user.name]));
  const rows = drawers.map((d) => ({
    id: d.id,
    deviceId: d.deviceId,
    status: d.status,
    openedAt: d.openedAt,
    openedBy: openerNames.get(d.openedByActorId) ?? null,
    operatingCashier: openerNames.get(drawerOperatingCashierId(d)) ?? null,
    otherOperatorMovements: (otherOperator.get(d.id) ?? []).map((m) => ({
      id: m.id,
      kind: m.kind,
      amountMinor: m.amountMinor,
      createdAt: m.createdAt,
      actor: openerNames.get(m.actorId) ?? null,
    })),
    expectedMinor: foldExpectedCash(
      d.movements.filter((m) => m.kind !== 'CLOSING_COUNT') as DrawerMovement[]
    ),
    countedMinor: d.countedCashMinor,
  }));
  const totals = computePharmacyClose({
    tenders,
    sales: sales.map((s) => ({ id: s.id, totalMinor: saleTotalMinor(s.lines) })),
    refunds: refunds.map((r) => ({ id: r.id, amountMinor: r.amountMinor })),
    drawers: rows.map((d) => ({
      id: d.id,
      expectedMinor: d.expectedMinor,
      countedMinor: d.countedMinor ?? 0,
    })),
  });
  // A retry of a pre-reopen close must not silently close a newly reopened day,
  // even when no money or drawers changed in between. Bind the preview to this reopen.
  if (close?.reopen) {
    totals.sourceHash = createHash('sha256')
      .update(`${totals.sourceHash}:${close.id}:${close.reopen.id}`)
      .digest('hex');
  }
  return {
    branchName: branch.name,
    businessDate,
    drawers: rows,
    totals,
    tenderTotals: aggregateTenderTotals(
      tenders,
      refunds,
      await manualConfirmerNames(db, scope.organizationId, tenders)
    ),
    close,
    closeFollowsReopen,
    timezone: workspaceTimezone(organization?.timezone),
    // DEV-958A: the hour this branch's business day ends at, so the screen knows "today".
    dayEnd: pharmacyDayEndField(branch.businessDayEndsAtHistory).dayEnd ?? [],
    openBills: {
      open: unpaid.filter((sale) => sale.status === 'OPEN').length,
      held: unpaid.filter((sale) => sale.status === 'HELD').length,
    },
  };
}

/** One transaction closes every counted drawer and persists the immutable Z report. */
export async function closePharmacyDay(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    businessDate: Date;
    sourceHash: string;
    counts: { drawerSessionId: string; countedCashMinor: number }[];
    varianceNote: string;
  }
) {
  const preview = await readPharmacyClose(db, scope, input.businessDate);
  // A transport retry returns the recorded close, never cuts a second report.
  // A close the owner reopened for trading is closed again with a new report.
  if (preview.close && !preview.close.reopen) {
    // The same recorded close the first call returned, without the preview's reopen read.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { reopen, ...recorded } = preview.close;
    return recorded;
  }
  const open = preview.drawers.filter((d) => d.status === 'OPEN');
  if (
    preview.totals.sourceHash !== input.sourceHash ||
    open.length !== input.counts.length ||
    new Set(input.counts.map((c) => c.drawerSessionId)).size !== open.length ||
    open.some((d) => !input.counts.some((c) => c.drawerSessionId === d.id))
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The day changed. Refresh the preview and recount before closing.',
    });
  }
  const hasVariance = preview.drawers.some(
    (d) =>
      (input.counts.find((c) => c.drawerSessionId === d.id)?.countedCashMinor ??
        d.countedMinor ??
        0) !== d.expectedMinor
  );
  if (hasVariance && !input.varianceNote.trim())
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Record a variance note before closing.' });
  for (const count of input.counts) await closePharmacyDrawer(db, scope, count);
  // Existing reason field preserves the operator explanation without a schema change. The close
  // is append-only (pharmacy_daily_closes_append_only), so the note goes in with the Z report.
  return cutPharmacyDailyClose(db, scope, {
    businessDate: input.businessDate,
    varianceNote: input.varianceNote,
  });
}

/**
 * DEV-631: the owner reopens today's closed business day for trading, with a reason.
 * The close stays as recorded (append-only); the reopen is its own append-only row,
 * and the next close of the day supersedes both. Only the workspace's current
 * business day can be reopened, so a past day's books are never reopened for sales.
 */
export async function reopenPharmacyDayForTrading(
  db: ScopedDb,
  scope: LedgerScope,
  input: { businessDate: Date; closeId: string; reason: string },
  now = new Date()
) {
  const reason = input.reason.trim();
  if (!reason) throw new PharmacySettlementError('REOPEN_REASON_REQUIRED');
  // DEV-958A: today on the branch's clock, whose day ends at its "day ends at" hour.
  if (
    !isPharmacyCurrentBusinessDate(input.businessDate, await readPharmacyDayClock(db, scope), now)
  )
    throw new PharmacySettlementError('REOPEN_NOT_TODAY');
  await lockPharmacyDay(db, scope, input.businessDate);
  const close = await db.pharmacyDailyClose.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
    },
    orderBy: { sequence: 'desc' },
    include: { reopen: true },
  });
  if (!close) throw new PharmacySettlementError('DAY_NOT_CLOSED');
  if (close.id !== input.closeId)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The day changed. Refresh before reopening.',
    });
  // A transport retry returns the recorded reopen, never writes a second one.
  if (close.reopen) return close.reopen;
  return db.pharmacyDayReopen.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      closeId: close.id,
      reason,
      actorId: scope.actorId,
    },
  });
}
