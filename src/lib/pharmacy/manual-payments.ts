import { z } from '@/lib/zod-csp';

export const MANUAL_TENDER_TYPES = ['CARD', 'RAAST', 'JAZZCASH', 'EASYPAISA'] as const;
export const CONFIGURED_MANUAL_TENDER_TYPES = ['RAAST', 'JAZZCASH', 'EASYPAISA'] as const;
export const manualTenderTypeSchema = z.enum(MANUAL_TENDER_TYPES);
export type ManualTenderType = z.infer<typeof manualTenderTypeSchema>;
const TENDER_LABELS = new Map<string, string>([
  ['CASH', 'Cash'],
  ['CARD', 'Card'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['WALLET', 'Wallet'],
  ['CREDIT', 'Khata'],
  ['KHATA', 'Khata'],
  ['LOYALTY', 'Loyalty points'],
  ['RAAST', 'Raast'],
  ['JAZZCASH', 'JazzCash'],
  ['EASYPAISA', 'Easypaisa'],
]);
export function tenderLabel(type: string): string {
  return TENDER_LABELS.get(type) ?? 'Other payment';
}
export function isManualTender(type: string): type is ManualTenderType {
  return MANUAL_TENDER_TYPES.some((value) => value === type);
}

// Embedded raster only: no remote tracking URLs, SVG, or executable uploads.
export const merchantQrSchema = z
  .string()
  .max(350_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const destinationSchema = z
  .object({
    destination: z.string().trim().max(120),
    qrImageDataUrl: merchantQrSchema.optional(),
    allowReferenceSkip: z.boolean().default(false),
  })
  .strict();
export const manualPaymentSettingsSchema = z
  .object({
    RAAST: destinationSchema.optional(),
    JAZZCASH: destinationSchema.optional(),
    EASYPAISA: destinationSchema.optional(),
  })
  .strict();
export type ManualPaymentSettings = z.infer<typeof manualPaymentSettingsSchema>;
export const manualTenderCaptureSchema = z
  .object({
    type: manualTenderTypeSchema,
    providerRef: z.string().trim().min(4).max(120).optional(),
    approvalCode: z.string().trim().min(1).max(60).optional(),
    payerName: z.string().trim().min(1).max(100).optional(),
    referenceSkipped: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === 'CARD') {
      if (!value.providerRef)
        ctx.addIssue({
          code: 'custom',
          path: ['providerRef'],
          message: 'Enter the terminal reference or last 4 digits.',
        });
      if (!value.approvalCode)
        ctx.addIssue({
          code: 'custom',
          path: ['approvalCode'],
          message: 'Enter the terminal approval code.',
        });
      if (value.referenceSkipped || value.payerName)
        ctx.addIssue({
          code: 'custom',
          message: 'Card terminal capture does not accept wallet payer fields.',
        });
      return;
    }
    if (!value.payerName)
      ctx.addIssue({ code: 'custom', path: ['payerName'], message: 'Enter the payer name.' });
    if (
      value.referenceSkipped === true
        ? value.providerRef !== undefined
        : value.providerRef === undefined
    )
      ctx.addIssue({
        code: 'custom',
        path: ['providerRef'],
        message: 'Enter the transaction ID, or explicitly skip under branch policy.',
      });
  });

// Signed offline rules carry permission only. QR image bytes stay out of the
// replay wire payload, keeping the existing transport size limit intact.
export const manualMerchantPoliciesSchema = z
  .object({
    CARD: z.object({ allowReferenceSkip: z.literal(false) }).optional(),
    RAAST: z.object({ allowReferenceSkip: z.boolean() }).optional(),
    JAZZCASH: z.object({ allowReferenceSkip: z.boolean() }).optional(),
    EASYPAISA: z.object({ allowReferenceSkip: z.boolean() }).optional(),
  })
  .strict();
export function manualMerchantPolicies(settings: ManualPaymentSettings) {
  const policies: z.infer<typeof manualMerchantPoliciesSchema> = {
    CARD: { allowReferenceSkip: false },
  };
  for (const type of CONFIGURED_MANUAL_TENDER_TYPES) {
    const merchant = settings[type];
    if (merchant) policies[type] = { allowReferenceSkip: merchant.allowReferenceSkip };
  }
  return policies;
}

export function validateManualTender(settings: unknown, capture: unknown) {
  return validateManualTenderPolicy(
    manualMerchantPolicies(manualPaymentSettingsSchema.parse(settings ?? {})),
    capture
  );
}
export function validateManualTenderPolicy(policies: unknown, capture: unknown) {
  const parsed = manualTenderCaptureSchema.parse(capture);
  const destination = manualMerchantPoliciesSchema.parse(policies ?? {})[parsed.type];
  if (!destination) throw new Error('This branch has no merchant details for this tender.');
  if (parsed.referenceSkipped && !destination.allowReferenceSkip)
    throw new Error('This branch requires a transaction reference.');
  return parsed;
}

export const tenderTotalsSchema = z.array(
  z
    .object({
      type: z.string().min(1),
      amountMinor: z.number().int().nonnegative().safe(),
      refundMinor: z.number().int().nonnegative().safe(),
      netMinor: z.number().int().safe(),
      confirmedBy: z.array(z.string().min(1)).optional(),
    })
    .strict()
);

export function aggregateTenderTotals(
  tenders: readonly { type: string; amountMinor: number; confirmedBy?: string | null }[],
  refunds: readonly {
    amountMinor: number;
    drawerSessionId: string | null;
    originalTender: { type: string };
  }[]
) {
  const totals = new Map<
    string,
    {
      type: string;
      amountMinor: number;
      refundMinor: number;
      netMinor: number;
      confirmedBy: string[];
    }
  >();
  const row = (type: string) => {
    if (!totals.has(type))
      totals.set(type, { type, amountMinor: 0, refundMinor: 0, netMinor: 0, confirmedBy: [] });
    return totals.get(type)!;
  };
  for (const tender of tenders) {
    const total = row(tender.type);
    total.amountMinor += tender.amountMinor;
    if (tender.confirmedBy && !total.confirmedBy.includes(tender.confirmedBy))
      total.confirmedBy.push(tender.confirmedBy);
  }
  for (const refund of refunds)
    row(refund.drawerSessionId ? 'CASH' : refund.originalTender.type).refundMinor +=
      refund.amountMinor;
  return tenderTotalsSchema.parse(
    [...totals.values()]
      .sort((a, b) => a.type.localeCompare(b.type))
      .map((value) => {
        const { confirmedBy, ...amounts } = value;
        return {
          ...amounts,
          ...(confirmedBy.length ? { confirmedBy: confirmedBy.sort() } : {}),
          netMinor: value.amountMinor - value.refundMinor,
        };
      })
  );
}
