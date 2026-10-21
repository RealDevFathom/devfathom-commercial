import { createHash } from 'node:crypto';
import { z } from 'zod';

// Domain snapshot, deliberately NOT an unverified PRAL wire payload. Tax mapping,
// POS registration and live transport require official FBR confirmation first.
export const FiscalInvoiceSchema = z
  .object({
    usin: z.string().min(1).max(50),
    issuedAt: z.string().datetime(),
    totalMinor: z.number().int().nonnegative().safe(),
    discountMinor: z.number().int().nonnegative().safe(),
    lines: z
      .array(
        z
          .object({
            code: z.string().min(1),
            description: z.string().min(1),
            quantity: z.number().int().positive(),
            unitPriceMinor: z.number().int().nonnegative().safe(),
            discountMinor: z.number().int().nonnegative().safe(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();
export type FiscalInvoice = z.infer<typeof FiscalInvoiceSchema>;
export type FiscalResult = { invoiceNumber: string; mode: 'MOCK' };
export interface FiscalAdapter {
  register(): Promise<{ mode: 'MOCK' }>;
  submit(invoice: FiscalInvoice): Promise<FiscalResult>;
  creditNote(): Promise<never>;
  qrPayload(invoiceNumber: string): string;
  healthcheck(): Promise<boolean>;
}

/** Deterministic across process restarts: replaying a USIN cannot mint a second number. */
export class MockFbrAdapter implements FiscalAdapter {
  async register() {
    return { mode: 'MOCK' as const };
  }
  async submit(raw: FiscalInvoice): Promise<FiscalResult> {
    const invoice = FiscalInvoiceSchema.parse(raw);
    return {
      invoiceNumber: `MOCK-FBR-${createHash('sha256').update(invoice.usin).digest('hex').slice(0, 24)}`,
      mode: 'MOCK',
    };
  }
  async creditNote(): Promise<never> {
    throw new Error('FBR credit notes are not implemented.');
  }
  qrPayload(invoiceNumber: string) {
    return invoiceNumber;
  }
  async healthcheck() {
    return true;
  }
}

export function configuredFiscalAdapter(): FiscalAdapter | null {
  // Unknown/live modes fail closed: this lane never sends credentials or HTTP.
  return process.env.FBR_MODE === 'mock' ? new MockFbrAdapter() : null;
}
export function fiscalRetryAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(3600, 5 * 2 ** Math.min(attempts - 1, 10)) * 1000);
}
