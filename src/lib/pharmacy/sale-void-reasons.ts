import { z } from 'zod';

/**
 * DEV-508: why an unpaid counter bill was voided. The counter's void dialog offers
 * exactly these, and the server refuses a counter void without one, so every void
 * event carries a reason code a manager can review (DEV-69 void-abuse checks).
 */
export const SALE_VOID_REASONS = {
  CUSTOMER_CHANGED_MIND: 'Customer changed their mind',
  WRONG_ITEMS: 'Wrong items scanned',
  DUPLICATE_BILL: 'Duplicate bill',
  CUSTOMER_LEFT: 'Customer left without paying',
  OTHER: 'Other',
} as const;

export type SaleVoidReasonCode = keyof typeof SALE_VOID_REASONS;

export const SALE_VOID_REASON_CODES = Object.keys(SALE_VOID_REASONS) as [
  SaleVoidReasonCode,
  ...SaleVoidReasonCode[],
];

export const SALE_VOID_NOTE_MAX_LENGTH = 200;

export const saleVoidReasonSchema = z
  .object({
    code: z.enum(SALE_VOID_REASON_CODES),
    note: z.string().trim().max(SALE_VOID_NOTE_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((value) => value.code !== 'OTHER' || Boolean(value.note), {
    message: 'Describe the reason for this void.',
    path: ['note'],
  });

export type SaleVoidReason = z.infer<typeof saleVoidReasonSchema>;

/** The human-readable reason stored on the void event and its stock reversals. */
export function saleVoidReasonText(reason: SaleVoidReason): string {
  const label = SALE_VOID_REASONS[reason.code];
  if (reason.code === 'OTHER') return reason.note ?? label;
  return reason.note ? `${label}: ${reason.note}` : label;
}
