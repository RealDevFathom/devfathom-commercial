import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('wallet public enrollment rate limits', () => {
  it('limits one email after five starts', async () => {
    const { admitWalletEnrollment } = await import('./enrollment-rate-limit');
    const input = { ip: 'email-ip', token: 'email-token', email: 'guest@example.test' };
    for (let count = 0; count < 5; count += 1)
      expect((await admitWalletEnrollment(input)).ok).toBe(true);
    expect(await admitWalletEnrollment(input)).toMatchObject({ ok: false, retryAfter: 900 });
  });

  it('limits one IP after thirty requests', async () => {
    const { admitWalletEnrollment } = await import('./enrollment-rate-limit');
    for (let count = 0; count < 30; count += 1) {
      expect((await admitWalletEnrollment({ ip: 'shared-ip', token: `token-${count}` })).ok).toBe(
        true
      );
    }
    expect((await admitWalletEnrollment({ ip: 'shared-ip', token: 'token-blocked' })).ok).toBe(
      false
    );
  });

  it('limits one printed token after three hundred requests', async () => {
    const { admitWalletEnrollment } = await import('./enrollment-rate-limit');
    for (let count = 0; count < 300; count += 1) {
      expect((await admitWalletEnrollment({ ip: `ip-${count}`, token: 'printed-token' })).ok).toBe(
        true
      );
    }
    expect((await admitWalletEnrollment({ ip: 'ip-blocked', token: 'printed-token' })).ok).toBe(
      false
    );
  });

  it('limits the global bucket after six hundred requests', async () => {
    const { admitWalletEnrollment } = await import('./enrollment-rate-limit');
    for (let count = 0; count < 600; count += 1) {
      expect((await admitWalletEnrollment({ ip: `ip-${count}`, token: `token-${count}` })).ok).toBe(
        true
      );
    }
    expect(
      (await admitWalletEnrollment({ ip: 'global-blocked', token: 'global-blocked' })).ok
    ).toBe(false);
  });

  it('limits an OTP attempt after five guesses', async () => {
    const { admitWalletOtpAttempt } = await import('./enrollment-rate-limit');
    for (let count = 0; count < 5; count += 1)
      expect((await admitWalletOtpAttempt('attempt')).ok).toBe(true);
    expect((await admitWalletOtpAttempt('attempt')).ok).toBe(false);
  });
});
