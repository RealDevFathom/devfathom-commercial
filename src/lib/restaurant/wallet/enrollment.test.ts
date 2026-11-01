import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const randomIntSpy = vi.hoisted(() => vi.fn());
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  randomIntSpy.mockImplementation((min: number, max: number) => actual.randomInt(min, max));
  return { ...actual, default: actual, randomInt: randomIntSpy };
});

import {
  ENROLLMENT_TOKEN_PATTERN,
  generateEnrollmentOtp,
  hashEnrollmentToken,
  mintEnrollmentLink,
} from './enrollment';

describe('wallet enrollment QR identity', () => {
  it('mints an opaque 128-bit token URL with no database primary key', () => {
    const link = mintEnrollmentLink('https://acme.example.test');
    expect(link.token).toMatch(ENROLLMENT_TOKEN_PATTERN);
    expect(link.url).toBe(`https://acme.example.test/wallet/join/${link.token}`);
    expect(link.url).not.toContain('branch_');
    expect(link.tokenHash).toBe(hashEnrollmentToken(link.token));
    expect(link.tokenHash).not.toContain(link.token);
  });

  it('keeps enrollment and member barcode envelopes distinct', () => {
    expect(ENROLLMENT_TOKEN_PATTERN.test('DFW1:wla_0123456789abcdefghjkmnpq')).toBe(false);
    expect(ENROLLMENT_TOKEN_PATTERN.test('wla_0123456789abcdefghjkmnpq')).toBe(false);
  });
});

describe('wallet enrollment OTP', () => {
  it('draws a uniform six-digit code from randomInt', () => {
    randomIntSpy.mockClear();
    const otp = generateEnrollmentOtp();
    expect(otp).toMatch(/^\d{6}$/);
    expect(randomIntSpy).toHaveBeenCalledWith(0, 1_000_000);
  });

  it('zero-pads small values to six digits', () => {
    randomIntSpy.mockReturnValueOnce(42);
    expect(generateEnrollmentOtp()).toBe('000042');
  });
});
