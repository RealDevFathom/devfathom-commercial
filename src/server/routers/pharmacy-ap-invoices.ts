import { pharmacyAccountMutation } from '@/server/pharmacy-finance-gate';
import { canManagePharmacyAccounts } from '@/lib/pharmacy/finance-access';
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
  SUPPLIER_CREDIT_PAGE_ROWS,
  computeDueBillReminders,
} from '@/lib/pharmacy/accounts/ap-payables-drafts';
import {
  AP_SET_OFF_SEGREGATED_POLICY,
  approveApCreditSetOff,
  isSoleSetOffApprover,
  listApCreditSetOffs,
  AP_SET_OFF_REVERSAL_POLICY,
  rejectApCreditSetOff,
  requestApCreditSetOff,
  reverseApCreditSetOff,
} from '@/lib/pharmacy/accounts/ap-credit-set-off';
import { actorMayRefund, authenticateRefundPin } from '@/lib/pharmacy/refund-authorization';
import { z } from 'zod';
import {
  AP_REVERSAL_SEGREGATED_POLICY,
  AP_REVERSAL_SOLE_APPROVER_POLICY,
  listApInvoices,
  payApInvoice,
  PharmacyApInvoiceError,
  recordApInvoice,
  reverseApInvoice,
  reverseApSettlement,
  searchApReversals,
} from '@/lib/pharmacy/accounts/ap-invoices';
import { otherApReversalApprovers } from '@/lib/pharmacy/accounts/ap-reversal-approvers';
import {
  apAgingSchema,
  approveApCreditSetOffSchema,
  listApCreditSetOffsSchema,
  rejectApCreditSetOffSchema,
  requestApCreditSetOffSchema,
  reverseApCreditSetOffSchema,
  listApInvoicesSchema,
  payApInvoiceSchema,
  recordApInvoiceSchema,
  reverseApInvoiceSchema,
  reverseApSettlementSchema,
  searchApReversalsSchema,
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
  'SET_OFF_EXCEEDS_CREDIT',
  'SET_OFF_EXCEEDS_BILL',
  'ALREADY_DECIDED',
]);

/** DEV-694: the manager's own fresh PIN approves a set-off; this names the policy. */
export const AP_SET_OFF_PIN_BLOCKED = 'Set-off not approved. Enter your manager or owner PIN.';
export const AP_SET_OFF_FORBIDDEN =
  'Only a manager or owner can approve, reject or reverse a set-off.';
export const AP_SET_OFF_REVERSAL_PIN_BLOCKED =
  'Set-off not reversed. Enter your manager or owner PIN.';
export const AP_SET_OFF_SELF_APPROVAL =
  'Another manager or owner must approve a set-off you requested.';

/** DEV-103: reversing a supplier expense invoice or payment (owner decision, 19 Nov 2026). */
export const AP_REVERSAL_FORBIDDEN =
  'Only a manager or owner can reverse a supplier expense invoice or payment.';
export const AP_REVERSAL_PIN_BLOCKED = 'Nothing was reversed. Enter your manager or owner PIN.';
export const AP_REVERSAL_OWN_ENTRY = 'Another manager or owner must reverse an entry you recorded.';

/** The own-entry refusal, naming someone who can approve the reversal at this branch. */
export function apReversalOwnEntryMessage(name: string | null) {
  return name
    ? `${AP_REVERSAL_OWN_ENTRY} Ask ${name} or another manager or owner to reverse it.`
    : `${AP_REVERSAL_OWN_ENTRY} Ask another manager or owner to reverse it.`;
}

type ReversalCtx = Pick<TRPCContext, 'db'> & {
  session: NonNullable<TRPCContext['session']>;
};

/**
 * DEV-103: the gate in front of an invoice or payment reversal. A manager or owner only
 * (`pharmacy:manage`, the refund rule). Someone reversing an entry they recorded is refused
 * before any PIN is asked while another manager or owner could approve it
 * (`otherApReversalApprovers`: exactly who these procedures would let approve); otherwise their
 * own fresh PIN is checked in its own transaction, so a refusal keeps its lockout strike and its
 * FAILURE audit.
 * The command re-checks the solo rule inside the write's transaction.
 */
async function authorizeReversal(
  ctx: ReversalCtx,
  scope: GeneralJournalScope,
  input: { pin: string; commandKey: string },
  target: { createdByUserId: string; reverseCommandKey: string | null } | null,
  action: 'pharmacyApInvoices.reverseSettlement' | 'pharmacyApInvoices.reverseInvoice'
) {
  if (!(await actorMayRefund(ctx.db, ctx.session.user)))
    throw new TRPCError({ code: 'FORBIDDEN', message: AP_REVERSAL_FORBIDDEN });
  const ownEntry =
    target !== null &&
    target.createdByUserId === scope.actorId &&
    target.reverseCommandKey !== input.commandKey;
  if (ownEntry) {
    const [other] = await otherApReversalApprovers(ctx.db, scope);
    if (other)
      throw new TRPCError({ code: 'FORBIDDEN', message: apReversalOwnEntryMessage(other.name) });
  }
  const pin = await authenticateRefundPin({
    organizationId: scope.organizationId,
    actorId: scope.actorId,
    pin: input.pin,
    action,
    policy: ownEntry ? AP_REVERSAL_SOLE_APPROVER_POLICY : AP_REVERSAL_SEGREGATED_POLICY,
    errorCode: 'AP_REVERSAL_PIN_REFUSED',
  });
  if ('blocked' in pin)
    throw new TRPCError({ code: 'FORBIDDEN', message: AP_REVERSAL_PIN_BLOCKED });
}

/** Someone else became able to approve after the first check: nothing was written. */
async function ownEntryRefusal(ctx: ReversalCtx, scope: GeneralJournalScope): Promise<never> {
  const [other] = await otherApReversalApprovers(ctx.db, scope);
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: apReversalOwnEntryMessage(other?.name ?? null),
  });
}

function isSelfApproval(error: unknown) {
  return error instanceof PharmacyApInvoiceError && error.reason === 'SELF_APPROVAL';
}

function fail(error: unknown): never {
  if (error instanceof PharmacyApInvoiceError) {
    if (error.reason === 'SELF_APPROVAL') {
      throw new TRPCError({ code: 'FORBIDDEN', message: AP_SET_OFF_SELF_APPROVAL });
    }
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

/**
 * DEV-694: a set-off holds credit at `cutoff` when it was requested before it
 * and had not been released before it, by a rejection or by a reversal.
 */
function setOffHeldAt(cutoff: Date) {
  return {
    requestedAt: { lt: cutoff },
    NOT: [
      { status: 'REJECTED' as const, decidedAt: { lt: cutoff } },
      { status: 'REVERSED' as const, reversedAt: { lt: cutoff } },
    ],
  };
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
  | 'pharmacyApInvoices.reverseInvoice'
  | 'pharmacyApInvoices.requestCreditSetOff'
  | 'pharmacyApInvoices.approveCreditSetOff'
  | 'pharmacyApInvoices.rejectCreditSetOff'
  | 'pharmacyApInvoices.reverseCreditSetOff';

async function recordApAudit(
  tx: ScopedDb,
  ctx: AuditCtx,
  scope: GeneralJournalScope,
  audit: {
    action: ApAuditAction;
    description: string;
    targetType: 'PharmacyApInvoice' | 'PharmacyApInvoiceSettlement' | 'PharmacyApCreditSetOff';
    targetId: string;
    targetLabel: string;
    commandKey: string;
    replayed: boolean;
    result: Record<string, string | number | null>;
    metadata?: Record<string, string | boolean | null>;
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
      metadata: { ...audit.metadata, branchId: scope.branchId, commandKey: audit.commandKey },
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
        mayManageAccounts: await canManagePharmacyAccounts(ctx),
        view: await readApAging(
          ctx.db,
          scope,
          input.asOf,
          new Date(),
          ctx.organization?.timezone,
          input.payeeFilter ? { payeeName: input.payeeFilter } : {}
        ),
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
        // Owner decision: every bill, 5,000 per page, before any total or draft.
        const view = await readApAging(
          ctx.db,
          scope,
          input.asOf,
          now,
          timeZone,
          input.payeeFilter ? { payeeName: input.payeeFilter } : {}
        );
        const { cutoff } = apAgingWindow(input.asOf, now, timeZone);
        // Owner decision: read supplier credits in pages of 5,000 and fetch every
        // page before any total or set-off draft is reported.
        const credits = [];
        for (let cursor: string | undefined; ;) {
          const page = await ctx.db.pharmacySupplierCredit.findMany({
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
              // DEV-694: credit set off, or reserved by a request, at the cutoff:
              // requested before it and not rejected before it.
              apSetOffs: {
                where: setOffHeldAt(cutoff),
                select: { amountMinor: true },
              },
            },
            orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            take: SUPPLIER_CREDIT_PAGE_ROWS,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          credits.push(...page);
          if (page.length < SUPPLIER_CREDIT_PAGE_ROWS) break;
          cursor = page[page.length - 1]!.id;
        }
        const openCredits = credits
          .map((c) => ({
            creditId: c.id,
            reference: c.reference,
            supplierName: c.supplier.name,
            receivedAt: c.receivedAt,
            amountMinor: c.amountMinor,
            allocatedMinor:
              (c.allocations ?? []).reduce((s, a) => s + a.amountMinor, 0) +
              (c.apSetOffs ?? []).reduce((s, a) => s + a.amountMinor, 0),
          }))
          .filter((c) => c.amountMinor > c.allocatedMinor);
        // Requests still awaiting a decision at the cutoff reserve part of their bill
        // without settling it, so the suggestion never offers that part again. The
        // aging itself is unchanged: only approved set-offs reduce the payable.
        const reserved = await ctx.db.pharmacyApCreditSetOff.groupBy({
          by: ['invoiceId'],
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            requestedAt: { lt: cutoff },
            OR: [{ status: 'PENDING' }, { decidedAt: { gte: cutoff } }],
          },
          _sum: { amountMinor: true },
        });
        const reservedByInvoice = new Map(
          reserved.map((r) => [r.invoiceId, r._sum.amountMinor ?? 0])
        );
        const draftView = {
          ...view,
          rows: view.rows
            .map((row) => ({
              ...row,
              outstandingMinor: row.outstandingMinor - (reservedByInvoice.get(row.invoiceId) ?? 0),
            }))
            .filter((row) => row.outstandingMinor > 0),
        };
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
          setOffDraft: buildSetOffDraft(draftView, openCredits, SUPPLIER_CREDIT_CURRENCY),
          openCredits: openCredits.map((c) => ({
            creditId: c.creditId,
            reference: c.reference,
            supplierName: c.supplierName,
            remainingMinor: c.amountMinor - c.allocatedMinor,
          })),
          viewComplete: view.complete,
          creditsComplete: true as const,
          retrievedAt: new Date(),
        };
      } catch (error) {
        fail(error);
      }
    }),

  /** DEV-694: set-off requests for one branch, oldest first. */
  creditSetOffs: adminProcedure.input(listApCreditSetOffsSchema).query(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    return {
      scope: { organizationId: scope.organizationId, branchId: scope.branchId },
      setOffs: await listApCreditSetOffs(ctx.db, scope, input),
      retrievedAt: new Date(),
    };
  }),

  /** DEV-694: staff choose the bill; this records a PENDING request and moves no money. */
  requestCreditSetOff: pharmacyAccountMutation
    .input(requestApCreditSetOffSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await requestApCreditSetOff(db, scope, input);
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.requestCreditSetOff',
            description: `Requested a supplier credit set-off against invoice ${result.setOff.invoiceId}`,
            targetType: 'PharmacyApCreditSetOff',
            targetId: result.setOff.id,
            targetLabel: result.setOff.id,
            commandKey: input.requestKey,
            replayed: result.replayed,
            result: {
              status: result.setOff.status,
              invoiceId: result.setOff.invoiceId,
              supplierCreditId: result.setOff.supplierCreditId,
              amountMinor: result.setOff.amountMinor,
            },
          });
          return result.setOff;
        });
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * DEV-694: the payable reduces only here. A manager or owner re-enters their
   * own PIN (checked in its own transaction so a refusal keeps its lockout
   * strike); a different person must have requested the set-off, unless the
   * approver is the organization's only owner-level user.
   */
  approveCreditSetOff: pharmacyAccountMutation
    .input(approveApCreditSetOffSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      if (!(await actorMayRefund(ctx.db, ctx.session.user)))
        throw new TRPCError({ code: 'FORBIDDEN', message: AP_SET_OFF_FORBIDDEN });
      const pin = await authenticateRefundPin({
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        pin: input.pin,
        action: 'pharmacyApInvoices.approveCreditSetOff',
        policy: AP_SET_OFF_SEGREGATED_POLICY,
        errorCode: 'AP_SET_OFF_PIN_REFUSED',
      });
      if ('blocked' in pin)
        throw new TRPCError({ code: 'FORBIDDEN', message: AP_SET_OFF_PIN_BLOCKED });
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await approveApCreditSetOff(db, scope, input, {
            soleApprover: () => isSoleSetOffApprover(db, scope.organizationId, scope.actorId),
          });
          const setOff = result.setOff;
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.approveCreditSetOff',
            description: `Approved a supplier credit set-off against invoice ${setOff.invoiceId}`,
            targetType: 'PharmacyApCreditSetOff',
            targetId: setOff.id,
            targetLabel: setOff.id,
            commandKey: input.decisionKey,
            replayed: result.replayed,
            result: {
              status: setOff.status,
              invoiceId: setOff.invoiceId,
              supplierCreditId: setOff.supplierCreditId,
              amountMinor: setOff.amountMinor,
              entryId: setOff.journalEntryId,
            },
            metadata: {
              policy: setOff.approvalPolicy,
              approverId: setOff.decidedByUserId,
              initiatedById: setOff.requestedByUserId,
              pinVerified: true,
              selfApproved: setOff.decidedByUserId === setOff.requestedByUserId,
              approvedAt: setOff.decidedAt?.toISOString() ?? null,
            },
          });
          return setOff;
        });
      } catch (error) {
        fail(error);
      }
    }),

  /** DEV-694: a manager or owner closes a request without touching money. */
  rejectCreditSetOff: pharmacyAccountMutation
    .input(rejectApCreditSetOffSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      if (!(await actorMayRefund(ctx.db, ctx.session.user)))
        throw new TRPCError({ code: 'FORBIDDEN', message: AP_SET_OFF_FORBIDDEN });
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await rejectApCreditSetOff(db, scope, input);
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.rejectCreditSetOff',
            description: `Rejected a supplier credit set-off against invoice ${result.setOff.invoiceId}`,
            targetType: 'PharmacyApCreditSetOff',
            targetId: result.setOff.id,
            targetLabel: result.setOff.id,
            commandKey: input.decisionKey,
            replayed: result.replayed,
            result: { status: result.setOff.status, invoiceId: result.setOff.invoiceId },
          });
          return result.setOff;
        });
      } catch (error) {
        fail(error);
      }
    }),

  /**
   * DEV-694: undo an approved set-off with the mirror entry. Same gate as
   * approval: a manager or owner, their own fresh PIN, and not the requester
   * unless they are the only owner-level user.
   */
  reverseCreditSetOff: pharmacyAccountMutation
    .input(reverseApCreditSetOffSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      if (!(await actorMayRefund(ctx.db, ctx.session.user)))
        throw new TRPCError({ code: 'FORBIDDEN', message: AP_SET_OFF_FORBIDDEN });
      const pin = await authenticateRefundPin({
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        pin: input.pin,
        action: 'pharmacyApInvoices.reverseCreditSetOff',
        policy: AP_SET_OFF_REVERSAL_POLICY,
        errorCode: 'AP_SET_OFF_REVERSAL_PIN_REFUSED',
      });
      if ('blocked' in pin)
        throw new TRPCError({ code: 'FORBIDDEN', message: AP_SET_OFF_REVERSAL_PIN_BLOCKED });
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await reverseApCreditSetOff(db, scope, input, {
            soleApprover: () => isSoleSetOffApprover(db, scope.organizationId, scope.actorId),
          });
          const setOff = result.setOff;
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.reverseCreditSetOff',
            description: `Reversed a supplier credit set-off against invoice ${setOff.invoiceId}`,
            targetType: 'PharmacyApCreditSetOff',
            targetId: setOff.id,
            targetLabel: setOff.id,
            commandKey: input.commandKey,
            replayed: result.replayed,
            result: {
              status: setOff.status,
              invoiceId: setOff.invoiceId,
              supplierCreditId: setOff.supplierCreditId,
              amountMinor: setOff.amountMinor,
              reversalEntryId: setOff.reversalEntryId,
            },
            metadata: {
              policy: setOff.reversalPolicy,
              reversedById: setOff.reversedByUserId,
              initiatedById: setOff.requestedByUserId,
              pinVerified: true,
              selfApproved: setOff.reversedByUserId === setOff.requestedByUserId,
              reversedAt: setOff.reversedAt?.toISOString() ?? null,
            },
          });
          return setOff;
        });
      } catch (error) {
        fail(error);
      }
    }),

  record: pharmacyAccountMutation.input(recordApInvoiceSchema).mutation(async ({ ctx, input }) => {
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

  pay: pharmacyAccountMutation.input(payApInvoiceSchema).mutation(async ({ ctx, input }) => {
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

  /**
   * DEV-103: reverse one payment against a supplier expense invoice. The mirror entry is posted
   * through the canonical bookkeeping reversal; the payment row stays, marked REVERSED, and the
   * invoice owes that amount again from the reversal instant.
   */
  reverseSettlement: pharmacyAccountMutation
    .input(reverseApSettlementSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      const target = await ctx.db.pharmacyApInvoiceSettlement.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          id: input.settlementId,
        },
        select: { createdByUserId: true, reverseCommandKey: true },
      });
      // The PIN is checked here and never reaches the command.
      const { pin, ...command } = input;
      await authorizeReversal(
        ctx,
        scope,
        { pin, commandKey: command.commandKey },
        target,
        'pharmacyApInvoices.reverseSettlement'
      );
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await reverseApSettlement(db, scope, command, {
            soleApprover: async () => (await otherApReversalApprovers(db, scope)).length === 0,
          });
          const settlement = result.settlement;
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.reverseSettlement',
            description: `Reversed supplier expense invoice payment ${settlement.id}`,
            targetType: 'PharmacyApInvoiceSettlement',
            targetId: settlement.id,
            targetLabel: settlement.id,
            commandKey: input.commandKey,
            replayed: result.replayed,
            result: {
              status: settlement.status,
              invoiceId: settlement.invoiceId,
              transactionId: settlement.transactionId,
              amountMinor: settlement.amountMinor,
            },
            metadata: {
              policy: result.replayed ? null : result.policy,
              approverId: settlement.reversedByUserId,
              recordedById: settlement.createdByUserId,
              pinVerified: true,
              selfApproved: settlement.reversedByUserId === settlement.createdByUserId,
              reason: settlement.reversalReason,
              reversedAt: settlement.reversedAt?.toISOString() ?? null,
            },
          });
          return settlement;
        });
      } catch (error) {
        if (isSelfApproval(error)) await ownEntryRefusal(ctx, scope);
        fail(error);
      }
    }),

  /**
   * DEV-103: reverse a supplier expense invoice with the mirror journal entry. The invoice row
   * stays, marked REVERSED. Every payment and approved credit set-off against it must be
   * reversed first, so the payable can never go negative.
   */
  reverseInvoice: pharmacyAccountMutation
    .input(reverseApInvoiceSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      const target = await ctx.db.pharmacyApInvoice.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          id: input.invoiceId,
        },
        select: { createdByUserId: true, reverseCommandKey: true },
      });
      // The PIN is checked here and never reaches the command.
      const { pin, ...command } = input;
      await authorizeReversal(
        ctx,
        scope,
        { pin, commandKey: command.commandKey },
        target,
        'pharmacyApInvoices.reverseInvoice'
      );
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await reverseApInvoice(db, scope, command, {
            soleApprover: async () => (await otherApReversalApprovers(db, scope)).length === 0,
          });
          const invoice = result.invoice;
          await recordApAudit(db, ctx, scope, {
            action: 'pharmacyApInvoices.reverseInvoice',
            description: `Reversed supplier expense invoice ${invoice.reference}`,
            targetType: 'PharmacyApInvoice',
            targetId: invoice.id,
            targetLabel: invoice.reference,
            commandKey: input.commandKey,
            replayed: result.replayed,
            result: {
              status: invoice.status,
              amountMinor: invoice.amountMinor,
              reversalEntryId: invoice.reversalEntryId,
            },
            metadata: {
              policy: result.replayed ? null : result.policy,
              approverId: invoice.reversedByUserId,
              recordedById: invoice.createdByUserId,
              pinVerified: true,
              selfApproved: invoice.reversedByUserId === invoice.createdByUserId,
              reason: invoice.reversalReason,
              reversedAt: invoice.reversedAt?.toISOString() ?? null,
            },
          });
          return invoice;
        });
      } catch (error) {
        if (isSelfApproval(error)) await ownEntryRefusal(ctx, scope);
        fail(error);
      }
    }),

  /**
   * DEV-103: find a posted invoice, or a payment in force against one, to reverse: search by
   * payee, reference, exact amount and a range of days on the shop's clock, one page at a time.
   * Authorized like every read here; scoped to the authenticated tenant and this branch.
   */
  reversalSearch: adminProcedure.input(searchApReversalsSchema).query(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    return {
      scope: { organizationId: scope.organizationId, branchId: scope.branchId },
      ...(await searchApReversals(
        ctx.db,
        { organizationId: scope.organizationId, branchId: scope.branchId },
        input,
        ctx.organization?.timezone
      )),
      retrievedAt: new Date(),
    };
  }),

  /**
   * DEV-103: whether the signed-in person may reverse here, for the screen to show the form or
   * a plain line. The reversal procedures check everything again.
   */
  reversalAccess: adminProcedure
    .input(listApInvoicesSchema.pick({ branchId: true }))
    .query(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      const mayReverse =
        (await canManagePharmacyAccounts(ctx)) && (await actorMayRefund(ctx.db, ctx.session.user));
      const others = mayReverse ? await otherApReversalApprovers(ctx.db, scope) : [];
      return {
        scope: { organizationId: scope.organizationId, branchId: scope.branchId },
        actorId: scope.actorId,
        mayReverse,
        /** Someone else who could approve, so an entry you recorded goes to them. */
        otherApprover: others[0] ? { name: others[0].name } : null,
      };
    }),
});
