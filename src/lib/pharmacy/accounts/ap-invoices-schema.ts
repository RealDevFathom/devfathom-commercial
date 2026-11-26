/**
 * DEV-103: input contracts for native non-stock AP invoices, their
 * invoice-directed settlements and the bounded AP aging view. Shared by the
 * router (wire validation) and the domain module (which re-checks the business
 * rules on the server).
 */
import { z } from 'zod';

/** Largest invoice or payment; keeps every amount inside Int32. */
export const AP_INVOICE_MAX_MINOR = 999_999_999;
/** A due date may run at most this many days past the invoice date. */
export const AP_INVOICE_MAX_TERM_DAYS = 3_650;

const id = z.string().trim().min(1).max(128);
const commandKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/, 'Use letters, digits, colon, underscore or hyphen.');
const calendarDate = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const amountMinor = z.number().int().positive().max(AP_INVOICE_MAX_MINOR);

export const recordApInvoiceSchema = z
  .object({
    branchId: id,
    createKey: commandKey,
    reference: z.string().trim().min(1).max(80),
    payeeName: z.string().trim().min(1).max(160),
    supplierInvoiceRef: z.string().trim().min(1).max(80),
    invoiceDate: calendarDate,
    dueDate: calendarDate,
    amountMinor,
    currency: z.enum(['PKR', 'USD']).default('PKR'),
    description: z.string().trim().min(1).max(500),
    evidenceReference: z.string().trim().min(1).max(160),
  })
  .strict();

export const payApInvoiceSchema = z
  .object({
    branchId: id,
    invoiceId: id,
    pin: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
    commandKey,
    reference: z.string().trim().min(1).max(80),
    amountMinor,
    paidAt: instant,
    fundingAccount: z.enum(['CASH', 'BANK']),
    bankReference: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

/**
 * DEV-103: a manager or owner reverses with their own fresh PIN (never stored). The server dates
 * every reversal now: the schema is strict and has no date, so a caller that sends `at` (to
 * backdate one inside an open period) is refused before anything is read.
 */
export const reverseApSettlementSchema = z
  .object({
    branchId: id,
    settlementId: id,
    commandKey,
    reason: z.string().trim().min(1).max(500),
    pin: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

/**
 * DEV-103: a manager or owner reverses with their own fresh PIN (never stored). The server dates
 * every reversal now: the schema is strict and has no date, so a caller that sends `at` (to
 * backdate one inside an open period) is refused before anything is read.
 */
export const reverseApInvoiceSchema = z
  .object({
    branchId: id,
    invoiceId: id,
    commandKey,
    reason: z.string().trim().min(1).max(500),
    pin: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

export const listApInvoicesSchema = z
  .object({
    branchId: id,
    status: z.enum(['POSTED', 'REVERSED']).optional(),
    take: z.number().int().min(1).max(100).default(50),
  })
  .strict();

/** DEV-103: rows per page of the reversal search. */
export const AP_REVERSAL_PAGE_ROWS = 25;

/**
 * DEV-967: a row of the reversal list, by its place in the list order (newest invoice date
 * first, then id). A page is the rows just older or just newer than one such row, so a bill
 * recorded or reversed between two page reads never moves another row across a page boundary.
 * The row itself need not still be listed (someone may have reversed it since).
 */
export const apReversalCursorSchema = z.object({ invoiceDate: z.iso.datetime(), id }).strict();
export type ApReversalCursor = z.infer<typeof apReversalCursorSchema>;

/**
 * DEV-103: find a posted supplier expense invoice, or a payment in force against one, to reverse.
 * Every filter is optional and they all apply together. `payee` and `reference` match part of the
 * name or reference, ignoring case (`reference` matches our reference or the supplier's invoice
 * number). `amountMinor` (typed amounts go through `amountInputToMinor`) matches the invoice
 * amount or a payment in force exactly. `from`/`to` are calendar days on the shop's clock, both
 * included, and match the invoice date or the day a payment in force was made. Without a cursor
 * the newest page is read; `older` reads the page after that row, `newer` the page before it.
 */
export const searchApReversalsSchema = z
  .object({
    branchId: id,
    payee: z.string().trim().min(1).max(160).optional(),
    reference: z.string().trim().min(1).max(80).optional(),
    amountMinor: amountMinor.optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    older: apReversalCursorSchema.optional(),
    newer: apReversalCursorSchema.optional(),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: 'The from day must be on or before the to day.',
    path: ['to'],
  })
  .refine((input) => !input.older || !input.newer, {
    message: 'Turn the page one way at a time.',
    path: ['newer'],
  });

export const apAgingSchema = z
  .object({
    branchId: id,
    asOf: calendarDate,
    /** DEV-694: narrow the view to one payee when a branch has too many bills. */
    payeeFilter: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

/** DEV-694: staff choose the bill a supplier credit note is set off against. */
export const requestApCreditSetOffSchema = z
  .object({
    branchId: id,
    invoiceId: id,
    supplierCreditId: id,
    requestKey: commandKey,
    amountMinor,
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/** DEV-694: a manager approves with their own fresh PIN; the PIN is never stored. */
export const approveApCreditSetOffSchema = z
  .object({
    branchId: id,
    setOffId: id,
    decisionKey: commandKey,
    pin: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

export const rejectApCreditSetOffSchema = z
  .object({
    branchId: id,
    setOffId: id,
    decisionKey: commandKey,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** DEV-694: undo an approved set-off; the manager's own fresh PIN, never stored. */
export const reverseApCreditSetOffSchema = z
  .object({
    branchId: id,
    setOffId: id,
    commandKey,
    reason: z.string().trim().min(1).max(500),
    pin: z.string().regex(/^\d{4,8}$/),
  })
  .strict();

export const listApCreditSetOffsSchema = z
  .object({
    branchId: id,
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVERSED']).optional(),
    take: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export type RecordApInvoiceInput = z.infer<typeof recordApInvoiceSchema>;
export type PayApInvoiceInput = z.infer<typeof payApInvoiceSchema>;
export type ReverseApSettlementInput = z.infer<typeof reverseApSettlementSchema>;
export type ReverseApInvoiceInput = z.infer<typeof reverseApInvoiceSchema>;
export type ListApInvoicesInput = z.infer<typeof listApInvoicesSchema>;
export type SearchApReversalsInput = z.infer<typeof searchApReversalsSchema>;
export type RequestApCreditSetOffInput = z.infer<typeof requestApCreditSetOffSchema>;
export type ApproveApCreditSetOffInput = z.infer<typeof approveApCreditSetOffSchema>;
export type RejectApCreditSetOffInput = z.infer<typeof rejectApCreditSetOffSchema>;
export type ReverseApCreditSetOffInput = z.infer<typeof reverseApCreditSetOffSchema>;
export type ListApCreditSetOffsInput = z.infer<typeof listApCreditSetOffsSchema>;
