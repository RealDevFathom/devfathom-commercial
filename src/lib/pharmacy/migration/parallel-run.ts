import 'server-only';

/**
 * PH-MIG / MIG-04 — the parallel run: single entry into the incumbent, read-only
 * comparison here.
 *
 * During a parallel run the branch keeps entering every transaction into the
 * incumbent as well, and this system is the one being checked. So the legacy
 * side of every comparison is TYPED IN by the operator and carries its own actor
 * and time; nothing in this module derives, imports or infers it. The DevFathom
 * side is read from what this system already recorded.
 *
 * A comparison is stored rather than recomputed on read. That is deliberate: the
 * D05 threshold can be renegotiated, and a diff a pharmacist explained in week
 * one must stay the diff they explained, not silently become material again when
 * the contract changes.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { foldExpectedCash, saleTotalMinor } from '../settlement';
import type { DrawerMovement } from '../settlement';
import type { LedgerScope } from '../stock-ledger';

import { materialityThreshold } from './opening-stock';

export class PharmacyParallelRunError extends Error {
  constructor(
    readonly reason:
      | 'NOT_FOUND'
      | 'CROSS_BRANCH_REFERENCE'
      | 'INVALID_STATE'
      | 'INVALID_WINDOW'
      | 'DATE_OUTSIDE_WINDOW'
      | 'NOTE_REQUIRED'
      | 'LEGACY_TOTALS_MISSING'
  ) {
    super(reason);
    this.name = 'PharmacyParallelRunError';
  }
}

export type ParallelRunMetric = 'SALES' | 'CASH' | 'STOCK_VALUE';

/** Midnight-UTC date key, so a window test never depends on the server's zone. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function openParallelRunWindow(
  db: ScopedDb,
  scope: LedgerScope,
  input: { startDate: Date; endDate: Date }
) {
  if (dayKey(input.endDate) < dayKey(input.startDate)) {
    throw new PharmacyParallelRunError('INVALID_WINDOW');
  }
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId },
  });
  if (!branch) throw new PharmacyParallelRunError('CROSS_BRANCH_REFERENCE');

  return db.pharmacyParallelRunWindow.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      startDate: input.startDate,
      endDate: input.endDate,
      openedByActorId: scope.actorId,
    },
  });
}

export async function closeParallelRunWindow(db: ScopedDb, scope: LedgerScope, windowId: string) {
  const window = await requireWindow(db, scope, windowId, 'OPEN');
  return db.pharmacyParallelRunWindow.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: window.id } },
    data: { status: 'CLOSED', closedByActorId: scope.actorId, closedAt: new Date() },
  });
}

/**
 * The incumbent's totals for one business date, as the operator read them off
 * the legacy system. Re-entering a date corrects that day's figures; the
 * comparison for it is recomputed when `compareBusinessDate` next runs.
 */
export async function recordLegacyTotals(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    windowId: string;
    businessDate: Date;
    legacySalesMinor: bigint;
    legacyCashMinor: bigint;
    legacyStockValueMinor: bigint;
  }
) {
  const window = await requireWindow(db, scope, input.windowId, 'OPEN');
  assertWithinWindow(window, input.businessDate);

  return db.pharmacyParallelRunDailyEntry.upsert({
    where: {
      organizationId_windowId_businessDate: {
        organizationId: scope.organizationId,
        windowId: window.id,
        businessDate: input.businessDate,
      },
    },
    create: {
      organizationId: scope.organizationId,
      branchId: window.branchId,
      windowId: window.id,
      businessDate: input.businessDate,
      legacySalesMinor: input.legacySalesMinor,
      legacyCashMinor: input.legacyCashMinor,
      legacyStockValueMinor: input.legacyStockValueMinor,
      enteredByActorId: scope.actorId,
    },
    update: {
      legacySalesMinor: input.legacySalesMinor,
      legacyCashMinor: input.legacyCashMinor,
      legacyStockValueMinor: input.legacyStockValueMinor,
      enteredByActorId: scope.actorId,
      enteredAt: new Date(),
    },
  });
}

export type DevfathomDayTotals = {
  salesMinor: bigint;
  cashMinor: bigint;
  stockValueMinor: bigint;
};

/**
 * This system's own totals for one business date.
 *
 * Sales and cash come from the same folds POS-B's daily close uses, so the
 * comparison cannot disagree with the close it is checking. Stock value is the
 * on-hand projection valued at each lot's landed cost — a position, not a flow,
 * so it is taken as at "now" for the branch rather than for the date.
 */
export async function devfathomDayTotals(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  businessDate: Date
): Promise<DevfathomDayTotals> {
  const [sales, refunds, drawers, stockValue] = await Promise.all([
    db.pharmacySale.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate,
        status: 'COMPLETED',
      },
      include: { lines: true },
    }),
    db.pharmacyRefund.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate,
      },
    }),
    db.pharmacyDrawerSession.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate,
      },
      include: { movements: true },
    }),
    branchStockValueMinor(db, scope),
  ]);

  const grossSalesMinor = sales.reduce((sum, sale) => sum + saleTotalMinor(sale.lines), 0);
  const refundTotalMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  const cashMinor = drawers.reduce(
    (sum, drawer) =>
      sum +
      foldExpectedCash(
        drawer.movements.filter((row) => row.kind !== 'CLOSING_COUNT') as DrawerMovement[]
      ),
    0
  );

  return {
    salesMinor: BigInt(grossSalesMinor - refundTotalMinor),
    cashMinor: BigInt(cashMinor),
    stockValueMinor: stockValue,
  };
}

/** On-hand units valued at each lot's landed unit cost, for one branch. */
export async function branchStockValueMinor(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
): Promise<bigint> {
  const [row] = await db.$queryRaw<{ value: bigint }[]>(
    onHandValueQuery(scope.organizationId, [scope.branchId])
  );
  return row?.value ?? BigInt(0);
}

export function onHandValueQuery(organizationId: string, branchIds: string[]) {
  return Prisma.sql`SELECT COALESCE(SUM(b."onHandUnits"::bigint * lot."unitCostMinor"),0)::bigint AS value
    FROM pharmacy_stock_balances b JOIN pharmacy_inventory_lots lot ON lot."organizationId"=b."organizationId" AND lot.id=b."inventoryLotId"
    WHERE b."organizationId"=${organizationId} AND b."branchId" IN (${Prisma.join(branchIds)}) AND b.disposition='AVAILABLE'`;
}

export type ComparisonInput = {
  metric: ParallelRunMetric;
  devfathomMinor: bigint;
  legacyMinor: bigint;
  thresholdMinor: bigint;
};

export type ComputedComparison = ComparisonInput & { diffMinor: bigint; material: boolean };

/** Pure: the diff and whether it is material against the D05 threshold. */
export function computeComparison(input: ComparisonInput): ComputedComparison {
  const diffMinor = input.devfathomMinor - input.legacyMinor;
  const magnitude = diffMinor < BigInt(0) ? -diffMinor : diffMinor;
  return { ...input, diffMinor, material: magnitude > input.thresholdMinor };
}

/**
 * Compare all three metrics for one business date and store the result.
 *
 * Re-running for the same date restates the comparison — and deliberately clears
 * the explanation, because an explanation belongs to the numbers it explained.
 * A restated diff has not been explained yet.
 */
export async function compareBusinessDate(
  db: ScopedDb,
  scope: LedgerScope,
  input: { windowId: string; businessDate: Date }
) {
  const window = await requireWindow(db, scope, input.windowId, null);
  assertWithinWindow(window, input.businessDate);

  const legacy = await db.pharmacyParallelRunDailyEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      windowId: window.id,
      businessDate: input.businessDate,
    },
  });
  if (!legacy) throw new PharmacyParallelRunError('LEGACY_TOTALS_MISSING');

  const [devfathom, threshold] = await Promise.all([
    devfathomDayTotals(db, scope, input.businessDate),
    materialityThreshold(db, scope),
  ]);

  const pairs: ReadonlyArray<{ metric: ParallelRunMetric; ours: bigint; theirs: bigint }> = [
    { metric: 'SALES', ours: devfathom.salesMinor, theirs: legacy.legacySalesMinor },
    { metric: 'CASH', ours: devfathom.cashMinor, theirs: legacy.legacyCashMinor },
    {
      metric: 'STOCK_VALUE',
      ours: devfathom.stockValueMinor,
      theirs: legacy.legacyStockValueMinor,
    },
  ];

  const written = [];
  for (const pair of pairs) {
    const computed = computeComparison({
      metric: pair.metric,
      devfathomMinor: pair.ours,
      legacyMinor: pair.theirs,
      thresholdMinor: threshold.thresholdMinor,
    });
    written.push(
      await db.pharmacyParallelRunComparison.upsert({
        where: {
          organizationId_windowId_businessDate_metric: {
            organizationId: scope.organizationId,
            windowId: window.id,
            businessDate: input.businessDate,
            metric: pair.metric,
          },
        },
        create: {
          organizationId: scope.organizationId,
          branchId: window.branchId,
          windowId: window.id,
          businessDate: input.businessDate,
          metric: pair.metric,
          devfathomMinor: computed.devfathomMinor,
          legacyMinor: computed.legacyMinor,
          diffMinor: computed.diffMinor,
          thresholdMinor: computed.thresholdMinor,
          material: computed.material,
          actorId: scope.actorId,
        },
        update: {
          devfathomMinor: computed.devfathomMinor,
          legacyMinor: computed.legacyMinor,
          diffMinor: computed.diffMinor,
          thresholdMinor: computed.thresholdMinor,
          material: computed.material,
          explained: false,
          note: null,
          actorId: scope.actorId,
          comparedAt: new Date(),
        },
      })
    );
  }

  return written;
}

/**
 * Explain one comparison. The note is mandatory — the database refuses
 * `explained` without one, because "zero unexplained variance" is only a
 * meaningful gate if an explanation has to say something.
 */
export async function explainComparison(
  db: ScopedDb,
  scope: LedgerScope,
  input: { comparisonId: string; note: string }
) {
  if (!input.note.trim()) throw new PharmacyParallelRunError('NOTE_REQUIRED');
  const updated = await db.pharmacyParallelRunComparison.updateMany({
    where: {
      id: input.comparisonId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    data: { explained: true, note: input.note.trim(), actorId: scope.actorId },
  });
  if (updated.count === 0) throw new PharmacyParallelRunError('NOT_FOUND');
}

export type ParallelRunReconciliation = {
  comparedDates: string[];
  materialCount: number;
  unexplainedCount: number;
  /** True when nothing material is left unexplained across the whole window. */
  reconciled: boolean;
};

/** The window's reconciliation state — the input to the MIG-05 first-close rule. */
export async function parallelRunReconciliation(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  windowId: string,
  businessDate?: Date
): Promise<ParallelRunReconciliation> {
  const comparisons = await db.pharmacyParallelRunComparison.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      windowId,
      ...(businessDate ? { businessDate } : {}),
    },
    orderBy: [{ businessDate: 'asc' }, { metric: 'asc' }],
  });

  const material = comparisons.filter((row) => row.material);
  const unexplained = material.filter((row) => !row.explained);

  return {
    comparedDates: [...new Set(comparisons.map((row) => dayKey(row.businessDate)))],
    materialCount: material.length,
    unexplainedCount: unexplained.length,
    reconciled: comparisons.length > 0 && unexplained.length === 0,
  };
}

function assertWithinWindow(window: { startDate: Date; endDate: Date }, businessDate: Date): void {
  const day = dayKey(businessDate);
  if (day < dayKey(window.startDate) || day > dayKey(window.endDate)) {
    throw new PharmacyParallelRunError('DATE_OUTSIDE_WINDOW');
  }
}

async function requireWindow(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  windowId: string,
  requiredStatus: 'OPEN' | 'CLOSED' | null
) {
  const window = await db.pharmacyParallelRunWindow.findFirst({
    where: { id: windowId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!window) throw new PharmacyParallelRunError('CROSS_BRANCH_REFERENCE');
  if (requiredStatus !== null && window.status !== requiredStatus) {
    throw new PharmacyParallelRunError('INVALID_STATE');
  }
  return window;
}
