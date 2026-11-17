import { describe, expect, it } from 'vitest';

import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpAuthUri,
  verifyTotp,
  matchTotpStep,
} from './totp';

describe('platform TOTP and recovery codes', () => {
  it('verifies the RFC 6238 SHA-1 vector using six digits', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow — public RFC 6238 test vector

    expect(verifyTotp(secret, '287082', 0, 59_000)).toBe(true);
    expect(verifyTotp(secret, '287083', 0, 59_000)).toBe(false);
    expect(verifyTotp(secret, '287082', 0, 89_000)).toBe(false);
  });

  it('generates authenticator-compatible secrets and URIs', () => {
    const secret = generateTotpSecret();
    const uri = totpAuthUri('admin@example.test', secret, 'DevFathom Control');

    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=DevFathom%20Control');
  });

  it('creates unique one-time recovery codes and hashes normalized input', () => {
    const recovery = generateRecoveryCodes(10);

    expect(recovery.codes).toHaveLength(10);
    expect(new Set(recovery.codes).size).toBe(10);
    expect(recovery.hashes).toEqual(recovery.codes.map(hashRecoveryCode));
    expect(hashRecoveryCode(' ABCDE-12345 ')).toBe(hashRecoveryCode('abcde-12345'));
    expect(recovery.hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });

  it('returns the matched time step within one step either side, and null outside (DEV-879)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow — public RFC 6238 test vector
    // RFC 6238: 287082 is the code for step 1 (T = 59 s).
    expect(matchTotpStep(secret, '287082', 1, 59_000)).toBe(1);
    expect(matchTotpStep(secret, '287082', 1, 89_000)).toBe(1);
    expect(matchTotpStep(secret, '287082', 1, 30_000 * 3)).toBeNull();
    expect(matchTotpStep(secret, '287082', 0, 89_000)).toBeNull();
    expect(matchTotpStep(secret, '28708', 1, 59_000)).toBeNull();
  });
});
