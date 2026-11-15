import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone, workspaceToday } from '@/lib/timezone';
import type { LedgerScope } from './stock-ledger';
import { aggregateTenderTotals } from './manual-payments';
import {
  closePharmacyDrawer,
  computePharmacyClose,
  cutPharmacyDailyClose,
  foldExpectedCash,
  lockPharmacyDay,
  manualConfirmerNames,
  PharmacySettlementError,
  saleTotalMinor,
  type DrawerMovement,
} from './settlement';

export async function readPharmacyClose(db: ScopedDb, scope: LedgerScope, businessDate: Date) {
  await lockPharmacyDay(db, scope, businessDate);
  const where = { organizationId: scope.organizationId, branchId: scope.branchId, businessDate };
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { name: true },
  });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Pharmacy branch not found.' });
  const [close, drawers, sales, refunds, organization, tenders] = await Promise.all([
    db.pharmacyDailyClose.findFirst({
      where,
      orderBy: { sequence: 'desc' },
      // DEV-631: an owner's reopen of the latest close opens the day for trading.
      include: { reopen: { select: { reason: true, actorId: true, createdAt: true } } },
    }),
    db.pharmacyDrawerSession.findMany({
      where,
      include: { movements: true },
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
  ]);
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
  // opener and time rather than by the counter's device identifier.
  const openerIds = [...new Set(drawers.map((d) => d.openedByActorId))];
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
  if (preview.close && !preview.close.reopen) return preview.close;
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
  input: { businessDate: Date; reason: string },
  now = new Date()
) {
  const reason = input.reason.trim();
  if (!reason) throw new PharmacySettlementError('REOPEN_REASON_REQUIRED');
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  if (input.businessDate.toISOString().slice(0, 10) !== workspaceToday(organization?.timezone, now))
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
