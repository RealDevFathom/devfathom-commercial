import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { evaluateOrderSettlement } from '@/lib/restaurant/bills';
import { sub, sum } from '@/lib/restaurant/money';
import { requireRestaurantBranchScope } from '@/server/restaurant-branch-scope';
import { router, capabilityProcedure } from '../trpc';

/**
 * M5-L2 — the back-office bill read surface (C12), consumed by the L7b money console
 * and the orders console. Every read is gated by `capabilityProcedure('money:read')`
 * — the single additive ABAC action L1 added (C11) — plus the licensed
 * `restaurant-pos` module and the audit middleware. Tenant scoping is the RLS-forced
 * `organizationId` default on every row (C1).
 *
 * This router is READ-ONLY: it never writes a bill (that is the `bills.ts` command
 * layer, driven from the terminal REST surface). Money crosses the tRPC boundary as
 * a STRING (C2): superjson does not carry a Prisma `Decimal`, and no monetary value
 * may round-trip through a float, so every amount in a response is serialised with
 * `Decimal.toString()`. Inputs are `.strict()` (house style — unknown fields
 * rejected, never stripped).
 *
 * **Read contract (C12, consumed by L7b + the orders console):** `listBills`
 * (branch/businessDate/orderId/status + pagination), `getBill` (lines, comps, tender
 * + refund summaries, receipt number) and `getOrderSettlement` (per-order bill /
 * settlement state). A console lane missing a read routes the defect back through the
 * Chief of Staff to this lane — it never adds its own server query.
 */

const ID = z.string().min(1);
const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.');
const BILL_STATUS = z.enum(['OPEN', 'SETTLED', 'VOID']);

/** Serialise a Decimal money value to its exact string (C2 — never a float). */
function money(value: Prisma.Decimal): string {
  return value.toString();
}

function serializeBillSummary(bill: {
  id: string;
  orderId: string;
  branchId: string;
  businessDate: Date;
  status: string;
  splitKind: string;
  fractionNumerator: number | null;
  fractionDenominator: number | null;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  serviceChargeTotal: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  roundingAdjustment: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  receiptNumber: number | null;
  settledAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: bill.id,
    orderId: bill.orderId,
    branchId: bill.branchId,
    businessDate: bill.businessDate.toISOString().slice(0, 10),
    status: bill.status,
    splitKind: bill.splitKind,
    fractionNumerator: bill.fractionNumerator,
    fractionDenominator: bill.fractionDenominator,
    subtotal: money(bill.subtotal),
    taxTotal: money(bill.taxTotal),
    serviceChargeTotal: money(bill.serviceChargeTotal),
    compTotal: money(bill.compTotal),
    roundingAdjustment: money(bill.roundingAdjustment),
    grandTotal: money(bill.grandTotal),
    receiptNumber: bill.receiptNumber,
    settledAt: bill.settledAt,
    createdAt: bill.createdAt,
  };
}

const BILL_SUMMARY_SELECT = {
  id: true,
  orderId: true,
  branchId: true,
  businessDate: true,
  status: true,
  splitKind: true,
  fractionNumerator: true,
  fractionDenominator: true,
  subtotal: true,
  taxTotal: true,
  serviceChargeTotal: true,
  compTotal: true,
  roundingAdjustment: true,
  grandTotal: true,
  receiptNumber: true,
  settledAt: true,
  createdAt: true,
} as const;

type ListBillsInput = {
  branchId: string;
  businessDate?: string;
  orderId?: string;
  status?: z.infer<typeof BILL_STATUS>;
  limit?: number;
  cursor?: string;
};

async function listBills(db: ScopedDb, input: ListBillsInput) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantBill.findMany({
    where: {
      branchId: input.branchId,
      businessDate: input.businessDate ? businessDateToUtcDate(input.businessDate) : undefined,
      orderId: input.orderId,
      status: input.status,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: BILL_SUMMARY_SELECT,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    bills: page.map(serializeBillSummary),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

async function getBill(db: ScopedDb, billId: string) {
  const bill = await db.restaurantBill.findUnique({
    where: { id: billId },
    select: {
      ...BILL_SUMMARY_SELECT,
      openerStaffProfileId: true,
      deviceId: true,
      voidReason: true,
      voidCoAuthorizationId: true,
      lines: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          orderItemId: true,
          name: true,
          quantity: true,
          unitPrice: true,
          lineSubtotal: true,
          taxAmount: true,
          serviceChargeAmount: true,
          compAmount: true,
          lineTotal: true,
          compReason: true,
          compCoAuthorizationId: true,
        },
      },
      tenders: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          amount: true,
          tipAmount: true,
          cashReceived: true,
          changeGiven: true,
          paymentId: true,
          createdAt: true,
        },
      },
      refunds: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          originalTenderId: true,
          amount: true,
          tipRefundAmount: true,
          serviceChargeRefundAmount: true,
          taxRefundAmount: true,
          cardMachineRefundReference: true,
          kind: true,
          reason: true,
          businessDate: true,
          createdAt: true,
        },
      },
    },
  });
  if (!bill) return null;

  const tenderTotal = sum(bill.tenders.map((t) => t.amount));
  const tipTotal = sum(bill.tenders.map((t) => t.tipAmount));
  const refundTotal = sum(bill.refunds.map((r) => r.amount));
  const refundTipTotal = sum(bill.refunds.map((r) => r.tipRefundAmount));
  const refundedServiceChargeTotal = sum(bill.refunds.map((r) => r.serviceChargeRefundAmount));
  const refundedTaxTotal = sum(bill.refunds.map((r) => r.taxRefundAmount));

  return {
    ...serializeBillSummary(bill),
    openerStaffProfileId: bill.openerStaffProfileId,
    deviceId: bill.deviceId,
    voidReason: bill.voidReason,
    voidCoAuthorizationId: bill.voidCoAuthorizationId,
    lines: bill.lines.map((line) => ({
      id: line.id,
      orderItemId: line.orderItemId,
      name: line.name,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      lineSubtotal: money(line.lineSubtotal),
      taxAmount: money(line.taxAmount),
      serviceChargeAmount: money(line.serviceChargeAmount),
      compAmount: money(line.compAmount),
      lineTotal: money(line.lineTotal),
      compReason: line.compReason,
      compCoAuthorizationId: line.compCoAuthorizationId,
    })),
    tenders: bill.tenders.map((t) => ({
      id: t.id,
      type: t.type,
      amount: money(t.amount),
      tipAmount: money(t.tipAmount),
      cashReceived: t.cashReceived === null ? null : money(t.cashReceived),
      changeGiven: t.changeGiven === null ? null : money(t.changeGiven),
      paymentId: t.paymentId,
      createdAt: t.createdAt,
    })),
    refunds: bill.refunds.map((r) => ({
      id: r.id,
      originalTenderId: r.originalTenderId,
      amount: money(r.amount),
      tipRefundAmount: money(r.tipRefundAmount),
      serviceChargeRefundAmount: money(r.serviceChargeRefundAmount),
      taxRefundAmount: money(r.taxRefundAmount),
      kind: r.kind,
      reason: r.reason,
      cardMachineRefundReference: r.cardMachineRefundReference,
      businessDate: r.businessDate.toISOString().slice(0, 10),
      createdAt: r.createdAt,
    })),
    tenderSummary: {
      count: bill.tenders.length,
      amount: money(tenderTotal),
      tipAmount: money(tipTotal),
    },
    refundSummary: {
      count: bill.refunds.length,
      amount: money(refundTotal),
      tipRefundAmount: money(refundTipTotal),
      serviceChargeRefundAmount: money(refundedServiceChargeTotal),
      taxRefundAmount: money(refundedTaxTotal),
      netServiceChargeAmount: money(bill.serviceChargeTotal.minus(refundedServiceChargeTotal)),
    },
    /** Net collected on this bill = tenders − refunds (excluding tips). */
    netCollected: money(sub(tenderTotal, refundTotal)),
  };
}

async function getOrderSettlement(db: ScopedDb, orderId: string) {
  const settlement = await evaluateOrderSettlement(db, orderId);
  return {
    orderId: settlement.orderId,
    settled: settlement.settled,
    blocker: settlement.blocker,
    derivedOrderTotal: money(settlement.derivedOrderTotal),
    accountedTotal: money(settlement.accountedTotal),
    unbilledItemIds: settlement.unbilledItemIds,
    bills: settlement.bills.map((b) => ({
      id: b.id,
      status: b.status,
      splitKind: b.splitKind,
      grandTotal: money(b.grandTotal),
      remainingDue: money(b.remainingDue),
      compTotal: money(b.compTotal),
      receiptNumber: b.receiptNumber,
    })),
  };
}

const readProcedure = capabilityProcedure('money:read');

export const restaurantBillsRouter = router({
  listBills: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: BUSINESS_DATE.optional(),
          orderId: ID.optional(),
          status: BILL_STATUS.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return listBills(ctx.db, input);
    }),

  getBill: readProcedure.input(z.object({ billId: ID }).strict()).query(async ({ ctx, input }) => {
    const scope = await ctx.db.restaurantBill.findUnique({
      where: { id: input.billId },
      select: { branchId: true },
    });
    if (scope) await requireRestaurantBranchScope(ctx, scope.branchId);
    return getBill(ctx.db, input.billId);
  }),

  getOrderSettlement: readProcedure
    .input(z.object({ orderId: ID }).strict())
    .query(async ({ ctx, input }) => {
      const order = await ctx.db.restaurantOrder.findUnique({
        where: { id: input.orderId },
        select: { branchId: true },
      });
      if (order) await requireRestaurantBranchScope(ctx, order.branchId);
      return getOrderSettlement(ctx.db, input.orderId);
    }),
});
