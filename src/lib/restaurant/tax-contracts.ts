import { z } from 'zod';

const decimalString = z.string().regex(/^\d+(?:\.\d{1,6})?$/);

export const taxRuleDraftSchema = z.object({
  ruleCode: z.string().trim().min(1).max(80),
  paymentCategory: z.string().trim().min(1).max(80),
  priceMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']),
  rate: decimalString,
  officialSourceId: z.string().trim().min(1),
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().nullable().optional(),
});

export const taxProfileDraftSchema = z.object({
  branchId: z.string().trim().min(1),
  effectiveFrom: z.iso.datetime(),
  effectiveTo: z.iso.datetime().nullable().optional(),
  rules: z.array(taxRuleDraftSchema).min(1),
});

export const taxPreviewSchema = z.object({
  profileVersionId: z.string().trim().min(1),
  occurredAt: z.iso.datetime(),
  lines: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        unitPrice: decimalString,
        quantity: z.number().int().positive(),
        modifierTotal: decimalString.optional(),
        discount: decimalString.optional(),
        paymentCategory: z.string().trim().min(1),
      })
    )
    .min(1),
});

export function validateTaxProfileDraft(input: unknown) {
  const draft = taxProfileDraftSchema.parse(input);
  const from = new Date(draft.effectiveFrom);
  if (draft.effectiveTo && new Date(draft.effectiveTo) <= from) {
    throw new Error('effectiveTo must be later than effectiveFrom');
  }
  const mappings = new Set<string>();
  for (const rule of draft.rules) {
    if (mappings.has(rule.paymentCategory))
      throw new Error(`Conflicting payment category: ${rule.paymentCategory}`);
    mappings.add(rule.paymentCategory);
    if (rule.effectiveTo && new Date(rule.effectiveTo) <= new Date(rule.effectiveFrom)) {
      throw new Error(`Invalid effective range for ${rule.ruleCode}`);
    }
  }
  return draft;
}
