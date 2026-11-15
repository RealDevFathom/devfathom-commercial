import 'server-only';

import { z } from 'zod';
import { routeAI } from '@/lib/ai/router';
import { createTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  greetReviewer,
  isSafeReviewReply,
  reviewReplyInput,
  reviewSentiment,
  templateReviewReply,
} from './business-profile-health';
import { containsMedicineName, readTenantMedicineNames } from './medicine-names';

type ReviewReplyContext = {
  organizationId: string;
  branchId: string;
  /** Whether tenant AI settings allow a provider call. */
  aiEnabled: boolean;
  db?: ScopedDb;
};

/**
 * Drafts a Google review reply for the owner to copy and post manually. There
 * is no posting path: the result is always unapproved and unposted. Only the
 * rating band and tone cross the provider boundary; review text, reviewer
 * identity and database rows never do.
 */
export async function draftReviewReply(
  input: z.infer<typeof reviewReplyInput>,
  context: ReviewReplyContext
) {
  const choice = reviewReplyInput.parse(input);
  const names = await readTenantMedicineNames(context.db ?? createTenantDb(context.organizationId));
  const safe = (body: string) => isSafeReviewReply(body) && !containsMedicineName(body, names);
  const firstName =
    choice.reviewerFirstName && safe(choice.reviewerFirstName)
      ? choice.reviewerFirstName
      : undefined;
  const finish = (body: string, source: 'AI' | 'TEMPLATE') => ({
    body: greetReviewer(body, choice.tone, firstName),
    source,
    approved: false as const,
    posted: false as const,
  });
  if (context.aiEnabled) {
    try {
      const result = await routeAI({
        organizationId: context.organizationId,
        branchId: context.branchId,
        feature: 'pharmacy.review-reply',
        system:
          'Write one short public reply from a retail pharmacy to a Google review. No greeting or name. Never confirm the reviewer is a customer or patient, never mention medicines, prescriptions, health, symptoms or treatment, never promise refunds or discounts. For mixed or negative reviews apologise briefly and invite them to contact the branch manager. Return text only.',
        prompt: `Review sentiment: ${reviewSentiment(choice.rating)}. Tone: ${choice.tone}.`,
        maxOutputTokens: 200,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15_000),
      });
      const body = z.string().trim().min(1).max(600).parse(result.text);
      if (safe(body)) return finish(body, 'AI');
    } catch {
      // Provider errors are never exposed; the reviewed template below is used.
    }
  }
  return finish(templateReviewReply(choice), 'TEMPLATE');
}
