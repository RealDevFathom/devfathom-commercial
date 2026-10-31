import { randomBytes, createHash, createHmac } from 'crypto';

// Invitation tokens. The raw token travels in the emailed accept link; only its
// SHA-256 hash is persisted (Invitation.tokenHash). SHA-256 (not bcrypt) so the
// hash is deterministic and we can look an invitation up by it in one query —
// the token is high-entropy (256 bits), so a fast hash is appropriate here.

/** Deterministic hash of a raw invite token, for storage and lookup. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint a new invite token: the raw value to email, and the hash to store. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

/**
 * Derive a stable, unguessable token for a retryable invitation request.
 *
 * The caller-provided key only identifies a logical request; the HMAC keeps the
 * resulting bearer token secret even when that key is visible to the caller.
 */
export function generateIdempotentInviteToken(
  organizationId: string,
  idempotencyKey: string
): { token: string; tokenHash: string } {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error('AUTH_SECRET is required to issue invitations.');
  const token = createHmac('sha256', secret)
    .update(`restaurant-staff-invite\0${organizationId}\0${idempotencyKey}`)
    .digest('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}
