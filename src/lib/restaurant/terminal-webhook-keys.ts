import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RestaurantTerminalProviderConfig } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto';

export type SigningConfig = Pick<
  RestaurantTerminalProviderConfig,
  | 'id'
  | 'encryptedSigningSecret'
  | 'previousEncryptedSigningSecret'
  | 'previousSigningSecretExpiresAt'
  | 'legacySigningCutoff'
>;

export function freshTerminalTimestamp(
  timestamp: string | null,
  now = Date.now()
): timestamp is string {
  return (
    timestamp !== null &&
    /^\d{10}$/.test(timestamp) &&
    Math.abs(now - Number(timestamp) * 1000) <= 5 * 60_000
  );
}

export function verifyProviderSignature(
  config: SigningConfig,
  source: string,
  rawBody: string | Uint8Array,
  signature: string | null,
  timestamp: string | null,
  now = Date.now()
): 'SCOPED' | 'LEGACY' | 'FAILED' {
  if (!signature || !freshTerminalTimestamp(timestamp, now)) return 'FAILED';
  const hex = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-f]{64}$/i.test(hex)) return 'FAILED';
  const digest = Buffer.from(hex, 'hex');
  const matches = (secret: string, prefix: string) =>
    timingSafeEqual(createHmac('sha256', secret).update(prefix).update(rawBody).digest(), digest);

  if (config.encryptedSigningSecret !== null) {
    // The configuration id is globally unique. JSON framing keeps the source and
    // configuration unambiguous even if a provider slug contains punctuation.
    const prefix = JSON.stringify([timestamp, source, config.id]) + '.';
    if (matches(decryptSecret(config.encryptedSigningSecret), prefix)) return 'SCOPED';
    if (
      config.previousEncryptedSigningSecret &&
      config.previousSigningSecretExpiresAt &&
      now < config.previousSigningSecretExpiresAt.getTime() &&
      matches(decryptSecret(config.previousEncryptedSigningSecret), prefix)
    )
      return 'SCOPED';
    return 'FAILED';
  }

  const legacy = process.env.RESTAURANT_TERMINAL_WEBHOOK_SECRET;
  return legacy &&
    now < config.legacySigningCutoff.getTime() &&
    matches(legacy, `${timestamp}.${source}.`)
    ? 'LEGACY'
    : 'FAILED';
}

export async function rotateTerminalWebhookKey(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  configId: string
) {
  const secret = randomBytes(32).toString('base64url');
  // A single UPDATE serializes concurrent rotations and moves the actual
  // last committed ciphertext into the overlap slot.
  const updated = await db.$executeRaw`
    UPDATE restaurant_terminal_provider_configs
    SET "previousEncryptedSigningSecret" = "encryptedSigningSecret",
        "previousSigningSecretExpiresAt" = CASE WHEN "encryptedSigningSecret" IS NOT NULL
          THEN clock_timestamp() + interval '24 hours' END,
        "encryptedSigningSecret" = ${encryptSecret(secret)}, "updatedAt" = clock_timestamp()
    WHERE "organizationId" = ${organizationId} AND "branchId" = ${branchId}
      AND id = ${configId}
  `;
  return updated === 1 ? { configId, secret } : null;
}
