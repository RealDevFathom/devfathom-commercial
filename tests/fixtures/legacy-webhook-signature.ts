import type { RestaurantWebhookVerificationStatus } from '@/generated/prisma/client';

/** Historical M7 fixture for inbox rows created by the retired signature stub. */
export function verifyWebhookSignatureStub(input: {
  source: string;
  signature: string | null;
}): RestaurantWebhookVerificationStatus {
  return input.signature != null && input.signature.trim().length > 0 ? 'VERIFIED' : 'PENDING';
}
