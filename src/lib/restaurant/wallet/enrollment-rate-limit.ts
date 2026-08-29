import { createHash } from 'node:crypto';

import { rateLimit, type RateLimitResult } from '@/lib/rate-limit';

const TEN_MINUTES = 10 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;

export type WalletEnrollmentAdmission = { ok: true } | { ok: false; retryAfter: number };

export function enrollmentFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function admitWalletEnrollment(input: {
  ip: string;
  token: string;
  email?: string;
}): WalletEnrollmentAdmission {
  const gates: RateLimitResult[] = [
    rateLimit('wallet-enroll:global', 600, 60_000),
    rateLimit(`wallet-enroll:ip:${input.ip}`, 30, TEN_MINUTES),
    rateLimit(`wallet-enroll:token:${enrollmentFingerprint(input.token)}`, 300, TEN_MINUTES),
  ];
  if (input.email) {
    gates.push(
      rateLimit(`wallet-enroll:email:${enrollmentFingerprint(input.email)}`, 5, FIFTEEN_MINUTES)
    );
  }
  const blocked = gates.find((gate) => !gate.ok);
  return blocked ? { ok: false, retryAfter: blocked.retryAfter } : { ok: true };
}

export function admitWalletOtpAttempt(attemptId: string): WalletEnrollmentAdmission {
  const gate = rateLimit(`wallet-otp:attempt:${attemptId}`, 5, 10 * 60_000);
  return gate.ok ? { ok: true } : { ok: false, retryAfter: gate.retryAfter };
}
