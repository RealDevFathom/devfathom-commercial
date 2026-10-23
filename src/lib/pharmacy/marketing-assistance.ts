import 'server-only';

import { generateText } from 'ai';
import { z } from 'zod';
import { createAIModel } from '@/lib/ai/provider';
import { validateMarketingBody } from './marketing-service';

// Only fixed generic choices cross the provider boundary. No free-text prompt,
// campaign content, customer identity, audience, or database rows are accepted.
export const marketingAssistanceInput = z
  .object({
    occasion: z.enum(['WELCOME', 'STORE_UPDATE', 'RETAIL_OFFER']),
    tone: z.enum(['FRIENDLY', 'FORMAL']),
  })
  .strict();

export type MarketingCopyGeneration = {
  available: true;
  body: string;
  approved: false;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export async function draftMarketingCopy(
  input: z.infer<typeof marketingAssistanceInput>
): Promise<MarketingCopyGeneration | { available: false; body: null; approved: false }> {
  const choice = marketingAssistanceInput.parse(input);
  try {
    const selection = createAIModel();
    const result = await generateText({
      model: selection.model,
      providerOptions: selection.providerOptions,
      system:
        'Write one short generic retail WhatsApp draft. No medicines, clinical claims, health information, personal data, invented offers or discounts. Include Reply STOP to opt out. Human approval is required. Return text only.',
      prompt: `Occasion: ${choice.occasion}. Tone: ${choice.tone}.`,
      maxOutputTokens: 250,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const body = z.string().trim().min(1).max(1000).parse(result.text);
    validateMarketingBody(body);
    return {
      available: true as const,
      body,
      approved: false as const,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
      },
    };
  } catch {
    // Never expose provider errors, credentials, or fabricated fallback output.
    return { available: false as const, body: null, approved: false as const };
  }
}
