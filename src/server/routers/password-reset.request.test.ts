import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  createToken: vi.fn(),
  rateLimit: vi.fn(),
  passwordReset: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit }));
vi.mock('@/lib/email', async () => ({
  appUrl: (await import('@/lib/email/theme')).appUrl,
  templates: { passwordReset: mocks.passwordReset },
  sendEmail: mocks.sendEmail,
}));

import { appUrl } from '@/lib/email/theme';
import type { TRPCContext } from '../trpc';
import { passwordResetRouter } from './password-reset';

const activeUser = {
  id: 'user_1',
  name: 'Alex Carter',
  email: 'alex@example.test',
  status: 'ACTIVE',
  password: 'stored-password-hash',
};

function caller() {
  return passwordResetRouter.createCaller({
    db: {
      user: { findFirst: mocks.findFirst },
      passwordResetToken: { create: mocks.createToken },
    },
    session: null,
    organization: { id: 'org_test', isDemo: false },
    requestMeta: { ip: '203.0.113.9', userAgent: null },
  } as unknown as TRPCContext);
}

describe('passwordReset.request account-enumeration protection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
    mocks.findFirst.mockResolvedValue(activeUser);
    mocks.createToken.mockResolvedValue({});
    mocks.rateLimit.mockResolvedValue({ ok: true });
    mocks.passwordReset.mockReturnValue({ subject: 'Reset password', html: 'html', text: 'text' });
    mocks.sendEmail.mockResolvedValue({ messageId: 'message_1' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function expectSameSuccess() {
    mocks.findFirst.mockResolvedValueOnce(activeUser).mockResolvedValueOnce(null);
    const existing = await caller().request({ email: activeUser.email });
    const unknown = await caller().request({ email: 'unknown@example.test' });

    expect(existing).toEqual({ success: true });
    expect(unknown).toEqual(existing);
    expect(mocks.createToken).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(4);
  }

  it.each(['http://app.example.test', 'not-a-url', 'javascript:alert(1)'])(
    'returns identical success for existing and unknown accounts with rejected URL %s',
    async (url) => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', url);
      expect(() => appUrl()).toThrow();

      await expectSameSuccess();

      expect(mocks.passwordReset).not.toHaveBeenCalled();
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledOnce();
    }
  );

  it('returns identical success when email rendering fails', async () => {
    mocks.passwordReset.mockImplementation(() => {
      throw new Error('Email rendering failed');
    });

    await expectSameSuccess();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('returns identical success when email delivery fails', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('Provider unavailable'));

    await expectSameSuccess();

    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('still sends a reset link with a valid public URL', async () => {
    await expect(caller().request({ email: activeUser.email })).resolves.toEqual({ success: true });

    expect(mocks.passwordReset).toHaveBeenCalledWith({
      name: activeUser.name,
      resetUrl: expect.stringMatching(/^https:\/\/app\.example\.test\/reset-password\/.+/),
      expiresLabel: 'in 1 hour',
    });
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: { email: activeUser.email, name: activeUser.name },
      subject: 'Reset password',
      html: 'html',
      text: 'text',
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});
