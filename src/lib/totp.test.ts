import { describe, expect, it } from 'vitest';

import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  totpAuthUri,
  verifyTotp,
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
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.hostname).toBe('totp');
    expect(decodeURIComponent(parsed.pathname)).toBe('/DevFathom Control:admin@example.test');
    expect(parsed.searchParams.get('secret')).toBe(secret);
    expect(parsed.searchParams.get('issuer')).toBe('DevFathom Control');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });

  it('creates unique one-time recovery codes and hashes normalized input', () => {
    const recovery = generateRecoveryCodes(10);

    expect(recovery.codes).toHaveLength(10);
    expect(new Set(recovery.codes).size).toBe(10);
    expect(recovery.hashes).toEqual(recovery.codes.map(hashRecoveryCode));
    expect(hashRecoveryCode(' ABCDE-12345 ')).toBe(hashRecoveryCode('abcde-12345'));
    expect(recovery.hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });
});
