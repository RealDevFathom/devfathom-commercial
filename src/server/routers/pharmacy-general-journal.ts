import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { FinancePostingError } from '@/lib/finance/journal';
import { PHARMACY_GENERAL_JOURNAL_ACCOUNTS } from '@/lib/pharmacy/accounts/coa';
import { cancelGeneralJournal, createGeneralJournalDraft, PharmacyGeneralJournalError, postGeneralJournal, reverseGeneralJournal, updateGeneralJournalDraft } from '@/lib/pharmacy/accounts/general-journal';
import { createJournalDraftSchema, journalCommandSchema, reverseJournalSchema, updateJournalDraftSchema } from '@/lib/pharmacy/accounts/general-journal-schema';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { authorizePharmacyGeneralJournal, authorizePharmacyGeneralJournalCollection } from '../pharmacy-general-journal-security';
import { adminProcedure, router } from '../trpc';

function fail(error: unknown): never {
  if (error instanceof PharmacyGeneralJournalError) throw new TRPCError({ code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : ['STALE_VERSION', 'INVALID_STATE', 'REPLAY_MISMATCH'].includes(error.reason) ? 'CONFLICT' : 'BAD_REQUEST', message: error.reason });
  if (error instanceof FinancePostingError) throw new TRPCError({ code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST', message: error.reason });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new TRPCError({ code: 'CONFLICT', message: 'A voucher with this reference or request key already exists.' });
  }
  throw error;
}

export const GENERAL_JOURNAL_HISTORY_MAX = 100;

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
    return PHARMACY_GENERAL_JOURNAL_ACCOUNTS.map(({ code, normalSide, name }) => ({ code, side: normalSide, name }));
  }),
  // Keyset-paginated, newest first. `cursor` is the last document id already
  // shown; `reference` narrows history so any older voucher stays reachable.
  list: adminProcedure.input(z.object({
    branchId: z.string().trim().min(1).max(128),
    cursor: z.string().trim().min(1).max(128).optional(),
    reference: z.string().trim().max(80).optional(),
    limit: z.number().int().min(1).max(GENERAL_JOURNAL_HISTORY_MAX).optional(),
  }).strict()).query(async ({ ctx, input }) => {
    const scope = await authorizePharmacyGeneralJournal(ctx, input.branchId);
    const where: Prisma.PharmacyGeneralJournalDocumentWhereInput = { organizationId: scope.organizationId, branchId: scope.branchId };
    if (input.reference) where.reference = { contains: input.reference, mode: 'insensitive' };
    if (input.cursor) {
      const anchor = await ctx.db.pharmacyGeneralJournalDocument.findFirst({ where: { organizationId: scope.organizationId, branchId: scope.branchId, id: input.cursor }, select: { id: true, createdAt: true } });
      if (!anchor) throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
      where.OR = [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }];
    }
    const documents = await ctx.db.pharmacyGeneralJournalDocument.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limit ?? GENERAL_JOURNAL_HISTORY_MAX });
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
