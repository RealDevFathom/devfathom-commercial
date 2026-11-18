import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  terminalAdmissionRefusal,
  PRODUCTION_TERMINAL_ADMISSION,
} from '@/lib/pharmacy/card-terminal/contract';
import { cardTerminalCounterView } from '@/lib/pharmacy/card-terminal/counter-view';
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
import { isSoleActiveApprover } from '@/lib/pharmacy/counter-line-approval';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';

import { protectedProcedure, router } from '../trpc';
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

export const pharmacyCardTerminalRouter = router({
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
      return latest ? cardTerminalCounterView(latest) : null;
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
      try {
        const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
        // The refund rule: cashiers cannot resolve; a manager or owner re-enters their PIN.
        if (!(await actorMayRefund(ctx.db, ctx.session!.user)))
          throw new TRPCError({ code: 'FORBIDDEN', message: CARD_TERMINAL_REVIEW_FORBIDDEN });
        const { managerPin, resolutionReason, ...resolution } = input;
        const store = storeFor(scope);
        const attempt = await store.get(scope, input.attemptKey);
        if (!attempt) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
        // Second person: a charge you took is resolved by another manager or owner, unless no
        // other active member holds `pharmacy:manage` (the solo-pharmacy rule, as the Khata
        // over-limit approval applies it). Refused before any PIN is asked.
        const ownCharge = attempt.actorId === scope.actorId;
        const soloOwner =
          ownCharge &&
          (await isSoleActiveApprover(ctx.db as unknown as ScopedDb, scope, 'KHATA_OVER_LIMIT'));
        if (ownCharge && !soloOwner)
          throw new TRPCError({ code: 'FORBIDDEN', message: CARD_TERMINAL_REVIEW_OWN_CHARGE });
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
        };
        annotateAudit(ctx, { metadata: { ...approval, branchId: scope.branchId } });
        if ('blocked' in pin) return pin;
        // Commits in its own tenant transaction with its audit entry, like every attempt step.
        const resolved = await resolveCardTerminalReview(
          { store },
          scope,
          { ...resolution, reason: resolutionReason },
          approval,
          // The service checks the attempt again as it reads it to resolve.
          async () => soloOwner
        );
        return cardTerminalCounterView(resolved);
      } catch (error) {
        fail(error);
      }
    }),
});
