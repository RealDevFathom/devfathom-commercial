import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { pharmacyRefundPostingMutation } from '@/server/pharmacy-finance-gate';
import {
  requirePharmacyFinance,
  canManagePharmacyAccounts,
  canAccessPharmacyFinance,
} from '@/lib/pharmacy/finance-access';
import {
  providerRefundAccounts,
  changeProviderRefund,
  loadOriginalReview,
  maySignOwnRefundCorrection,
  refundCalendarDay,
} from '@/lib/pharmacy/card-terminal/provider-refunds';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  terminalAdmissionRefusal,
  PRODUCTION_TERMINAL_ADMISSION,
} from '@/lib/pharmacy/card-terminal/contract';
import {
  cardTerminalCounterView,
  type CardTerminalReviewAccess,
} from '@/lib/pharmacy/card-terminal/counter-view';
import {
  resolvePharmacyCardTerminal,
  type ResolvedCardTerminal,
} from '@/lib/pharmacy/card-terminal/registry';
import {
  chargeCardTerminal,
  recoverCardTerminalAttempt,
  resolveCardTerminalReview,
  type CardTerminalDeps,
} from '@/lib/pharmacy/card-terminal/service';
import {
  CardTerminalError,
  PHARMACY_TERMINAL_CURRENCY,
  prismaCardTerminalAttemptStore,
  type CardTerminalAttemptStore,
} from '@/lib/pharmacy/card-terminal/store';
import { CARD_TERMINAL_TIMEOUT_MS } from '@/lib/pharmacy/card-terminal/timing';
import {
  actorMayRefund,
  authenticateRefundPin,
  refundApprovalAudit,
} from '@/lib/pharmacy/refund-authorization';
import { otherCardTerminalReviewers } from '@/lib/pharmacy/card-terminal/review-approvers';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';

import { protectedProcedure, router, type TRPCContext } from '../trpc';
import { failPharmacySale, requireCounterReceiptAccess } from './pharmacy-sales';

/**
 * DEV-743: the counter's integrated card-terminal payments, on top of the one durable
 * payment-attempt record (`src/lib/pharmacy/card-terminal/`).
 *
 * - `availability` says whether this counter has an admitted terminal. No provider is bound, so
 *   it is false everywhere and the counter shows no terminal control.
 * - `charge` commits the attempt, then sends exactly one charge (dispatch). It answers with the
 *   attempt's counter state: paid, declined, or unknown with a status check to make.
 * - `checkStatus` asks the terminal about the same operation again. It never sends a new charge.
 * - `attempt` reads the sale's newest attempt, so a reloaded counter shows where it stands.
 * - `resolveReview` lets a manager or owner, with their own fresh PIN, resolve an attempt waiting
 *   for review from the terminal slip: nothing was charged (DECLINED), or the money was taken and
 *   is refunded through the provider (REVERSED). A cashier cannot. Nobody resolves a charge they
 *   took themselves while another manager or owner could; the sole manager or owner may, with that
 *   PIN, and the audit entry records the self-approval.
 *
 * The browser never names the provider, the terminal or the currency: the server resolves the
 * terminal paired with the counter and charges in PKR only. A charge needs the same counter
 * access as any other tender. Manual Card and Wallet tenders (DEV-713) do not pass through here.
 */

const branchId = z.string().trim().min(1).max(128);

/** DEV-743: the manager-PIN control for resolving a card-terminal review (the refund rule). */
export const CARD_TERMINAL_REVIEW_PIN_POLICY = 'PHARMACY_CARD_TERMINAL_REVIEW_MANAGER_PIN';
export const CARD_TERMINAL_REVIEW_FORBIDDEN =
  'Only a manager or owner can resolve a card terminal payment under review.';
export const CARD_TERMINAL_REVIEW_OWN_CHARGE =
  'Another manager or owner must resolve a payment you took.';

/** The own-charge refusal, naming someone who can resolve it at this branch. */
export function cardTerminalOwnChargeMessage(name: string | null) {
  return name
    ? `${CARD_TERMINAL_REVIEW_OWN_CHARGE} Ask ${name} or another manager at this branch to resolve it.`
    : `${CARD_TERMINAL_REVIEW_OWN_CHARGE} Ask another manager or owner at this branch to resolve it.`;
}

async function mayPostRefund(ctx: Parameters<typeof canManagePharmacyAccounts>[0]) {
  return (
    (await canAccessPharmacyFinance(ctx.session.user, { db: ctx.db, source: 'TRPC' })) &&
    (await canManagePharmacyAccounts(ctx)) &&
    (await can(subjectFromSession(ctx.session.user), 'admin:access', undefined, {
      db: ctx.db,
      source: 'TRPC',
    }))
  );
}

/**
 * Whether the signed-in person may resolve THIS attempt's review, for the counter to show the form
 * or a plain line. The server checks again on resolve, inside the write's transaction.
 */
async function reviewAccessFor(
  ctx: Parameters<typeof mayPostRefund>[0],
  scope: LedgerScope,
  attempt: { actorId: string }
): Promise<CardTerminalReviewAccess> {
  if (!(await actorMayRefund(ctx.db as ScopedDb, ctx.session!.user)))
    return { mayPostRefund: false, mayResolve: false, selfResolve: false, askName: null };
  const postingAllowed = await mayPostRefund(ctx);
  if (attempt.actorId !== scope.actorId)
    return { mayPostRefund: postingAllowed, mayResolve: true, selfResolve: false, askName: null };
  const [other] = await otherCardTerminalReviewers(ctx.db as ScopedDb, scope);
  return other
    ? { mayPostRefund: false, mayResolve: false, selfResolve: false, askName: other.name }
    : { mayPostRefund: postingAllowed, mayResolve: true, selfResolve: true, askName: null };
}
const attemptKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);

/**
 * How long the counter's request waits for the terminal before the outcome counts as UNKNOWN:
 * the one timeout the recovery sweep uses too (`card-terminal/timing.ts`).
 */
export const COUNTER_TERMINAL_TIMEOUT_MS = CARD_TERMINAL_TIMEOUT_MS;

/**
 * Each store call commits in its OWN tenant transaction, independent of the request's. The
 * request runs inside one `withTenantDb` transaction, and a nested `ctx.db.$transaction` reuses
 * it, so CREATED and SENT would not be committed while the terminal charges: a crash, a failed
 * batch sibling or the request timeout would roll them back after money moved. These commits
 * never wait on the request's transaction, which holds no attempt or sale lock.
 */
function storeFor(scope: LedgerScope): CardTerminalAttemptStore {
  return prismaCardTerminalAttemptStore((work) =>
    withTenantDb(scope.organizationId, work, { userId: scope.actorId })
  );
}

function admitted(terminal: ResolvedCardTerminal | null): terminal is ResolvedCardTerminal {
  return (
    terminal !== null &&
    terminalAdmissionRefusal(
      terminal.adapter,
      terminal.admission ?? PRODUCTION_TERMINAL_ADMISSION
    ) === null
  );
}

async function depsFor(
  scope: LedgerScope,
  deviceId: string
): Promise<{ deps: CardTerminalDeps; terminal: ResolvedCardTerminal }> {
  const terminal = await resolvePharmacyCardTerminal(scope, deviceId);
  if (!admitted(terminal))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'UNCERTIFIED_PROVIDER' });
  return {
    terminal,
    deps: {
      store: storeFor(scope),
      adapter: terminal.adapter,
      timeoutMs: COUNTER_TERMINAL_TIMEOUT_MS,
      ...(terminal.admission ? { admission: terminal.admission } : {}),
    },
  };
}

const CARD_TERMINAL_CODES: Record<CardTerminalError['reason'], TRPCError['code']> = {
  UNCERTIFIED_PROVIDER: 'PRECONDITION_FAILED',
  INVALID_INPUT: 'BAD_REQUEST',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
  ATTEMPT_IN_PROGRESS: 'CONFLICT',
  ATTEMPT_NOT_FOUND: 'NOT_FOUND',
  INVALID_STATE: 'CONFLICT',
  OWN_CHARGE_NEEDS_ANOTHER_APPROVER: 'FORBIDDEN',
  REVIEW_NOT_OPEN: 'CONFLICT',
  CHARGE_EVIDENCE_RECORDED: 'CONFLICT',
  SLIP_REFERENCE_MISMATCH: 'BAD_REQUEST',
  SLIP_REFERENCE_IN_USE: 'CONFLICT',
};

function fail(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof CardTerminalError)
    throw new TRPCError({ code: CARD_TERMINAL_CODES[error.reason], message: error.reason });
  // The begin step runs the real tender guards, so their refusals answer as a tender's do.
  return failPharmacySale(error);
}

async function requireReviewer(ctx: TRPCContext, branch: string) {
  const scope = await requireCounterReceiptAccess(ctx, branch, true);
  if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
    throw new TRPCError({ code: 'FORBIDDEN', message: CARD_TERMINAL_REVIEW_FORBIDDEN });
  return scope;
}

async function requireRefundAccountsAccess(ctx: TRPCContext, branch: string) {
  if (!hasModule(ctx.entitlements, 'pharmacy-finance'))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Pharmacy finance access is required to manage card provider refunds.',
    });
  return requireReviewer(ctx, branch);
}

export const pharmacyCardTerminalRouter = router({
  providerRefunds: protectedProcedure
    .input(z.object({ branchId }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireRefundAccountsAccess(ctx, input.branchId);
      await requirePharmacyFinance(ctx);
      const records = await providerRefundAccounts(ctx.db as ScopedDb, scope);
      const historical = await ctx.db.$queryRaw<
        {
          id: string;
          attemptId: string;
          attemptKey: string;
          status: string;
          createdAt: Date;
          originalActorId: string;
          reference: string | null;
          amountMinor: number | null;
        }[]
      >`
      SELECT 'review:'||a.id AS id,a.id AS "attemptId",a."attemptKey",a.status,a."resolvedAt" AS "createdAt",a."resolvedById" AS "originalActorId",a."resolutionRef" AS reference,COALESCE(a."approvedAmountMinor", CASE WHEN a."reviewReason" IS DISTINCT FROM 'Terminal approved a different amount' THEN a."amountMinor" END) AS "amountMinor"
      FROM pharmacy_card_terminal_attempts a WHERE a."organizationId"=${scope.organizationId} AND a."branchId"=${scope.branchId} AND a.status IN ('REVERSED','DECLINED') AND a."resolvedById" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pharmacy_terminal_refund_events e WHERE e."attemptId"=a.id)`;
      return {
        booked: records.filter((row) => row.remainingMinor > 0),
        records,
        historical,
        actorId: scope.actorId,
        peers: await otherCardTerminalReviewers(ctx.db as ScopedDb, scope),
        owner: await maySignOwnRefundCorrection(ctx.db as ScopedDb, scope),
        today: await refundCalendarDay(ctx.db as ScopedDb, scope.organizationId),
        canWrite: await mayPostRefund(ctx),
      };
    }),
  reviewHistory: protectedProcedure
    .input(z.object({ branchId, attemptKey }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireRefundAccountsAccess(ctx, input.branchId);
      await requirePharmacyFinance(ctx);
      const where = { organizationId: scope.organizationId, branchId: scope.branchId };
      const attempt = await ctx.db.pharmacyCardTerminalAttempt.findFirst({
        where: { ...where, attemptKey: input.attemptKey },
        select: {
          id: true,
          status: true,
          resolvedById: true,
          resolvedAt: true,
          resolutionReason: true,
        },
      });
      if (!attempt)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No terminal review was found at this branch.',
        });
      const events = await ctx.db.pharmacyTerminalRefundEvent.findMany({
        where: { ...where, attemptId: attempt.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          previousId: true,
          kind: true,
          amountMinor: true,
          createdAt: true,
          reason: true,
          actorId: true,
          secondApproverId: true,
          journalId: true,
          slipRef: true,
          settledOn: true,
          remainingMinor: true,
          selfApproved: true,
        },
      });
      const reviewerIds = new Set(
        events.flatMap((e) => (e.secondApproverId ? [e.actorId, e.secondApproverId] : [e.actorId]))
      );
      if (attempt.resolvedById) reviewerIds.add(attempt.resolvedById);
      const reviewers = await ctx.db.user.findMany({
        where: { organizationId: scope.organizationId, id: { in: [...reviewerIds] } },
        select: { id: true, name: true },
      });
      const names = new Map(reviewers.map((person) => [person.id, person.name]));
      const nameFor = (id: string) => names.get(id) || 'Former team member';
      return {
        attempt: {
          ...attempt,
          reviewerName: attempt.resolvedById ? nameFor(attempt.resolvedById) : null,
        },
        originalReviewId: attempt.resolvedById ? 'review:' + attempt.id : null,
        events: events.map((e) => ({
          ...e,
          actorName: nameFor(e.actorId),
          secondApproverName: e.secondApproverId ? nameFor(e.secondApproverId) : null,
        })),
      };
    }),
  recordRefundAction: pharmacyRefundPostingMutation
    .input(
      z
        .object({
          branchId,
          previousId: z.string().min(1).max(200),
          commandKey: attemptKey,
          kind: z.enum(['DECLINED', 'OWED', 'SETTLED', 'BOOK_HISTORICAL']),
          resolutionReason: z.string().trim().min(3).max(200),
          slipRef: z.string().trim().min(1).max(64),
          managerPin: z.string().regex(/^\d{4,8}$/),
          declareSelfApproval: z.literal(true).optional(),
          settlementAmountMinor: z.number().int().positive().max(2147483647).optional(),
          settledOn: z.string().date().optional(),
          secondApproval: z
            .object({
              userId: z.string().min(1).max(128),
              managerPin: z.string().regex(/^\d{4,8}$/),
            })
            .strict()
            .optional(),
          verifiedAmountMinor: z.number().int().positive().max(2147483647).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = await requireRefundAccountsAccess(ctx, input.branchId);
      const db = ctx.db as ScopedDb;
      const action = 'pharmacyCardTerminal.recordRefundAction';
      const pinArgs = {
        organizationId: scope.organizationId,
        action,
        policy: CARD_TERMINAL_REVIEW_PIN_POLICY,
      };
      const previous = await db.pharmacyTerminalRefundEvent.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          id: input.previousId,
        },
      });
      const attemptId =
        previous?.attemptId ??
        (input.previousId.startsWith('review:') ? input.previousId.slice(7) : '');
      const attempt = await db.pharmacyCardTerminalAttempt.findFirst({
        where: { organizationId: scope.organizationId, branchId: scope.branchId, id: attemptId },
      });
      if (!attempt) throw new TRPCError({ code: 'NOT_FOUND' });
      if (input.kind === 'SETTLED' && (!input.settlementAmountMinor || !input.settledOn))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Enter the settlement amount and date.',
        });
      const originalActorId = previous?.refundId
        ? (
            await db.pharmacyTerminalRefundEvent.findFirstOrThrow({
              where: {
                organizationId: scope.organizationId,
                branchId: scope.branchId,
                id: 'refund:' + previous.refundId,
              },
              select: { actorId: true },
            })
          ).actorId
        : attempt.resolvedById;
      const needsPeer =
        (input.kind === 'DECLINED' || input.kind === 'OWED') &&
        (previous?.actorId === scope.actorId || originalActorId === scope.actorId);
      if (attempt.actorId === scope.actorId || needsPeer || input.secondApproval) {
        const others = await otherCardTerminalReviewers(db, scope);
        if (attempt.actorId === scope.actorId && others.length)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: cardTerminalOwnChargeMessage(others[0].name),
          });
        if (
          (needsPeer || input.secondApproval) &&
          !others.some((p) => p.id === input.secondApproval?.userId) &&
          !(
            needsPeer &&
            !input.secondApproval &&
            input.declareSelfApproval &&
            others.length === 0 &&
            (await maySignOwnRefundCorrection(db, scope))
          )
        )
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Independent approval is required. A sole owner must declare self-approval.',
          });
      }
      const pin = await authenticateRefundPin({
        ...pinArgs,
        actorId: scope.actorId,
        pin: input.managerPin,
      });
      if ('blocked' in pin) return pin;
      if (input.secondApproval) {
        const witness = await authenticateRefundPin({
          ...pinArgs,
          actorId: input.secondApproval.userId,
          requestedById: scope.actorId,
          pin: input.secondApproval.managerPin,
        });
        if ('blocked' in witness) return witness;
      }
      return ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        await requireRefundAccountsAccess({ ...ctx, db }, scope.branchId);
        if (input.kind === 'BOOK_HISTORICAL') {
          if (input.previousId !== 'review:' + attempt.id || attempt.status !== 'REVERSED')
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Choose an original refund-owed review.',
            });
          const root = await loadOriginalReview(db, scope, attemptId, input.verifiedAmountMinor);
          annotateAudit(ctx, {
            metadata: {
              attemptId,
              refundEventId: root.id,
              verifiedBy: scope.actorId,
              pinVerified: true,
            },
          });
          return {
            id: root.id,
            kind: root.kind,
            previousId: root.previousId,
            amountMinor: root.amountMinor,
          };
        }
        if (!previous) await loadOriginalReview(db, scope, attemptId, input.verifiedAmountMinor);
        const event = await changeProviderRefund(
          db,
          scope,
          {
            previousId: input.previousId,
            kind: input.kind,
            settledOn: input.settledOn,
            settlementAmountMinor: input.settlementAmountMinor,
            verifiedAmountMinor: input.verifiedAmountMinor,
            commandKey: input.commandKey,
            slipRef: input.slipRef,
            reason: input.resolutionReason,
          },
          {
            pinVerified: true,
            secondApproverId: input.secondApproval?.userId,
            declareSelfApproval: input.declareSelfApproval,
          }
        );
        return {
          id: event.id,
          kind: event.kind,
          previousId: event.previousId,
          amountMinor: event.amountMinor,
        };
      });
    }),
  availability: protectedProcedure
    .input(z.object({ branchId, deviceId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
      const terminal = await resolvePharmacyCardTerminal(scope, input.deviceId);
      return {
        available: admitted(terminal),
        currency: PHARMACY_TERMINAL_CURRENCY,
        // Whether this person may resolve a payment under review (the server checks again).
        mayResolveReview: await actorMayRefund(ctx.db, ctx.session!.user),
      };
    }),
  attempt: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
      const latest = await storeFor(scope).latestForSale(scope, input.saleId);
      if (!latest) return null;
      return {
        ...cardTerminalCounterView(latest),
        reviewAccess:
          latest.status === 'MANUAL_REVIEW' ? await reviewAccessFor(ctx, scope, latest) : null,
      };
    }),
  charge: protectedProcedure
    .input(
      z
        .object({
          branchId,
          saleId: z.string().min(1).max(128),
          deviceId: z.string().min(1).max(128),
          businessDate: z.date(),
          amountMinor: z.number().int().positive().max(2147483647),
          attemptKey,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        const { deps, terminal } = await depsFor(scope, input.deviceId);
        const attempt = await chargeCardTerminal(deps, scope, {
          saleId: input.saleId,
          deviceId: input.deviceId,
          terminalId: terminal.terminalId,
          attemptKey: input.attemptKey,
          amountMinor: input.amountMinor,
          currency: PHARMACY_TERMINAL_CURRENCY,
          businessDate: input.businessDate,
        });
        return cardTerminalCounterView(attempt);
      } catch (error) {
        fail(error);
      }
    }),
  checkStatus: protectedProcedure
    .input(z.object({ branchId, attemptKey }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        const store = storeFor(scope);
        const attempt = await store.get(scope, input.attemptKey);
        if (!attempt) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
        // The terminal that took the charge answers for it.
        const { deps } = await depsFor(scope, attempt.deviceId);
        return cardTerminalCounterView(
          await recoverCardTerminalAttempt({ ...deps, store }, scope, input.attemptKey)
        );
      } catch (error) {
        fail(error);
      }
    }),
  resolveReview: protectedProcedure
    .input(
      z
        .object({
          branchId,
          attemptKey,
          outcome: z.enum(['DECLINED', 'REVERSED']),
          verifiedAmountMinor: z.number().int().positive().max(2147483647).optional(),
          // Both are typed by hand, so the request audit redacts them by key (a card number may be
          // typed by mistake); the attempt's own audit entry records them card-number masked.
          resolutionReason: z.string().trim().min(3).max(200),
          slipRef: z.string().trim().min(1).max(64),
          // The signed-in manager's or owner's own PIN, re-entered for every resolution.
          managerPin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const resolve = async () => {
        try {
          const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
          // The refund rule: cashiers cannot resolve; a manager or owner re-enters their PIN.
          if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
            throw new TRPCError({ code: 'FORBIDDEN', message: CARD_TERMINAL_REVIEW_FORBIDDEN });
          const { managerPin, resolutionReason, ...resolution } = input;
          const store = storeFor(scope);
          const attempt = await store.get(scope, input.attemptKey);
          if (!attempt) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
          // Second person: a charge you took is resolved by someone else who could resolve it at
          // this branch (`otherCardTerminalReviewers`). Only when nobody could does the solo rule
          // let you resolve it with your PIN. Refused here, before any PIN is asked, naming who can;
          // the service checks again inside the write's transaction.
          const ownCharge = attempt.actorId === scope.actorId;
          if (ownCharge) {
            const [other] = await otherCardTerminalReviewers(ctx.db as unknown as ScopedDb, scope);
            if (other)
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: cardTerminalOwnChargeMessage(other.name),
              });
          }
          const soloOwner = ownCharge;
          // An independent transaction, so a refused PIN commits its lockout strike and its
          // FAILURE audit row even though this request answers with a refusal.
          const pin = await authenticateRefundPin({
            organizationId: scope.organizationId,
            actorId: scope.actorId,
            pin: managerPin,
            action: 'pharmacyCardTerminal.resolveReview',
            policy: CARD_TERMINAL_REVIEW_PIN_POLICY,
            errorCode: 'CARD_TERMINAL_REVIEW_PIN_REFUSED',
          });
          const approval = {
            // The cashier who took the charge, and the person who resolves it.
            ...refundApprovalAudit({
              initiatedById: attempt.actorId,
              approverId: scope.actorId,
              pin,
            }),
            policy: CARD_TERMINAL_REVIEW_PIN_POLICY,
            soloOwner,
            ...(input.verifiedAmountMinor === undefined
              ? {}
              : { verifiedAmountMinor: input.verifiedAmountMinor }),
          };
          annotateAudit(ctx, { metadata: { ...approval, branchId: scope.branchId } });
          if ('blocked' in pin) return pin;
          // Commits in its own tenant transaction with its audit entry, like every attempt step.
          let resolved;
          try {
            resolved = await resolveCardTerminalReview(
              { store },
              scope,
              { ...resolution, reason: resolutionReason },
              approval,
              // Re-checked inside the write's transaction, with the attempt row locked.
              async (db) => (await otherCardTerminalReviewers(db, scope)).length === 0
            );
          } catch (error) {
            if (
              !(error instanceof CardTerminalError) ||
              error.reason !== 'OWN_CHARGE_NEEDS_ANOTHER_APPROVER'
            )
              throw error;
            // Someone else became able to resolve it after the first check: nothing was written,
            // and the request's audit row must not claim a self-approval.
            annotateAudit(ctx, { metadata: { selfApproved: false, soloOwner: false } });
            const [other] = await otherCardTerminalReviewers(ctx.db as unknown as ScopedDb, scope);
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: cardTerminalOwnChargeMessage(other?.name ?? null),
            });
          }
          return cardTerminalCounterView(resolved);
        } catch (error) {
          fail(error);
        }
      };
      if (input.outcome === 'DECLINED') return resolve();
      const accounts = router({ postReview: pharmacyRefundPostingMutation.mutation(resolve) });
      return accounts.createCaller(ctx).postReview();
    }),
});
