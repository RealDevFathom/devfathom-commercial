import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  rateLimit: vi.fn(),
  clearRateLimit: vi.fn(),
  findUser: vi.fn(),
  createSession: vi.fn(),
  updateUser: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ compare: mocks.compare }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '203.0.113.8',
  rateLimit: mocks.rateLimit,
  clearRateLimit: mocks.clearRateLimit,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: (run: (db: unknown) => unknown) =>
    run({
      platformUser: { findUnique: mocks.findUser, update: mocks.updateUser },
      platformSession: { create: mocks.createSession },
      platformAuditLog: { create: mocks.createAuditLog },
    }),
}));

import { createPlatformSession } from '@/lib/platform/auth';

const request = new Request('http://admin.localhost/api/platform/session');
const user = {
  id: 'platform-user-1',
  name: 'Platform Admin',
  email: 'admin@example.com',
  passwordHash: 'password-hash',
  role: 'SUPER_ADMIN',
  active: true,
  mfaRequired: false,
  encryptedTotpSecret: null,
  mfaEnabledAt: null,
};

describe('platform login rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfter: 0, remaining: 7 });
    mocks.findUser.mockResolvedValue(user);
    mocks.createSession.mockResolvedValue({ id: 'session-1' });
    mocks.updateUser.mockResolvedValue(user);
    mocks.createAuditLog.mockResolvedValue({ id: 'audit-1' });
  });

  it('clears the credential bucket after successful authentication', async () => {
    mocks.compare.mockResolvedValue(true);

    await createPlatformSession(' Admin@Example.com ', 'valid-password', undefined, request);

    expect(mocks.rateLimit).toHaveBeenCalledWith(
      'platform-login:203.0.113.8:admin@example.com',
      8,
      15 * 60_000
    );
    expect(mocks.clearRateLimit).toHaveBeenCalledWith(
      'platform-login:203.0.113.8:admin@example.com'
    );
  });

  it('retains the credential bucket after failed authentication', async () => {
    mocks.compare.mockResolvedValue(false);

    await expect(
      createPlatformSession('admin@example.com', 'wrong-password', undefined, request)
    ).rejects.toMatchObject({ status: 401 });

    expect(mocks.clearRateLimit).not.toHaveBeenCalled();
  });

  it('rejects a blocked credential bucket before password verification', async () => {
    mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 60, remaining: 0 });

    await expect(
      createPlatformSession('admin@example.com', 'valid-password', undefined, request)
    ).rejects.toMatchObject({ status: 429 });

    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.clearRateLimit).not.toHaveBeenCalled();
  });
});
