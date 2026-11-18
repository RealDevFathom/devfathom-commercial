/**
 * DEV-103: native non-stock AP invoice, settlement and aging procedures.
 *
 * Every procedure authorizes (owner role, Pharmacy Finance licence, canonical
 * `finance:read` ABAC, active branch) before it reads or writes AP data, and
 * every write runs in one business transaction together with its EXECUTE
 * audit row, so the ledger change and its audit evidence commit or roll back
 * together.
 */
import { TRPCError } from '@trpc/server';
import { apAgingWindow, readApAging } from '@/lib/pharmacy/accounts/ap-aging';
import {
  buildPaymentDraft,
  buildSetOffDraft,
  SUPPLIER_CREDIT_CURRENCY,
  SUPPLIER_CREDIT_MAX_ROWS,
  computeDueBillReminders,
} from '@/lib/pharmacy/accounts/ap-payables-drafts';
import { z } from 'zod';
import {
  listApInvoices,
  payApInvoice,
  PharmacyApInvoiceError,
  recordApInvoice,
  reverseApInvoice,
  reverseApSettlement,
} from '@/lib/pharmacy/accounts/ap-invoices';
import {
  apAgingSchema,
  listApInvoicesSchema,
  payApInvoiceSchema,
  recordApInvoiceSchema,
  reverseApInvoiceSchema,
  reverseApSettlementSchema,
} from '@/lib/pharmacy/accounts/ap-invoices-schema';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { recordAudit } from '../audit';
import {
  authorizeGeneralJournal,
  GENERAL_JOURNAL_AUDIT_CATEGORY,
  type GeneralJournalScope,
} from '../pharmacy-general-journal-security';
import { adminProcedure, router, type TRPCContext } from '../trpc';

const CONFLICT_REASONS = new Set([
  'ALREADY_REVERSED',
  'ACTIVE_SETTLEMENTS',
  'OVERPAYMENT',
  'DUPLICATE_REFERENCE',
  'DUPLICATE_INVOICE',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE',
]);

function fail(error: unknown): never {
  if (error instanceof PharmacyApInvoiceError) {
    throw new TRPCError({
      code:
        error.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : CONFLICT_REASONS.has(error.reason)
            ? 'CONFLICT'
            : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  throw error;
}

function txDb(tx: unknown) {
  return tx as ScopedDb;
}

type AuditCtx = Pick<TRPCContext, 'requestMeta'> & {
  session: NonNullable<TRPCContext['session']>;
};

type ApAuditAction =
  | 'pharmacyApInvoices.record'
  | 'pharmacyApInvoices.pay'
  | 'pharmacyApInvoices.reverseSettlement'
  | 'pharmacyApInvoices.reverseInvoice';

async function recordApAudit(
  tx: ScopedDb,
  ctx: AuditCtx,
  scope: GeneralJournalScope,
  audit: {
    action: ApAuditAction;
    description: string;
    targetType: 'PharmacyApInvoice' | 'PharmacyApInvoiceSettlement';
    targetId: string;
    targetLabel: string;
    commandKey: string;
    replayed: boolean;
    result: Record<string, string | number | null>;
  }
) {
  const user = ctx.session.user;
  await recordAudit(
    {
      organizationId: scope.organizationId,
      actorType: 'USER',
      actorId: scope.actorId,
      actorName: user.name ?? null,
      actorEmail: user.email ?? null,
      actorRole: user.role ?? null,
      source: 'TRPC',
      category: GENERAL_JOURNAL_AUDIT_CATEGORY,
      operation: 'EXECUTE',
      action: audit.action,
      description: audit.description,
      targetType: audit.targetType,
      targetId: audit.targetId,
      targetLabel: audit.targetLabel,
      result: { ...audit.result, replayed: audit.replayed },
      metadata: { branchId: scope.branchId, commandKey: audit.commandKey },
      ip: ctx.requestMeta?.ip ?? null,
      userAgent: ctx.requestMeta?.userAgent ?? null,
      path: audit.action,
      outcome: 'SUCCESS',
    },
    tx
  );
}

export const pharmacyApInvoicesRouter = router({
  list: adminProcedure.input(listApInvoicesSchema).query(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    return {
      scope: { organizationId: scope.organizationId, branchId: scope.branchId },
      invoices: await listApInvoices(ctx.db, scope, input),
      retrievedAt: new Date(),
    };
  }),

  aging: adminProcedure.input(apAgingSchema).query(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    try {
      return {
        scope: { organizationId: scope.organizationId, branchId: scope.branchId },
        view: await readApAging(ctx.db, scope, input.asOf, new Date(), ctx.organization?.timezone),
        retrievedAt: new Date(),
      };
    } catch (error) {
      fail(error);
    }
  }),

  /** DEV-694: read-only reminders plus payment and credit set-off DRAFTS. */
  payablesDrafts: adminProcedure
    .input(
      apAgingSchema
        .extend({
          payee: z
            .object({
              name: z.string().trim().min(1).max(200),
              currency: z.string().trim().min(3).max(3),
              budgetMinor: z.number().int().min(0).max(2_000_000_000),
            })
            .strict()
            .optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        const now = new Date();
        const timeZone = ctx.organization?.timezone;
        const view = await readApAging(ctx.db, scope, input.asOf, now, timeZone);
        const { cutoff } = apAgingWindow(input.asOf, now, timeZone);
        const credits = await ctx.db.pharmacySupplierCredit.findMany({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            receivedAt: { lt: cutoff },
          },
          select: {
            id: true,
            reference: true,
            amountMinor: true,
            receivedAt: true,
            supplier: { select: { name: true } },
            allocations: {
              where: { createdAt: { lt: cutoff } },
              select: { amountMinor: true },
            },
          },
          orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
          take: SUPPLIER_CREDIT_MAX_ROWS + 1,
        });
        const creditsComplete = credits.length <= SUPPLIER_CREDIT_MAX_ROWS;
        const currency = input.payee?.currency ?? view.totals[0]?.currency ?? 'PKR';
        return {
          scope: { organizationId: scope.organizationId, branchId: scope.branchId },
          draftOnly: true as const,
          reminders: computeDueBillReminders(view),
          paymentDraft: input.payee
            ? buildPaymentDraft(view, {
                payeeName: input.payee.name,
                currency,
                budgetMinor: input.payee.budgetMinor,
              })
            : null,
          setOffDraft: buildSetOffDraft(
            view,
            credits.slice(0, SUPPLIER_CREDIT_MAX_ROWS).map((c) => ({
              creditId: c.id,
              reference: c.reference,
              supplierName: c.supplier.name,
              receivedAt: c.receivedAt,
              amountMinor: c.amountMinor,
              allocatedMinor: c.allocations.reduce((s, a) => s + a.amountMinor, 0),
            })),
            SUPPLIER_CREDIT_CURRENCY
          ),
          viewComplete: view.complete && creditsComplete,
          creditsComplete,
          retrievedAt: new Date(),
        };
      } catch (error) {
        fail(error);
      }
    }),

  record: adminProcedure.input(recordApInvoiceSchema).mutation(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    try {
      return await ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        const result = await recordApInvoice(db, scope, input);
        await recordApAudit(db, ctx, scope, {
          action: 'pharmacyApInvoices.record',
          description: `Recorded supplier expense invoice ${result.invoice.reference}`,
          targetType: 'PharmacyApInvoice',
          targetId: result.invoice.id,
          targetLabel: result.invoice.reference,
          commandKey: input.createKey,
          replayed: result.replayed,
          result: {
            status: result.invoice.status,
            amountMinor: result.invoice.amountMinor,
            entryId: result.invoice.journalEntryId,
          },
        });
        return result.invoice;
      });
    } catch (error) {
      fail(error);
    }
  }),

  pay: adminProcedure.input(payApInvoiceSchema).mutation(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    try {
      return await ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        const result = await payApInvoice(db, scope, input);
        await recordApAudit(db, ctx, scope, {
          action: 'pharmacyApInvoices.pay',
          description: `Paid supplier expense invoice ${result.settlement.invoiceId}`,
          targetType: 'PharmacyApInvoiceSettlement',
          targetId: result.settlement.id,
          targetLabel: input.reference,
          commandKey: input.commandKey,
          replayed: result.replayed,
          result: {
            status: result.settlement.status,
            invoiceId: result.settlement.invoiceId,
            transactionId: result.settlement.transactionId,
            amountMinor: result.settlement.amountMinor,
          },
        });
        return result.settlement;
      });
    } catch (error) {
      fail(error);
    }
  }),

  reverseSettlement: adminProcedure
    .input(reverseApSettlementSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await reverseApSettlement(db, scope, input);
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.reverseSettlement',
            description: `Reversed supplier expense invoice payment ${result.settlement.id}`,
            targetType: 'PharmacyApInvoiceSettlement',
            targetId: result.settlement.id,
            targetLabel: result.settlement.id,
            commandKey: input.commandKey,
            replayed: result.replayed,
            result: {
              status: result.settlement.status,
              invoiceId: result.settlement.invoiceId,
              transactionId: result.settlement.transactionId,
            },
          });
          return result.settlement;
        });
      } catch (error) {
        fail(error);
      }
    }),

  reverseInvoice: adminProcedure.input(reverseApInvoiceSchema).mutation(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    try {
      return await ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        const result = await reverseApInvoice(db, scope, input);
        await recordApAudit(db, ctx, scope, {
          action: 'pharmacyApInvoices.reverseInvoice',
          description: `Reversed supplier expense invoice ${result.invoice.reference}`,
          targetType: 'PharmacyApInvoice',
          targetId: result.invoice.id,
          targetLabel: result.invoice.reference,
          commandKey: input.commandKey,
          replayed: result.replayed,
          result: {
            status: result.invoice.status,
            reversalEntryId: result.invoice.reversalEntryId,
          },
        });
        return result.invoice;
      });
    } catch (error) {
      fail(error);
    }
  }),
});
