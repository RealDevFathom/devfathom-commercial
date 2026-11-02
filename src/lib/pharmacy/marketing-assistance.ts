import 'server-only';

import { z } from 'zod';
import { routeAI } from '@/lib/ai/router';
import { validateMarketingBody } from './marketing-service';

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
};

export async function draftMarketingCopy(
  input: z.infer<typeof marketingAssistanceInput>,
  context: MarketingAssistanceContext
) {
  const choice = marketingAssistanceInput.parse(input);
  try {
    const result = await routeAI({
      organizationId: context.organizationId,
      branchId: context.branchId,
      feature: 'pharmacy.marketing-assistance',
      system:
        'Write one short generic retail WhatsApp draft. No medicines, clinical claims, health information, personal data, invented offers or discounts. Include Reply STOP to opt out. Human approval is required. Return text only.',
      prompt: `Occasion: ${choice.occasion}. Tone: ${choice.tone}.`,
      maxOutputTokens: 250,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const body = z.string().trim().min(1).max(1000).parse(result.text);
    validateMarketingBody(body);
    return { available: true as const, body, approved: false as const };
  } catch {
    // Never expose provider errors, credentials, or fabricated fallback output.
    return { available: false as const, body: null, approved: false as const };
  }
}
