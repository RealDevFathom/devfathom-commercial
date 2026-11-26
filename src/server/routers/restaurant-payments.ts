import { rotateTerminalWebhookKey } from '@/lib/restaurant/terminal-webhook-keys';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, capabilityProcedure } from '../trpc';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { add, ZERO } from '@/lib/restaurant/money';
import { requireRestaurantBranchScope } from '@/server/restaurant-branch-scope';

/**
 * M5-L4 — the back-office payments read surface: tenders, refunds and the payment
 * event trail (C12 read contract, consumed by the L7b money console). Every read is
 * gated by `capabilityProcedure('money:read')` — org-role-driven through the ABAC
 * engine (no static policy, see `abac/policies.ts`), the licensed `restaurant-pos`
 * module (`module-catalog.ts`) and the audit middleware. Tenant scoping is the
 * RLS-forced `organizationId` default on every row (C1).
 *
 * This router is READ-ONLY: tender/refund MUTATIONS live in the command layer
 * (`tenders.ts`, `refunds.ts`) invoked from the L5 checkout REST edge, which gates on
 * the terminal `payments:*` capabilities (C11). Money crosses the tRPC boundary as a
 * STRING (C4/C2): superjson does not carry a Prisma `Decimal` and no monetary value
 * may round-trip through a float, so every amount is serialised with
 * `Decimal.toString()`. Per-type totals are folded with the exact Decimal path from
 * `money.ts` (never a float sum). Inputs are `.strict()` (house style — unknown
 * fields rejected).
 */

const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.');
const ID = z.string().min(1);
const TENDER_TYPE = z.enum(['CASH', 'CARD', 'OTHER']);

const money = (value: Prisma.Decimal): string => value.toString();
const moneyOrNull = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : value.toString();
const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

const readProcedure = capabilityProcedure('money:read');
const configureProcedure = capabilityProcedure('restaurant:configure');

export const restaurantPaymentsRouter = router({
  getTerminalConfig: configureProcedure
    .input(z.object({ branchId: ID }).strict())
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return ctx.db.restaurantTerminalProviderConfig.findMany({
        where: { branchId: input.branchId },
        orderBy: [{ source: 'asc' }, { externalTerminalId: 'asc' }],
        select: {
          id: true,
          branchId: true,
          source: true,
          externalTerminalId: true,
          deviceId: true,
          mode: true,
          updatedAt: true,
        },
      });
    }),

  saveTerminalConfig: configureProcedure
    .input(
      z
        .object({
          branchId: ID,
          source: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
          externalTerminalId: z.string().min(1).max(200),
          deviceId: ID,
          mode: z.enum(['DISABLED', 'SIMULATION', 'WEBHOOK']),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      const organizationId = ctx.organization?.id ?? ctx.session?.user.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'NOT_FOUND' });
      const [branch, device] = await Promise.all([
        ctx.db.restaurantBranch.findUnique({ where: { id: input.branchId }, select: { id: true } }),
        ctx.db.restaurantRegisteredDevice.findFirst({
          where: { id: input.deviceId, branchId: input.branchId, status: 'ACTIVE' },
          select: { id: true },
        }),
      ]);
      if (!branch || !device) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Branch and active terminal device must belong to this tenant and match.',
        });
      }
      return ctx.db.restaurantTerminalProviderConfig.upsert({
        where: {
          organizationId_source_externalTerminalId: {
            organizationId,
            source: input.source,
            externalTerminalId: input.externalTerminalId,
          },
        },
        create: input,
        update: { branchId: input.branchId, deviceId: input.deviceId, mode: input.mode },
        select: {
          id: true,
          branchId: true,
          source: true,
          externalTerminalId: true,
          deviceId: true,
          mode: true,
        },
      });
    }),

  rotateTerminalWebhookSecret: configureProcedure
    .input(z.object({ branchId: ID, configId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      const user = ctx.session!.user;
      if (
        user.role !== 'ADMIN' ||
        !user.organizationId ||
        user.organizationId !== ctx.organization?.id
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      await requireRestaurantBranchScope(ctx, input.branchId);
      const rotated = await rotateTerminalWebhookKey(
        ctx.db,
        user.organizationId,
        input.branchId,
        input.configId
      );
      if (!rotated) throw new TRPCError({ code: 'NOT_FOUND' });
      return rotated;
    }),

  listTerminalReconciliations: readProcedure
    .input(z.object({ branchId: ID, limit: z.number().int().min(1).max(100).optional() }).strict())
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      const rows = await ctx.db.restaurantTerminalReconciliation.findMany({
        where: { branchId: input.branchId },
        orderBy: [{ processedAt: 'desc' }, { id: 'desc' }],
        take: input.limit ?? 50,
      });
      return rows.map((row) => ({
        ...row,
        amount: money(row.amount),
        tipAmount: money(row.tipAmount),
      }));
    }),

  // ── Tenders ─────────────────────────────────────────────────────────────────
  listTenders: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: BUSINESS_DATE.optional(),
          billId: ID.optional(),
          type: TENDER_TYPE.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return listTenders(ctx.db, input);
    }),

  // ── Refunds ─────────────────────────────────────────────────────────────────
  listRefunds: readProcedure
    .input(
      z
        .object({
          branchId: ID,
          businessDate: BUSINESS_DATE.optional(),
          billId: ID.optional(),
          originalTenderId: ID.optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: ID.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return listRefunds(ctx.db, input);
    }),

  // ── A single payment + its full event trail ──────────────────────────────────
  getPayment: readProcedure
    .input(z.object({ paymentId: ID }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await ctx.db.restaurantPayment.findUnique({
        where: { id: input.paymentId },
        select: { bill: { select: { branchId: true } } },
      });
      if (scope) await requireRestaurantBranchScope(ctx, scope.bill.branchId);
      return getPayment(ctx.db, input.paymentId);
    }),

  // ── Per-date tender-type summary (console) ────────────────────────────────────
  getTenderTypeTotals: readProcedure
    .input(z.object({ branchId: ID, businessDate: BUSINESS_DATE }).strict())
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      return getTenderTypeTotals(ctx.db, input);
    }),
});

// ── Read-model implementations ────────────────────────────────────────────────

type ListTendersInput = {
  branchId: string;
  businessDate?: string;
  billId?: string;
  type?: z.infer<typeof TENDER_TYPE>;
  limit?: number;
  cursor?: string;
};

async function listTenders(db: ScopedDb, input: ListTendersInput) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantTender.findMany({
    where: {
      bill: { branchId: input.branchId },
      businessDate: input.businessDate ? businessDateToUtcDate(input.businessDate) : undefined,
      billId: input.billId,
      type: input.type,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      billId: true,
      type: true,
      amount: true,
      tipAmount: true,
      cashReceived: true,
      changeGiven: true,
      drawerSessionId: true,
      paymentId: true,
      businessDate: true,
      staffProfileId: true,
      deviceId: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    tenders: page.map((tender) => ({
      id: tender.id,
      billId: tender.billId,
      type: tender.type,
      amount: money(tender.amount),
      tipAmount: money(tender.tipAmount),
      cashReceived: moneyOrNull(tender.cashReceived),
      changeGiven: moneyOrNull(tender.changeGiven),
      drawerSessionId: tender.drawerSessionId,
      paymentId: tender.paymentId,
      businessDate: dateOnly(tender.businessDate),
      staffProfileId: tender.staffProfileId,
      deviceId: tender.deviceId,
      createdAt: tender.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

type ListRefundsInput = {
  branchId: string;
  businessDate?: string;
  billId?: string;
  originalTenderId?: string;
  limit?: number;
  cursor?: string;
};

async function listRefunds(db: ScopedDb, input: ListRefundsInput) {
  const limit = input.limit ?? 50;
  const rows = await db.restaurantRefund.findMany({
    where: {
      bill: { branchId: input.branchId },
      businessDate: input.businessDate ? businessDateToUtcDate(input.businessDate) : undefined,
      billId: input.billId,
      originalTenderId: input.originalTenderId,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      originalTenderId: true,
      billId: true,
      kind: true,
      amount: true,
      tipRefundAmount: true,
      serviceChargeRefundAmount: true,
      taxRefundAmount: true,
      cardMachineRefundReference: true,
      businessDate: true,
      reason: true,
      coAuthorizationId: true,
      drawerSessionId: true,
      paymentId: true,
      staffProfileId: true,
      deviceId: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    refunds: page.map((refund) => ({
      id: refund.id,
      originalTenderId: refund.originalTenderId,
      billId: refund.billId,
      kind: refund.kind,
      amount: money(refund.amount),
      tipRefundAmount: money(refund.tipRefundAmount),
      serviceChargeRefundAmount: money(refund.serviceChargeRefundAmount),
      taxRefundAmount: money(refund.taxRefundAmount),
      cardMachineRefundReference: refund.cardMachineRefundReference,
      businessDate: dateOnly(refund.businessDate),
      reason: refund.reason,
      coAuthorizationId: refund.coAuthorizationId,
      drawerSessionId: refund.drawerSessionId,
      paymentId: refund.paymentId,
      staffProfileId: refund.staffProfileId,
      deviceId: refund.deviceId,
      createdAt: refund.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

async function getPayment(db: ScopedDb, paymentId: string) {
  const payment = await db.restaurantPayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      billId: true,
      provider: true,
      capability: true,
      status: true,
      amount: true,
      tipAmount: true,
      providerRef: true,
      staffProfileId: true,
      deviceId: true,
      createdAt: true,
      events: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          capability: true,
          eventType: true,
          amount: true,
          providerRef: true,
          payload: true,
          createdAt: true,
        },
      },
      tenders: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          type: true,
          amount: true,
          tipAmount: true,
          businessDate: true,
          createdAt: true,
        },
      },
      refunds: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          kind: true,
          amount: true,
          tipRefundAmount: true,
          serviceChargeRefundAmount: true,
          taxRefundAmount: true,
          cardMachineRefundReference: true,
          businessDate: true,
          createdAt: true,
        },
      },
    },
  });
  if (!payment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'The payment does not exist.' });
  }

  return {
    id: payment.id,
    billId: payment.billId,
    provider: payment.provider,
    capability: payment.capability,
    status: payment.status,
    amount: money(payment.amount),
    tipAmount: money(payment.tipAmount),
    providerRef: payment.providerRef,
    staffProfileId: payment.staffProfileId,
    deviceId: payment.deviceId,
    createdAt: payment.createdAt,
    events: payment.events.map((event) => ({
      id: event.id,
      capability: event.capability,
      eventType: event.eventType,
      amount: moneyOrNull(event.amount),
      providerRef: event.providerRef,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
    tenders: payment.tenders.map((tender) => ({
      id: tender.id,
      type: tender.type,
      amount: money(tender.amount),
      tipAmount: money(tender.tipAmount),
      businessDate: dateOnly(tender.businessDate),
      createdAt: tender.createdAt,
    })),
    refunds: payment.refunds.map((refund) => ({
      id: refund.id,
      kind: refund.kind,
      amount: money(refund.amount),
      tipRefundAmount: money(refund.tipRefundAmount),
      serviceChargeRefundAmount: money(refund.serviceChargeRefundAmount),
      taxRefundAmount: money(refund.taxRefundAmount),
      cardMachineRefundReference: refund.cardMachineRefundReference,
      businessDate: dateOnly(refund.businessDate),
      createdAt: refund.createdAt,
    })),
  };
}

type TenderTypeName = z.infer<typeof TENDER_TYPE>;
/** Fixed order so the console summary is deterministic regardless of what tendered. */
const TENDER_TYPE_ORDER: readonly TenderTypeName[] = ['CASH', 'CARD', 'OTHER'];

async function getTenderTypeTotals(
  db: ScopedDb,
  input: { branchId: string; businessDate: string }
) {
  const rows = await db.restaurantTender.findMany({
    where: {
      bill: { branchId: input.branchId },
      businessDate: businessDateToUtcDate(input.businessDate),
    },
    select: { type: true, amount: true, tipAmount: true },
  });

  // Fold each type with the exact Decimal path (C2) — never a float sum.
  const byType = new Map<
    TenderTypeName,
    { amount: Prisma.Decimal; tipAmount: Prisma.Decimal; count: number }
  >();
  for (const type of TENDER_TYPE_ORDER)
    byType.set(type, { amount: ZERO, tipAmount: ZERO, count: 0 });
  let grandAmount = ZERO;
  let grandTip = ZERO;
  for (const row of rows) {
    const bucket = byType.get(row.type as TenderTypeName)!;
    bucket.amount = add(bucket.amount, row.amount);
    bucket.tipAmount = add(bucket.tipAmount, row.tipAmount);
    bucket.count += 1;
    grandAmount = add(grandAmount, row.amount);
    grandTip = add(grandTip, row.tipAmount);
  }

  return {
    branchId: input.branchId,
    businessDate: input.businessDate,
    tenderTypes: TENDER_TYPE_ORDER.map((type) => {
      const bucket = byType.get(type)!;
      return {
        tenderType: type,
        amount: money(bucket.amount),
        tipAmount: money(bucket.tipAmount),
        count: bucket.count,
      };
    }),
    totals: {
      amount: money(grandAmount),
      tipAmount: money(grandTip),
      count: rows.length,
    },
  };
}
