import { describe, expect, it } from 'vitest';

import {
  BADGE_MIN_LENGTH,
  CredentialPolicyError,
  LOCKOUT_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  assertOperatorSecretPolicy,
  clearLockout,
  hashOperatorCredential,
  isLockedOut,
  isValidBadgeFormat,
  isValidPinFormat,
  normalizeOperatorSecret,
  registerFailedAttempt,
  remainingLockoutMs,
  verifyOperatorCredential,
  type LockoutState,
} from './operator-credentials';

describe('PIN policy floor (D11: 4–8 digits)', () => {
  it('accepts 4–8 digit numeric PINs', () => {
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('12345678')).toBe(true);
    expect(PIN_MIN_LENGTH).toBe(4);
    expect(PIN_MAX_LENGTH).toBe(8);
  });

  it('rejects too-short, too-long, and non-numeric PINs', () => {
    expect(isValidPinFormat('123')).toBe(false);
    expect(isValidPinFormat('123456789')).toBe(false);
    expect(isValidPinFormat('12a4')).toBe(false);
    expect(isValidPinFormat('12 4')).toBe(false);
    expect(isValidPinFormat('')).toBe(false);
  });

  it('assertOperatorSecretPolicy throws a CredentialPolicyError for a bad PIN', () => {
    expect(() => assertOperatorSecretPolicy('PIN', '12')).toThrow(CredentialPolicyError);
    expect(() => assertOperatorSecretPolicy('PIN', '1234')).not.toThrow();
  });
});

describe('badge policy floor', () => {
  it('accepts badges at or above the minimum length once trimmed', () => {
    expect(isValidBadgeFormat('ABCD1234')).toBe(true);
    expect(BADGE_MIN_LENGTH).toBe(8);
  });

  it('rejects badges below the minimum length', () => {
    expect(isValidBadgeFormat('short')).toBe(false);
    expect(() => assertOperatorSecretPolicy('BADGE', 'short')).toThrow(CredentialPolicyError);
  });

  it('trims surrounding whitespace before measuring a badge', () => {
    expect(normalizeOperatorSecret('BADGE', '  ABCD1234\n')).toBe('ABCD1234');
    expect(normalizeOperatorSecret('PIN', '1234')).toBe('1234');
  });
});

// Each round trip performs three real production-cost bcrypt operations.
describe('hash / verify', { timeout: 20_000 }, () => {
  it('round-trips a PIN and rejects the wrong PIN', async () => {
    const hash = await hashOperatorCredential('PIN', '4821');
    expect(hash).not.toContain('4821');
    expect(await verifyOperatorCredential('PIN', '4821', hash)).toBe(true);
    expect(await verifyOperatorCredential('PIN', '4822', hash)).toBe(false);
  });

  it('round-trips a badge regardless of scanner whitespace', async () => {
    const hash = await hashOperatorCredential('BADGE', 'BADGE-SECRET-01');
    expect(await verifyOperatorCredential('BADGE', '  BADGE-SECRET-01\n', hash)).toBe(true);
    expect(await verifyOperatorCredential('BADGE', 'BADGE-SECRET-02', hash)).toBe(false);
  });

  it('refuses to hash a secret that violates policy', async () => {
    await expect(hashOperatorCredential('PIN', '12')).rejects.toBeInstanceOf(CredentialPolicyError);
  });

  it('fails closed (false, not throw) on a malformed stored hash', async () => {
    expect(await verifyOperatorCredential('PIN', '1234', 'not-a-bcrypt-hash')).toBe(false);
  });
});

describe('lockout policy primitives (D11: 5 failures → 15 min)', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');
  const fresh: LockoutState = { failedAttempts: 0, lockedUntil: null };

  it('locks on the fifth consecutive failure and resets the strike counter', () => {
    let state = fresh;
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      state = registerFailedAttempt(state, now);
      expect(state.lockedUntil).toBeNull();
      expect(state.failedAttempts).toBe(i);
      expect(isLockedOut(state, now)).toBe(false);
    }
    state = registerFailedAttempt(state, now);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).toEqual(new Date(now.getTime() + LOCKOUT_DURATION_MS));
    expect(isLockedOut(state, now)).toBe(true);
    expect(remainingLockoutMs(state, now)).toBe(LOCKOUT_DURATION_MS);
  });

  it('treats a lock as expired once server time passes it', () => {
    const locked: LockoutState = {
      failedAttempts: 0,
      lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS),
    };
    const later = new Date(now.getTime() + LOCKOUT_DURATION_MS + 1);
    expect(isLockedOut(locked, later)).toBe(false);
    expect(remainingLockoutMs(locked, later)).toBe(0);
  });

  it('clearLockout wipes strikes and the lock on success', () => {
    expect(clearLockout()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});
