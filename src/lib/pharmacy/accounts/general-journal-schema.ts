/**
 * CEO-JVCORE-20261025: input contracts for the pharmacy general-journal
 * voucher commands. Shared by the router (wire validation) and the domain
 * module (which re-validates the business rules on the server).
 */
import { z } from 'zod';
import { JOURNAL_VOUCHER_PURPOSES } from './coa';

/** Largest single leg; keeps every amount and the two-leg sum inside Int32. */
export const JOURNAL_VOUCHER_MAX_LINE_MINOR = 999_999_999;
export const JOURNAL_VOUCHER_MAX_LINES = 2;

const id = z.string().trim().min(1).max(128);
const commandKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/, 'Use letters, digits, colon, underscore or hyphen.');
const instant = z.iso.datetime({ offset: true });

export const journalVoucherLineSchema = z
  .object({
    accountCode: z.string().trim().min(1).max(64),
    side: z.enum(['DEBIT', 'CREDIT']),
    amountMinor: z.number().int().positive().max(JOURNAL_VOUCHER_MAX_LINE_MINOR),
    memo: z.string().trim().max(240).optional(),
  })
  .strict();

const draftFields = {
  branchId: id,
  reference: z.string().trim().min(1).max(80),
  purpose: z.enum(JOURNAL_VOUCHER_PURPOSES),
  occurredAt: instant,
  currency: z.enum(['PKR', 'USD']).default('PKR'),
  reason: z.string().trim().min(1).max(500),
  evidenceReference: z.string().trim().min(1).max(160),
  lines: z.array(journalVoucherLineSchema).min(1).max(JOURNAL_VOUCHER_MAX_LINES),
};

export const createJournalVoucherDraftSchema = z
  .object({ ...draftFields, createKey: commandKey })
  .strict();

export const updateJournalVoucherDraftSchema = z
  .object({
    ...draftFields,
    voucherId: id,
    expectedVersion: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export const cancelJournalVoucherDraftSchema = z
  .object({
    branchId: id,
    voucherId: id,
    expectedVersion: z.number().int().min(1).max(1_000_000),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const postJournalVoucherSchema = z
  .object({
    branchId: id,
    voucherId: id,
    expectedVersion: z.number().int().min(1).max(1_000_000),
    commandKey,
  })
  .strict();

export const reverseJournalVoucherSchema = z
  .object({
    branchId: id,
    voucherId: id,
    commandKey,
    reason: z.string().trim().min(1).max(500),
    at: instant,
  })
  .strict();

export const listJournalVouchersSchema = z
  .object({
    branchId: id,
    status: z.enum(['DRAFT', 'CANCELLED', 'POSTED', 'REVERSED']).optional(),
    take: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const getJournalVoucherSchema = z.object({ branchId: id, voucherId: id }).strict();

export type CreateJournalVoucherDraftInput = z.infer<typeof createJournalVoucherDraftSchema>;
export type UpdateJournalVoucherDraftInput = z.infer<typeof updateJournalVoucherDraftSchema>;
export type CancelJournalVoucherDraftInput = z.infer<typeof cancelJournalVoucherDraftSchema>;
export type PostJournalVoucherInput = z.infer<typeof postJournalVoucherSchema>;
export type ReverseJournalVoucherInput = z.infer<typeof reverseJournalVoucherSchema>;
export type JournalVoucherLineInput = z.infer<typeof journalVoucherLineSchema>;
