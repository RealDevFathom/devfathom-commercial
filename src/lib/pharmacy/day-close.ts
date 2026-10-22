import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import type { LedgerScope } from './stock-ledger';
import { readWalletLiability } from './wallet-reporting';
import {
  closePharmacyDrawer,
  computePharmacyClose,
  cutPharmacyDailyClose,
  foldExpectedCash,
  lockPharmacyDay,
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
  const [close, drawers, sales, refunds, organization, wallet] = await Promise.all([
    db.pharmacyDailyClose.findFirst({ where, orderBy: { sequence: 'desc' } }),
    db.pharmacyDrawerSession.findMany({
      where,
      include: { movements: true },
      orderBy: { id: 'asc' },
    }),
    db.pharmacySale.findMany({
      where: { ...where, status: 'COMPLETED' },
      include: { lines: true },
    }),
    db.pharmacyRefund.findMany({ where }),
    // The workspace's zone, which the close screen shows every time in: a
    // pharmacy branch has no zone of its own, and the viewer's browser zone is
    // not the pharmacy's. A stored value Intl refuses is handed over as UTC.
    db.organization.findUnique({
      where: { id: scope.organizationId },
      select: { timezone: true },
    }),
    readWalletLiability(db, scope.organizationId, scope.branchId, businessDate),
  ]);
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
    // Separate cash-in/liability disclosure. Neither value is fed to computePharmacyClose,
    // so top-ups cannot inflate sale, revenue, refund, or tax totals.
    wallet,
    close,
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
  if (preview.close) return preview.close;
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
