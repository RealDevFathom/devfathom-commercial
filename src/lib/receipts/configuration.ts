import { z } from 'zod';

// Printable ASCII matches the existing ESC/POS baseline. Reject commands, markup,
// bidi controls and unsupported glyphs instead of silently changing printed text.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^[\x20-\x3b\x3d\x3f-\x7e\n]*$/,
      'Use plain printable text without markup or printer commands.'
    );

export const ReceiptLayoutSchema = z
  .object({
    version: z.literal(1),
    paperWidth: z.union([z.literal(58), z.literal(80)]),
    businessText: text(240),
    headerText: text(240),
    footerText: text(500),
    showOrderNumber: z.boolean(),
    showChannel: z.boolean(),
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
