import 'server-only';

import { z } from 'zod';
import { routeAI } from '@/lib/ai/router';
import { detectReplyLocale } from '@/lib/ai/prompt';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { validateMarketingBody } from './marketing-service';
import { containsMedicineName, readTenantMedicineNames } from './medicine-names';

// Only fixed generic choices cross the provider boundary. No free-text prompt,
// campaign content, customer identity, audience, or database rows are accepted.
export const marketingAssistanceInput = z
  .object({
    occasion: z.enum(['WELCOME', 'STORE_UPDATE', 'RETAIL_OFFER']),
    tone: z.enum(['FRIENDLY', 'FORMAL']),
  })
  .strict();

type MarketingAssistanceContext = {
  organizationId: string;
  branchId: string;
  /** Tenant-scoped database for the medicine-name check; defaults to the organization's. */
  db?: ScopedDb;
  /** The workspace's stored language preference; English when absent. */
  locale?: 'en' | 'ur';
};

export async function draftMarketingCopy(
  input: z.infer<typeof marketingAssistanceInput>,
  context: MarketingAssistanceContext
) {
  const choice = marketingAssistanceInput.parse(input);
  const locale = context.locale === 'ur' ? 'ur' : 'en';
  try {
    const result = await routeAI({
      organizationId: context.organizationId,
      branchId: context.branchId,
      feature: 'pharmacy.marketing-assistance',
      system:
        'Write one short generic retail WhatsApp draft. No medicines, clinical claims, health information, personal data, invented offers or discounts. Include Reply STOP to opt out. Human approval is required. Return text only.' +
        (locale === 'ur'
          ? ' Write the whole draft in Urdu script (Nastaliq, right-to-left); keep the opt-out as: STOP لکھ کر جواب دیں۔'
          : ' Write the draft in English.'),
      prompt: `Occasion: ${choice.occasion}. Tone: ${choice.tone}.`,
      maxOutputTokens: 250,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const body = z.string().trim().min(1).max(1000).parse(result.text);
    // Output-language check: the draft must be in the requested language.
    // The fixed opt-out sentence is excluded so it cannot tip the language heuristic.
    const substance = body
      .split(/(?<=[.!?۔؟])\s+|\n+/u)
      .filter((part) => !/STOP/i.test(part))
      .join(' ');
    if (!substance.trim() || detectReplyLocale(substance) !== locale)
      throw new Error('Draft is in the wrong language.');
    validateMarketingBody(body);
    // Customer-facing text never names a drug: reject any of this tenant's medicine,
    // brand, alias or ingredient names, not only the generic clinical words above.
    const names = await readTenantMedicineNames(
      context.db ?? createTenantDb(context.organizationId)
    );
    if (containsMedicineName(body, names)) throw new Error('Draft names a medicine.');
    return { available: true as const, body, approved: false as const };
  } catch {
    // Never expose provider errors, credentials, or fabricated fallback output.
    return { available: false as const, body: null, approved: false as const };
  }
}
