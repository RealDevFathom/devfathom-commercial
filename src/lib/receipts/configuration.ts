import { z } from 'zod';

// Semantic browser text, not an assertion of printer encoding support. Preserve
// Unicode/combining/joining characters; reject commands, bidi overrides and broken UTF-16.
export const receiptTextSchema = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^[^\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\p{Cs}]*$/u,
      'Use valid text without control characters or printer commands.'
    );

const text = (max: number) =>
  receiptTextSchema(max).regex(/^[^<>]*$/, 'Use plain text without markup.');

export const ReceiptLayoutSchema = z
  .object({
    version: z.literal(1),
    paperWidth: z.union([z.literal(58), z.literal(80)]),
    businessText: text(240),
    headerText: text(240),
    footerText: text(500),
    showOrderNumber: z.boolean(),
    showChannel: z.boolean(),
    /**
     * Pharmacy: the paper the browser/OS print route opens on by default. Absent
     * means the thermal roll at `paperWidth`; 'A4' is an ordinary sheet printer.
     * The ESC/POS job always uses `paperWidth` and ignores this preference.
     */
    browserPaper: z.enum(['THERMAL', 'A4']).optional(),
  })
  .strict();

export type ReceiptLayout = z.infer<typeof ReceiptLayoutSchema>;
export const DEFAULT_RECEIPT_LAYOUT: Readonly<ReceiptLayout> = Object.freeze({
  version: 1,
  paperWidth: 80,
  businessText: '',
  headerText: '',
  footerText: 'Thank you for your visit.',
  showOrderNumber: true,
  showChannel: true,
});

export const SaveReceiptLayoutSchema = z
  .object({
    branchId: z.string().min(1).max(128),
    revision: z.number().int().min(0).max(2147483646),
    layout: ReceiptLayoutSchema,
  })
  .strict();

/** Only absent configuration receives defaults; corrupt stored values fail closed. */
export function readReceiptLayout(value: unknown): ReceiptLayout {
  return ReceiptLayoutSchema.parse(value === null ? DEFAULT_RECEIPT_LAYOUT : value);
}
