import 'server-only';

import { generateText } from 'ai';
import { z } from 'zod';
import { createAIModel } from '@/lib/ai/provider';

const reviewReplyInput = z
  .object({
    rating: z.number().int().min(1).max(5),
    review: z.string().trim().min(1).max(2_000),
    tone: z.enum(['WARM', 'FORMAL']),
  })
  .strict();

export async function draftBusinessReviewReply(input: z.infer<typeof reviewReplyInput>) {
  const request = reviewReplyInput.parse(input);
  try {
    const selection = createAIModel();
    const result = await generateText({
      model: selection.model,
      providerOptions: selection.providerOptions,
      system:
        'Draft one concise Google Business Profile review reply for a pharmacy owner. Do not name or recommend any drug, salt, medicine category, treatment, diagnosis, price, discount, or private customer detail. Do not claim the reply was posted. For complaints, invite the reviewer to contact the store privately. Human review and manual posting are mandatory. Return reply text only.',
      prompt: `Rating: ${request.rating}/5\nTone: ${request.tone}\nCustomer review:\n${request.review}`,
      maxOutputTokens: 300,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const draft = z.string().trim().min(1).max(1_500).parse(result.text);
    return { available: true as const, draft, posted: false as const, approved: false as const };
  } catch {
    return {
      available: false as const,
      draft: null,
      posted: false as const,
      approved: false as const,
    };
  }
}
