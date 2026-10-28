import { createHash, timingSafeEqual } from 'node:crypto';

import { encryptSecret } from '@/lib/secret-crypto';

/** Lookup key for a per-instance webhook secret. The plaintext is not stored. */
export function webhookSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function sealWebhookSecret(secret: string): {
  waWebhookSecretEnc: string;
  waWebhookSecretHash: string;
} {
  return {
    waWebhookSecretEnc: encryptSecret(secret),
    waWebhookSecretHash: webhookSecretHash(secret),
  };
}

/** Compares the presented secret with the stored hash in constant time. */
export function webhookSecretMatches(provided: string, storedHash: string): boolean {
  const computed = createHash('sha256').update(provided).digest();
  const stored = Buffer.from(storedHash, 'hex');
  return stored.length === computed.length && timingSafeEqual(stored, computed);
}
