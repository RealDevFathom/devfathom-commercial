import 'server-only';

import { compare, hash } from 'bcryptjs';

/**
 * M2-L1 / C4 — operator credential primitives (hash/verify, PIN & badge policy
 * floor, durable lockout policy).
 *
 * These are pure, side-effect-free primitives shared by the L2 back-office and
 * L3 terminal paths. They deliberately know nothing about `User`, NextAuth, or
 * the web-login stack (C2 — operator credentials are structurally unreachable
 * from web login): they take a plaintext secret and produce/verify a hash, and
 * they compute the next lockout state from the current counters. Persistence of
 * the hash and the durable `failedAttempts`/`lockedUntil` counters (C4 — the
 * counters live on the credential row, never in a per-instance cache) is the
 * caller's responsibility, on a mutation that runs with `skipInput: true` so the
 * plaintext secret is never captured in the audit log.
 *
 * The concrete numbers are the D11 conservative default recorded in
 * industry-specific-docs/restaurants/BUILD-ASSUMPTIONS.md. No WebAuthn/biometric
 * kind exists (C4 — deferred).
 */

export type OperatorCredentialType = 'PIN' | 'BADGE';

// --- Policy floor (D11 conservative default) ------------------------------

/** PIN is 4–8 digits, numeric only. */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
/** A badge secret is a higher-entropy scanned/tapped token; floor its length. */
export const BADGE_MIN_LENGTH = 8;
export const BADGE_MAX_LENGTH = 256;

/** D11: five consecutive failures lock the credential for fifteen minutes. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * bcrypt cost factor. Matches the cost the platform already uses for user and
 * seed passwords (see prisma/seed.ts), so operator credentials are hashed at the
 * same work factor rather than introducing a weaker one. A slow salted hash is
 * the right primitive for a low-entropy PIN; the lockout counters are the second
 * line of defence.
 */
export const OPERATOR_CREDENTIAL_BCRYPT_COST = 12;

const PIN_PATTERN = /^\d+$/;

/**
 * Normalise a raw secret before hashing or verifying. Normalisation MUST be
 * identical on both paths or a freshly-hashed credential would fail to verify.
 * Badge scanners commonly append surrounding whitespace/newlines, so a badge is
 * trimmed; a PIN is taken exactly as entered (its charset is validated
 * separately).
 */
export function normalizeOperatorSecret(type: OperatorCredentialType, secret: string): string {
  return type === 'BADGE' ? secret.trim() : secret;
}

export function isValidPinFormat(pin: string): boolean {
  return pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH && PIN_PATTERN.test(pin);
}

export function isValidBadgeFormat(badge: string): boolean {
  const normalized = normalizeOperatorSecret('BADGE', badge);
  return normalized.length >= BADGE_MIN_LENGTH && normalized.length <= BADGE_MAX_LENGTH;
}

/**
 * Assert that a raw secret meets the policy floor for its type. Throws a
 * `CredentialPolicyError` on violation so a caller can translate it into a
 * user-facing validation error without leaking the secret.
 */
export class CredentialPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialPolicyError';
  }
}

export function assertOperatorSecretPolicy(type: OperatorCredentialType, secret: string): void {
  if (type === 'PIN') {
    if (!isValidPinFormat(secret)) {
      throw new CredentialPolicyError(`A PIN must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits.`);
    }
    return;
  }
  if (!isValidBadgeFormat(secret)) {
    throw new CredentialPolicyError(
      `A badge secret must be at least ${BADGE_MIN_LENGTH} characters.`
    );
  }
}

// --- Hash / verify --------------------------------------------------------

/**
 * Hash a raw operator secret for storage in `credentialHash`. Asserts the policy
 * floor first, so a credential that violates policy is never persisted. Returns
 * only the hash — the caller must never store the plaintext (C4).
 */
export async function hashOperatorCredential(
  type: OperatorCredentialType,
  secret: string
): Promise<string> {
  assertOperatorSecretPolicy(type, secret);
  return hash(normalizeOperatorSecret(type, secret), OPERATOR_CREDENTIAL_BCRYPT_COST);
}

/**
 * Verify a raw operator secret against a stored hash. Always performs a bcrypt
 * comparison (constant-time in the byte comparison) and never throws for a
 * mismatch — it returns false — so callers can run it against a dummy hash to
 * keep the timing of "no such credential" indistinguishable from "wrong secret".
 */
export async function verifyOperatorCredential(
  type: OperatorCredentialType,
  secret: string,
  credentialHash: string
): Promise<boolean> {
  try {
    return await compare(normalizeOperatorSecret(type, secret), credentialHash);
  } catch {
    // A malformed stored hash must fail closed, not throw.
    return false;
  }
}

// --- Lockout policy primitives (C4) ---------------------------------------

/**
 * The durable lockout counters as they live on the credential row. `now` is
 * always a SERVER timestamp — client time is untrusted (C5).
 */
export type LockoutState = {
  failedAttempts: number;
  lockedUntil: Date | null;
};

/** True when the credential is currently locked (a lock exists and is in the future). */
export function isLockedOut(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Milliseconds until an active lock expires, or 0 when not locked. */
export function remainingLockoutMs(state: LockoutState, now: Date): number {
  if (!isLockedOut(state, now)) return 0;
  return state.lockedUntil!.getTime() - now.getTime();
}

/**
 * Compute the next counter state after a FAILED verification. On the
 * `MAX_FAILED_ATTEMPTS`-th failure the credential is locked for
 * `LOCKOUT_DURATION_MS` and the strike counter is reset (the lockout has
 * consumed the strikes); after the lock expires the operator gets a fresh set of
 * attempts. Returns the values the caller must persist on the row.
 */
export function registerFailedAttempt(state: LockoutState, now: Date): LockoutState {
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS) };
  }
  return { failedAttempts, lockedUntil: null };
}

/** The counter state after a SUCCESSFUL verification — strikes and lock cleared. */
export function clearLockout(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
