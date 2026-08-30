import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requirePlatformRead } from '@/lib/platform/page-access';

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
  requirePlatformSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/platform/auth', () => ({
  requirePlatformSession: mocks.requirePlatformSession,
}));

const identity = {
  sessionId: 'session-1',
  id: 'operator-1',
  name: 'Platform Operator',
  email: 'operator@devfathom.test',
  role: 'OPERATIONS' as const,
  expiresAt: new Date('2026-09-01T00:00:00Z'),
  mfaEnabled: true,
};

describe('requirePlatformRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePlatformSession.mockResolvedValue(identity);
  });

  it('redirects a denied session to its role-safe fallback', async () => {
    await expect(requirePlatformRead('/platform/audit')).rejects.toThrow(
      'redirect:/platform/organizations'
    );

    expect(mocks.redirect).toHaveBeenCalledWith('/platform/organizations');
  });

  it('returns the authorized session without redirecting', async () => {
    await expect(requirePlatformRead('/platform/catalog')).resolves.toBe(identity);

    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
