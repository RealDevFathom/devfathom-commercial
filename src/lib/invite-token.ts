import { randomBytes, createHash } from 'crypto';

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
