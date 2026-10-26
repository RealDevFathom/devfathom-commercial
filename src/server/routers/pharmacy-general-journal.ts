import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { cancelGeneralJournal, createGeneralJournalDraft, PharmacyGeneralJournalError, postGeneralJournal, reverseGeneralJournal, updateGeneralJournalDraft } from '@/lib/pharmacy/accounts/general-journal';
import { createJournalDraftSchema, journalCommandSchema, reverseJournalSchema, updateJournalDraftSchema } from '@/lib/pharmacy/accounts/general-journal-schema';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authorizePharmacyGeneralJournal, authorizePharmacyGeneralJournalCollection } from '../pharmacy-general-journal-security';
import { adminProcedure, router } from '../trpc';

function fail(error: unknown): never {
  if (error instanceof PharmacyGeneralJournalError) throw new TRPCError({ code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : error.reason === 'STALE_VERSION' || error.reason === 'INVALID_STATE' ? 'CONFLICT' : 'BAD_REQUEST', message: error.reason });
  throw error;
}

export function documentDto(document: {
  id: string; branchId: string; reference: string; purpose: string; status: string; amountMinor: number; currency: string;
  occurredAt: Date; evidence: string; reason: string; version: number; postedAt: Date | null; cancelledAt: Date | null;
  reversedAt: Date | null; createdAt: Date; updatedAt: Date;
}) {
  const { id, branchId, reference, purpose, status, amountMinor, currency, occurredAt, evidence, reason, version, postedAt, cancelledAt, reversedAt, createdAt, updatedAt } = document;
  return { id, branchId, reference, purpose, status, amountMinor, currency, occurredAt, evidence, reason, version, postedAt, cancelledAt, reversedAt, createdAt, updatedAt };
}

export const pharmacyGeneralJournalRouter = router({
  branches: adminProcedure.query(async ({ ctx }) => {
    const scope = await authorizePharmacyGeneralJournalCollection(ctx);
    return ctx.db.pharmacyBranch.findMany({ where: { organizationId: scope.organizationId, active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }),
  accounts: adminProcedure.input(z.object({ branchId: z.string().trim().min(1).max(128) }).strict()).query(async ({ ctx, input }) => {
    await authorizePharmacyGeneralJournal(ctx, input.branchId);
    return [
      { code: 'OPERATING_EXPENSE', side: 'DEBIT', name: 'Operating expense' },
      { code: 'MANUAL_NONTRADE_ACCRUAL', side: 'CREDIT', name: 'Manual non-trade accrual' },
    ];
  }),
  list: adminProcedure.input(z.object({ branchId: z.string().trim().min(1).max(128) }).strict()).query(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    const documents = await ctx.db.pharmacyGeneralJournalDocument.findMany({ where: { organizationId: scope.organizationId, branchId: scope.branchId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return documents.map(documentDto);
  }),
  createDraft: adminProcedure.input(createJournalDraftSchema).mutation(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    try { return documentDto(await ctx.db.$transaction((tx) => createGeneralJournalDraft(tx as ScopedDb, scope, input))); } catch (error) { fail(error); }
  }),
  updateDraft: adminProcedure.input(updateJournalDraftSchema.extend({ branchId: z.string().trim().min(1).max(128) }).strict()).mutation(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    try { return documentDto(await ctx.db.$transaction((tx) => updateGeneralJournalDraft(tx as ScopedDb, scope, input))); } catch (error) { fail(error); }
  }),
  post: adminProcedure.input(journalCommandSchema.extend({ branchId: z.string().trim().min(1).max(128) }).strict()).mutation(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    try { return documentDto(await ctx.db.$transaction((tx) => postGeneralJournal(tx as ScopedDb, scope, input))); } catch (error) { fail(error); }
  }),
  cancel: adminProcedure.input(journalCommandSchema.omit({ idempotencyKey: true }).extend({ branchId: z.string().trim().min(1).max(128) }).strict()).mutation(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    try { return documentDto(await ctx.db.$transaction((tx) => cancelGeneralJournal(tx as ScopedDb, scope, input))); } catch (error) { fail(error); }
  }),
  reverse: adminProcedure.input(reverseJournalSchema.extend({ branchId: z.string().trim().min(1).max(128) }).strict()).mutation(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    try { return documentDto(await ctx.db.$transaction((tx) => reverseGeneralJournal(tx as ScopedDb, scope, input))); } catch (error) { fail(error); }
  }),
});
