import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, capabilityProcedure } from '../trpc';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { foldExpectedCash, type FoldableMovement } from '@/lib/restaurant/drawer-sessions';
import { resolveChainTip } from '@/lib/restaurant/daily-close';
import { manualCardSummarySchema } from '@/lib/restaurant/manual-card-summary';
import { formatMoney } from '@/lib/restaurant/money';
import { requireRestaurantBranchScope } from '@/server/restaurant-branch-scope';

/**
 * M5-L3 — the back-office cash read surface: drawer sessions + their movement
 * ledgers, and daily closes + their correction chains (C12 read contract,
 * consumed by the L7b money console). Every read is gated by
 * `capabilityProcedure('money:read')` — org-role-driven through the ABAC engine
 * (no static policy, see `abac/policies.ts`), the licensed `restaurant-pos` module
 * (`module-catalog.ts`) and the audit middleware. Tenant scoping is the RLS-forced
 * `organizationId` default on every row (C1).
 *
 * This router is READ-ONLY: drawer/close MUTATIONS live in the command layer
 * (`drawer-sessions.ts`, `daily-close.ts`) invoked from the L5 terminal REST edge,
 * which gates on the terminal `cash:*` capabilities (C11). Money crosses the tRPC
 * boundary as a STRING (C4/C2): superjson does not carry a Prisma `Decimal` and no
 * monetary value may round-trip through a float, so every amount is serialised with
 * `Decimal.toString()`. `expectedCash` on a drawer is DERIVED — recomputed here by
 * folding the movement ledger — never trusted from a stored scalar for an open
 * session. Inputs are `.strict()` (house style — unknown fields rejected).
 */

const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.');
const ID = z.string().min(1);
const DRAWER_STATUS = z.enum(['OPEN', 'CLOSED']);

const money = (value: Prisma.Decimal): string => formatMoney(value);
const moneyOrNull = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : formatMoney(value);
const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

const readProcedure = capabilityProcedure('money:read');

export const restaurantCashRouter = router({
  // ── Drawer sessions ───────────────────────────────────────────────────────────
  listDrawerSessions: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: BUSINESS_DATE.optional(),
          status: DRAWER_STATUS.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return listDrawerSessions(ctx.db, input);
    }),

  getDrawerSession: readProcedure
    .input(z.object({ drawerSessionId: ID }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await ctx.db.restaurantDrawerSession.findUnique({
        where: { id: input.drawerSessionId },
        select: { branchId: true },
      });
      if (scope) await requireRestaurantBranchScope(ctx, scope.branchId);
      return getDrawerSession(ctx.db, input.drawerSessionId);
    }),

  // ── Daily closes ──────────────────────────────────────────────────────────────
  listDailyCloses: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          from: BUSINESS_DATE.optional(),
          to: BUSINESS_DATE.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return listDailyCloses(ctx.db, input);
    }),

  getDailyClose: readProcedure
    .input(z.object({ dailyCloseId: ID }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await ctx.db.restaurantDailyClose.findUnique({
        where: { id: input.dailyCloseId },
        select: { branchId: true },
      });
      if (scope) await requireRestaurantBranchScope(ctx, scope.branchId);
      return getDailyClose(ctx.db, input.dailyCloseId);
    }),
});

// ── Read-model implementations ────────────────────────────────────────────────

type ListDrawerSessionsInput = {
  branchId: string;
  businessDate?: string;
  status?: z.infer<typeof DRAWER_STATUS>;
  limit?: number;
  cursor?: string;
};

async function listDrawerSessions(db: ScopedDb, input: ListDrawerSessionsInput) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantDrawerSession.findMany({
    where: {
      branchId: input.branchId,
      businessDate: input.businessDate ? businessDateToUtcDate(input.businessDate) : undefined,
      status: input.status,
    },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      branchId: true,
      deviceId: true,
      staffProfileId: true,
      businessDate: true,
      status: true,
      openedAt: true,
      closedAt: true,
      openingFloat: true,
      expectedCash: true,
      countedCash: true,
      variance: true,
      _count: { select: { movements: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    sessions: page.map((session) => ({
      id: session.id,
      branchId: session.branchId,
      deviceId: session.deviceId,
      staffProfileId: session.staffProfileId,
      businessDate: dateOnly(session.businessDate),
      status: session.status,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      openingFloat: money(session.openingFloat),
      expectedCash: moneyOrNull(session.expectedCash),
      countedCash: moneyOrNull(session.countedCash),
      variance: moneyOrNull(session.variance),
      movementCount: session._count.movements,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

async function getDrawerSession(db: ScopedDb, drawerSessionId: string) {
  const session = await db.restaurantDrawerSession.findUnique({
    where: { id: drawerSessionId },
    select: {
      id: true,
      branchId: true,
      deviceId: true,
      staffProfileId: true,
      businessDate: true,
      status: true,
      openedAt: true,
      closedAt: true,
      openingFloat: true,
      countedCash: true,
      variance: true,
      movements: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          kind: true,
          amount: true,
          reason: true,
          tenderId: true,
          refundId: true,
          staffProfileId: true,
          deviceId: true,
          createdAt: true,
        },
      },
    },
  });
  if (!session) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'The drawer session does not exist.' });
  }

  // `expectedCash` is DERIVED from the ledger (C8) — recompute it so an open
  // session shows a live expectation and a closed one is independently verifiable.
  const expectedCash = foldExpectedCash(session.movements as FoldableMovement[]);
  const counted = session.countedCash;
  return {
    id: session.id,
    branchId: session.branchId,
    deviceId: session.deviceId,
    staffProfileId: session.staffProfileId,
    businessDate: dateOnly(session.businessDate),
    status: session.status,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
    openingFloat: money(session.openingFloat),
    expectedCash: money(expectedCash),
    countedCash: moneyOrNull(counted),
    variance: counted === null ? null : money(counted.minus(expectedCash)),
    movements: session.movements.map((m) => ({
      id: m.id,
      kind: m.kind,
      amount: money(m.amount),
      reason: m.reason,
      tenderId: m.tenderId,
      refundId: m.refundId,
      staffProfileId: m.staffProfileId,
      deviceId: m.deviceId,
      createdAt: m.createdAt,
    })),
  };
}

type ListDailyClosesInput = { branchId: string; from?: string; to?: string };

async function listDailyCloses(db: ScopedDb, input: ListDailyClosesInput) {
  const businessDateFilter =
    input.from || input.to
      ? {
          ...(input.from ? { gte: businessDateToUtcDate(input.from) } : {}),
          ...(input.to ? { lte: businessDateToUtcDate(input.to) } : {}),
        }
      : undefined;

  const rows = await db.restaurantDailyClose.findMany({
    where: { branchId: input.branchId, businessDate: businessDateFilter },
    orderBy: [{ businessDate: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      businessDate: true,
      supersedesCloseId: true,
      correctionReason: true,
      createdAt: true,
      grossSales: true,
      netSales: true,
      refundTotal: true,
      cashVariance: true,
    },
  });

  // Group into per-business-date correction chains; the tip is authoritative.
  const byDate = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = dateOnly(row.businessDate);
    const list = byDate.get(key);
    if (list) list.push(row);
    else byDate.set(key, [row]);
  }

  const chains = [...byDate.entries()].map(([businessDate, closes]) => {
    const ordered = [...closes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const tipId = resolveChainTip(ordered)?.id ?? null;
    return {
      businessDate,
      tipCloseId: tipId,
      closes: ordered.map((close) => ({
        id: close.id,
        supersedesCloseId: close.supersedesCloseId,
        isTip: close.id === tipId,
        correctionReason: close.correctionReason,
        createdAt: close.createdAt,
        grossSales: money(close.grossSales),
        netSales: money(close.netSales),
        refundTotal: money(close.refundTotal),
        cashVariance: money(close.cashVariance),
      })),
    };
  });

  return { chains };
}

async function getDailyClose(db: ScopedDb, dailyCloseId: string) {
  const close = await db.restaurantDailyClose.findUnique({
    where: { id: dailyCloseId },
    select: {
      id: true,
      branchId: true,
      businessDate: true,
      supersedesCloseId: true,
      correctionReason: true,
      coAuthorizationId: true,
      cutByStaffProfileId: true,
      deviceId: true,
      createdAt: true,
      grossSales: true,
      netSales: true,
      taxTotal: true,
      serviceChargeTotal: true,
      tipTotal: true,
      compTotal: true,
      discountTotal: true,
      refundTotal: true,
      voidTotal: true,
      cashExpected: true,
      cashCounted: true,
      cashVariance: true,
      manualCardSummary: true,
      tenderTotals: {
        orderBy: { tenderType: 'asc' },
        select: { tenderType: true, amount: true, tipAmount: true, count: true },
      },
    },
  });
  if (!close) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'The daily close does not exist.' });
  }

  // The full correction chain for this branch × date, tip flagged (C9).
  const chain = await db.restaurantDailyClose.findMany({
    where: { branchId: close.branchId, businessDate: close.businessDate },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      supersedesCloseId: true,
      correctionReason: true,
      cutByStaffProfileId: true,
      createdAt: true,
    },
  });
  const tipId = resolveChainTip(chain)?.id ?? null;

  // Per-drawer variances for the same branch × date (C9 — reconciled to the cash
  // totals on the close).
  const drawers = await db.restaurantDrawerSession.findMany({
    where: { branchId: close.branchId, businessDate: close.businessDate },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      deviceId: true,
      staffProfileId: true,
      status: true,
      openingFloat: true,
      expectedCash: true,
      countedCash: true,
      variance: true,
    },
  });

  return {
    close: {
      id: close.id,
      branchId: close.branchId,
      businessDate: dateOnly(close.businessDate),
      supersedesCloseId: close.supersedesCloseId,
      correctionReason: close.correctionReason,
      coAuthorizationId: close.coAuthorizationId,
      cutByStaffProfileId: close.cutByStaffProfileId,
      deviceId: close.deviceId,
      createdAt: close.createdAt,
      isTip: close.id === tipId,
      totals: {
        grossSales: money(close.grossSales),
        netSales: money(close.netSales),
        taxTotal: money(close.taxTotal),
        serviceChargeTotal: money(close.serviceChargeTotal),
        tipTotal: money(close.tipTotal),
        compTotal: money(close.compTotal),
        discountTotal: money(close.discountTotal),
        refundTotal: money(close.refundTotal),
        voidTotal: money(close.voidTotal),
        cashExpected: money(close.cashExpected),
        cashCounted: money(close.cashCounted),
        cashVariance: money(close.cashVariance),
      },
    },
    manualCardSummary:
      close.manualCardSummary == null
        ? null
        : manualCardSummarySchema.parse(close.manualCardSummary),
    tenderTotals: close.tenderTotals.map((total) => ({
      tenderType: total.tenderType,
      amount: money(total.amount),
      tipAmount: money(total.tipAmount),
      count: total.count,
    })),
    drawerVariances: drawers.map((drawer) => ({
      drawerSessionId: drawer.id,
      deviceId: drawer.deviceId,
      staffProfileId: drawer.staffProfileId,
      status: drawer.status,
      openingFloat: money(drawer.openingFloat),
      expectedCash: moneyOrNull(drawer.expectedCash),
      countedCash: moneyOrNull(drawer.countedCash),
      variance: moneyOrNull(drawer.variance),
    })),
    chain: chain.map((node) => ({
      id: node.id,
      supersedesCloseId: node.supersedesCloseId,
      correctionReason: node.correctionReason,
      cutByStaffProfileId: node.cutByStaffProfileId,
      createdAt: node.createdAt,
      isTip: node.id === tipId,
    })),
  };
}
