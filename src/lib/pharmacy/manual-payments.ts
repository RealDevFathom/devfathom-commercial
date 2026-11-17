import { z } from '@/lib/zod-csp';

export const MANUAL_TENDER_TYPES = ['RAAST', 'JAZZCASH', 'EASYPAISA'] as const;
export const manualTenderTypeSchema = z.enum(MANUAL_TENDER_TYPES);
export type ManualTenderType = z.infer<typeof manualTenderTypeSchema>;
export function isManualTender(type: string): type is ManualTenderType {
  return MANUAL_TENDER_TYPES.some((value) => value === type);
}

// Embedded raster only: no remote tracking URLs, SVG, or executable uploads.
export const merchantQrSchema = z.string().max(350_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
// Enabling a wallet is the branch's decision to accept it. Merchant details are
// optional: the counter shows an IBAN, till number or QR only when configured.
const destinationSchema = z.object({
  destination: z.string().trim().max(120).default(''),
  qrImageDataUrl: merchantQrSchema.optional(),
  allowReferenceSkip: z.boolean().default(false),
}).strict();
export const manualPaymentSettingsSchema = z.object({
  RAAST: destinationSchema.optional(),
  JAZZCASH: destinationSchema.optional(),
  EASYPAISA: destinationSchema.optional(),
}).strict();
export type ManualPaymentSettings = z.infer<typeof manualPaymentSettingsSchema>;
export const manualTenderCaptureSchema = z.object({
  type: manualTenderTypeSchema,
  providerRef: z.string().regex(/^\d{4,6}$/).optional(),
  payerName: z.string().trim().min(1).max(100),
  referenceSkipped: z.boolean().optional(),
}).strict().refine((value) => value.referenceSkipped === true
  ? value.providerRef === undefined : value.providerRef !== undefined, {
  message: 'Enter the last 4–6 transaction ID digits, or explicitly skip under branch policy.',
});

// Signed offline rules carry permission only. QR image bytes stay out of the
// replay wire payload, keeping the existing transport size limit intact.
export const manualMerchantPoliciesSchema = z.object({
  RAAST: z.object({ allowReferenceSkip: z.boolean() }).optional(),
  JAZZCASH: z.object({ allowReferenceSkip: z.boolean() }).optional(),
  EASYPAISA: z.object({ allowReferenceSkip: z.boolean() }).optional(),
}).strict();
export function manualMerchantPolicies(settings: ManualPaymentSettings) {
  const policies: z.infer<typeof manualMerchantPoliciesSchema> = {};
  for (const type of MANUAL_TENDER_TYPES) {
    const merchant = settings[type];
    if (merchant) policies[type] = { allowReferenceSkip: merchant.allowReferenceSkip };
  }
  return policies;
}

export function validateManualTender(settings: unknown, capture: unknown) {
  return validateManualTenderPolicy(manualMerchantPolicies(manualPaymentSettingsSchema.parse(settings ?? {})), capture);
}
export function validateManualTenderPolicy(policies: unknown, capture: unknown) {
  const parsed = manualTenderCaptureSchema.parse(capture);
  const destination = manualMerchantPoliciesSchema.parse(policies ?? {})[parsed.type];
  if (!destination) throw new Error('This tender is not enabled at this branch.');
  if (parsed.referenceSkipped && !destination.allowReferenceSkip)
    throw new Error('This branch requires a transaction reference.');
  return parsed;
}

/**
 * A card payment taken on a standalone terminal and confirmed by the cashier:
 * the card's last 4 digits or the terminal reference, plus the approval code
 * printed on the terminal slip. No provider API approves it.
 */
export const MANUAL_CARD_PROVIDER = 'MANUAL_TERMINAL';
/**
 * Last 4 digits or a terminal reference (an RRN is 12 digits). An all-digit
 * value of 13 or more digits is refused: it could be a full card number, which
 * must never be stored (PCI DSS).
 */
export const MANUAL_CARD_REFERENCE = /^(?!\d{13,}$)[A-Za-z0-9]{4,24}$/;
/** The approval code printed on the terminal slip. */
export const MANUAL_CARD_APPROVAL_CODE = /^[A-Za-z0-9]{2,12}$/;
export const manualCardCaptureSchema = z.object({
  providerRef: z.string().trim().regex(MANUAL_CARD_REFERENCE),
  approvalCode: z.string().trim().regex(MANUAL_CARD_APPROVAL_CODE),
}).strict();

/** Bank statement reference, required for every new bank transfer. */
export const BANK_TRANSFER_REFERENCE_MAX_LENGTH = 120;
/** True when the text holds a 13-19 digit run (spaces and dashes ignored): a card number. */
export function looksLikeCardNumber(text: string): boolean {
  const compact = text.replace(/[\s-]+/g, '');
  const runs = compact.match(/\d{13,}/g);
  if (!runs) return false;
  // Any run of 13-19 digits is refused outright, so a Luhn-valid number at those lengths
  // is covered too. Longer runs are refused when any 13-19 digit window passes Luhn.
  return runs.some((run) => {
    if (run.length <= 19) return true;
    for (let size = 13; size <= 19; size += 1) {
      for (let at = 0; at + size <= run.length; at += 1) {
        if (passesLuhn(run.slice(at, at + size))) return true;
      }
    }
    return false;
  });
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const bankTransferCaptureSchema = z.object({
  providerRef: z.string().trim().min(1).max(BANK_TRANSFER_REFERENCE_MAX_LENGTH)
    .refine((ref) => !looksLikeCardNumber(ref)),
}).strict();

/** Keep card-number protection on all existing wire paths; bank references have their own format. */
export function hasValidTenderProviderReference(input: { type: string; providerRef?: string }) {
  if (input.providerRef === undefined) return true; // Historical attempts must remain recoverable.
  return input.type === 'BANK_TRANSFER'
    ? bankTransferCaptureSchema.safeParse({ providerRef: input.providerRef }).success
    : MANUAL_CARD_REFERENCE.test(input.providerRef);
}

const confirmerSchema = z.object({
  /** The confirming user's id; absent on reports saved before it was recorded. */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  count: z.number().int().positive().safe(),
  amountMinor: z.number().int().nonnegative().safe(),
}).strict();
export const tenderTotalsSchema = z.array(z.object({
  type: z.string().min(1),
  amountMinor: z.number().int().nonnegative().safe(),
  refundMinor: z.number().int().nonnegative().safe(),
  netMinor: z.number().int().safe(),
  /** Manually confirmed tenders (card terminal, wallets) by the person who confirmed them. */
  confirmers: z.array(confirmerSchema).optional(),
}).strict());

export function aggregateTenderTotals(
  tenders: readonly { type: string; amountMinor: number; confirmedById?: string | null }[],
  refunds: readonly { amountMinor: number; drawerSessionId: string | null; originalTender: { type: string } }[],
  confirmerNames: ReadonlyMap<string, string> = new Map()
) {
  type Confirmer = z.infer<typeof confirmerSchema>;
  const totals = new Map<string, { type: string; amountMinor: number; refundMinor: number; netMinor: number;
    confirmers?: Map<string, Confirmer> }>();
  const row = (type: string) => {
    if (!totals.has(type)) totals.set(type, { type, amountMinor: 0, refundMinor: 0, netMinor: 0 });
    return totals.get(type)!;
  };
  for (const tender of tenders) {
    const entry = row(tender.type);
    entry.amountMinor += tender.amountMinor;
    if (!tender.confirmedById) continue;
    entry.confirmers ??= new Map();
    const name = confirmerNames.get(tender.confirmedById) ?? 'Unknown user';
    const confirmer = entry.confirmers.get(tender.confirmedById) ??
      { id: tender.confirmedById, name, count: 0, amountMinor: 0 };
    confirmer.count += 1;
    confirmer.amountMinor += tender.amountMinor;
    entry.confirmers.set(tender.confirmedById, confirmer);
  }
  for (const refund of refunds)
    row(refund.drawerSessionId ? 'CASH' : refund.originalTender.type).refundMinor += refund.amountMinor;
  return tenderTotalsSchema.parse([...totals.values()].sort((a, b) => a.type.localeCompare(b.type))
    .map(({ confirmers, ...value }) => ({
      ...value,
      netMinor: value.amountMinor - value.refundMinor,
      ...(confirmers ? { confirmers: [...confirmers.values()]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id!.localeCompare(b.id!)) } : {}),
    })));
}
