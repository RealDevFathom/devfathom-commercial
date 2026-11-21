import { pharmacyAccountMutation } from '@/server/pharmacy-finance-gate';
/**
 * CEO-JVCORE-20261025: pharmacy general-journal voucher commands.
 *
 * Every procedure authorizes (licence, ABAC, active branch) before it reads or
 * writes a voucher, and every write runs in one business transaction. Posting
 * and reversal also write their EXECUTE audit row inside that transaction.
 */
import { TRPCError } from '@trpc/server';
import {
  JOURNAL_VOUCHER_CATALOG,
  JOURNAL_VOUCHER_PURPOSE_LABELS,
  JOURNAL_VOUCHER_PURPOSES,
} from '@/lib/pharmacy/accounts/coa';
import {
  cancelJournalVoucherDraft,
  createJournalVoucherDraft,
  getJournalVoucher,
  listJournalVouchers,
  PharmacyJournalVoucherError,
  postJournalVoucher,
  reverseJournalVoucher,
  updateJournalVoucherDraft,
} from '@/lib/pharmacy/accounts/general-journal';
import {
  cancelJournalVoucherDraftSchema,
  createJournalVoucherDraftSchema,
  getJournalVoucherSchema,
  listJournalVouchersSchema,
  postJournalVoucherSchema,
  reverseJournalVoucherSchema,
  updateJournalVoucherDraftSchema,
} from '@/lib/pharmacy/accounts/general-journal-schema';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  authorizeGeneralJournal,
  recordGeneralJournalExecuteAudit,
} from '../pharmacy-general-journal-security';
import { adminProcedure, router } from '../trpc';
import { z } from 'zod';

const CONFLICT_REASONS = new Set([
  'STALE_VERSION',
  'ALREADY_POSTED',
  'ALREADY_REVERSED',
  'DUPLICATE_REFERENCE',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE',
]);

function fail(error: unknown): never {
  if (error instanceof PharmacyJournalVoucherError) {
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

export const pharmacyGeneralJournalRouter = router({
  catalog: adminProcedure
    .input(z.object({ branchId: z.string().trim().min(1).max(128) }).strict())
    .query(async ({ ctx, input }) => {
      await authorizeGeneralJournal(ctx, input.branchId);
      return JOURNAL_VOUCHER_PURPOSES.map((purpose) => ({
        purpose,
        label: JOURNAL_VOUCHER_PURPOSE_LABELS[purpose],
        legs: JOURNAL_VOUCHER_CATALOG[purpose],
      }));
    }),

  list: adminProcedure.input(listJournalVouchersSchema).query(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    return {
      scope: { organizationId: scope.organizationId, branchId: scope.branchId },
      vouchers: await listJournalVouchers(ctx.db, scope, input),
      retrievedAt: new Date(),
    };
  }),

  get: adminProcedure.input(getJournalVoucherSchema).query(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    try {
      return await getJournalVoucher(ctx.db, scope, input.voucherId);
    } catch (error) {
      fail(error);
    }
  }),

  createDraft: pharmacyAccountMutation
    .input(createJournalVoucherDraftSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) => createJournalVoucherDraft(txDb(tx), scope, input));
      } catch (error) {
        fail(error);
      }
    }),

  updateDraft: pharmacyAccountMutation
    .input(updateJournalVoucherDraftSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) => updateJournalVoucherDraft(txDb(tx), scope, input));
      } catch (error) {
        fail(error);
      }
    }),

  cancelDraft: pharmacyAccountMutation
    .input(cancelJournalVoucherDraftSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        return await ctx.db.$transaction((tx) => cancelJournalVoucherDraft(txDb(tx), scope, input));
      } catch (error) {
        fail(error);
      }
    }),

  post: pharmacyAccountMutation.input(postJournalVoucherSchema).mutation(async ({ ctx, input }) => {
    const scope = await authorizeGeneralJournal(ctx, input.branchId);
    try {
      return await ctx.db.$transaction(async (tx) => {
        const db = txDb(tx);
        const result = await postJournalVoucher(db, scope, input);
        await recordGeneralJournalExecuteAudit(db, ctx, scope, {
          action: 'pharmacyGeneralJournal.post',
          voucher: result.voucher,
          entryId: result.voucher.journalEntryId!,
          commandKey: input.commandKey,
          replayed: result.replayed,
        });
        return result.voucher;
      });
    } catch (error) {
      fail(error);
    }
  }),

  reverse: pharmacyAccountMutation
    .input(reverseJournalVoucherSchema)
    .mutation(async ({ ctx, input }) => {
      const scope = await authorizeGeneralJournal(ctx, input.branchId);
      try {
        return await ctx.db.$transaction(async (tx) => {
          const db = txDb(tx);
          const result = await reverseJournalVoucher(db, scope, input);
          await recordGeneralJournalExecuteAudit(db, ctx, scope, {
            action: 'pharmacyGeneralJournal.reverse',
            voucher: result.voucher,
            entryId: result.voucher.reversalEntryId!,
            commandKey: input.commandKey,
            replayed: result.replayed,
          });
          return result.voucher;
        });
      } catch (error) {
        fail(error);
      }
    }),
});
