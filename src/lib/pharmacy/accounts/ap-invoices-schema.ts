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
    commandKey,
    reference: z.string().trim().min(1).max(80),
    amountMinor,
    paidAt: instant,
    fundingAccount: z.enum(['CASH', 'BANK']),
    bankReference: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const reverseApSettlementSchema = z
  .object({
    branchId: id,
    settlementId: id,
    commandKey,
    reason: z.string().trim().min(1).max(500),
    at: instant,
  })
  .strict();

export const reverseApInvoiceSchema = z
  .object({
    branchId: id,
    invoiceId: id,
    commandKey,
    reason: z.string().trim().min(1).max(500),
    at: instant,
  })
  .strict();

export const listApInvoicesSchema = z
  .object({
    branchId: id,
    status: z.enum(['POSTED', 'REVERSED']).optional(),
    take: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const apAgingSchema = z.object({ branchId: id, asOf: calendarDate }).strict();

export type RecordApInvoiceInput = z.infer<typeof recordApInvoiceSchema>;
export type PayApInvoiceInput = z.infer<typeof payApInvoiceSchema>;
export type ReverseApSettlementInput = z.infer<typeof reverseApSettlementSchema>;
export type ReverseApInvoiceInput = z.infer<typeof reverseApInvoiceSchema>;
export type ListApInvoicesInput = z.infer<typeof listApInvoicesSchema>;
