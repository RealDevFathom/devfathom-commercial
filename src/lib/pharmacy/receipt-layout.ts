import { z } from 'zod';
import {
  DEFAULT_RECEIPT_LAYOUT,
  ReceiptLayoutSchema,
  receiptTextSchema,
  SaveReceiptLayoutSchema,
} from '@/lib/receipts/configuration';

export const textBlocks = ['businessText', 'headerText', 'footerText'] as const;
export const optionalSections = ['logo', ...textBlocks, 'brandingQr'] as const;
const alignment = z.enum(['start', 'center', 'end']);
const emphasis = z.enum(['normal', 'bold', 'large']);
export const brandingCaption = 'Scan for our website - not a tax invoice';
const website = receiptTextSchema(213)
  .url()
  .regex(/^https:\/\/[^\s<>"\\]+$/i)
  .refine((value) => new TextEncoder().encode(value).length <= 213, 'Website address is too long.');

export const ReceiptDesignSchema = ReceiptLayoutSchema.extend({
  version: z.literal(2),
  alignment: z.record(z.enum(textBlocks), alignment),
  emphasis: z.record(z.enum(textBlocks), emphasis),
  sections: z
    .array(z.enum(optionalSections))
    .max(optionalSections.length)
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each section once.'),
  logo: z
    .object({ assetId: z.uuid(), maxWidthMm: z.number().int().min(8).max(48) })
    .strict()
    .optional(),
  brandingQr: z.object({ url: website }).strict().optional(),
  locale: z.enum(['en', 'ur', 'both']),
}).strict();
export const PharmacyReceiptLayoutSchema = z.discriminatedUnion('version', [
  ReceiptLayoutSchema,
  ReceiptDesignSchema,
]);
export const SavePharmacyReceiptLayoutSchema = SaveReceiptLayoutSchema.extend({
  layout: PharmacyReceiptLayoutSchema,
}).strict();
export type ReceiptDesign = z.infer<typeof ReceiptDesignSchema>;
export type PharmacyReceiptLayout = z.infer<typeof PharmacyReceiptLayoutSchema>;
export function safePharmacyLayout(value: unknown): PharmacyReceiptLayout {
  const parsed = PharmacyReceiptLayoutSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_RECEIPT_LAYOUT;
}
export function receiptDesign(value: unknown): ReceiptDesign {
  const layout = safePharmacyLayout(value);
  if (layout.version === 2) return layout;
  return {
    ...layout,
    version: 2,
    alignment: { businessText: 'start', headerText: 'start', footerText: 'start' },
    emphasis: { businessText: 'normal', headerText: 'normal', footerText: 'normal' },
    sections: [...optionalSections],
    locale: 'en',
  };
}

/** The saved layout with only the paper fields replaced; every other field is preserved. */
export function layoutWithPaper<T extends PharmacyReceiptLayout>(
  layout: T,
  paper: 'THERMAL' | 'THERMAL_58' | 'A4'
): T {
  if (paper === 'A4') return { ...layout, browserPaper: 'A4' };
  const thermal: T = { ...layout, paperWidth: paper === 'THERMAL_58' ? 58 : 80 };
  delete thermal.browserPaper;
  return thermal;
}
