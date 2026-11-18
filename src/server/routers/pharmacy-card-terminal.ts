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
  type CardTerminalDeps,
} from '@/lib/pharmacy/card-terminal/service';
import {
  CardTerminalError,
  PHARMACY_TERMINAL_CURRENCY,
  prismaCardTerminalAttemptStore,
  type CardTerminalAttemptStore,
} from '@/lib/pharmacy/card-terminal/store';
import type { LedgerScope } from '@/lib/pharmacy/stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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
 *
 * The browser never names the provider, the terminal or the currency: the server resolves the
 * terminal paired with the counter and charges in PKR only. A charge needs the same counter
 * access as any other tender. Manual Card and Wallet tenders (DEV-713) do not pass through here.
 */

const branchId = z.string().trim().min(1).max(128);
const attemptKey = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);

type CounterContext = TRPCContext;

/** One committed tenant transaction per store call, so each attempt state survives a crash. */
function storeFor(ctx: CounterContext): CardTerminalAttemptStore {
  return prismaCardTerminalAttemptStore((work) =>
    ctx.db.$transaction((tx) => work(tx as unknown as ScopedDb))
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
  ctx: CounterContext,
  scope: LedgerScope,
  deviceId: string
): Promise<{ deps: CardTerminalDeps; terminal: ResolvedCardTerminal }> {
  const terminal = await resolvePharmacyCardTerminal(scope, deviceId);
  if (!admitted(terminal))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'UNCERTIFIED_PROVIDER' });
  return {
    terminal,
    deps: {
      store: storeFor(ctx),
      adapter: terminal.adapter,
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
      return { available: admitted(terminal), currency: PHARMACY_TERMINAL_CURRENCY };
    }),
  attempt: protectedProcedure
    .input(z.object({ branchId, saleId: z.string().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      const scope = await requireCounterReceiptAccess(ctx, input.branchId, true);
      const latest = await storeFor(ctx).latestForSale(scope, input.saleId);
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
        const { deps, terminal } = await depsFor(ctx, scope, input.deviceId);
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
        const store = storeFor(ctx);
        const attempt = await store.get(scope, input.attemptKey);
        if (!attempt) throw new CardTerminalError('ATTEMPT_NOT_FOUND');
        // The terminal that took the charge answers for it.
        const { deps } = await depsFor(ctx, scope, attempt.deviceId);
        return cardTerminalCounterView(
          await recoverCardTerminalAttempt({ ...deps, store }, scope, input.attemptKey)
        );
      } catch (error) {
        fail(error);
      }
    }),
});
