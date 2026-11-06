import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(500);
export const GENERAL_JOURNAL_MIN_DATE = new Date('2000-01-01T00:00:00.000Z');
export const GENERAL_JOURNAL_MAX_DATE = new Date('2100-01-01T00:00:00.000Z');

const instant = z.coerce
  .date()
  .refine((value) => Number.isFinite(value.getTime()), 'Invalid date')
  .refine(
    (value) => value >= GENERAL_JOURNAL_MIN_DATE && value < GENERAL_JOURNAL_MAX_DATE,
    'Date is outside the supported accounting window'
  );

export const createJournalDraftSchema = z
  .object({
    branchId: id,
    reference: z.string().trim().min(1).max(80),
    purpose: z.literal('NONTRADE_OPERATING_ACCRUAL'),
    amountMinor: z.number().int().positive().max(2_147_483_647),
    currency: z.enum(['PKR', 'USD']),
    occurredAt: instant,
    evidence: text,
    reason: text,
    idempotencyKey: id,
  })
  .strict();

export const journalCommandSchema = z
  .object({ documentId: id, version: z.number().int().positive(), idempotencyKey: id })
  .strict();
export const reverseJournalSchema = journalCommandSchema
  .extend({ at: instant, reason: text })
  .strict();
export const updateJournalDraftSchema = createJournalDraftSchema
  .omit({ branchId: true, idempotencyKey: true })
  .extend({ documentId: id, version: z.number().int().positive() })
  .strict();
