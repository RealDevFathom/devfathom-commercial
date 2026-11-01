import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPlatformSession: vi.fn(),
}));

vi.mock('@/lib/platform/auth', () => ({
  getPlatformSession: mocks.getPlatformSession,
}));

import { proxy } from '@/proxy';

const operationsIdentity = {
  sessionId: 'session-1',
  id: 'operator-1',
  name: 'E2E Platform Operator',
  email: 'platform-operator@e2e.invalid',
  role: 'OPERATIONS' as const,
  expiresAt: new Date('2026-09-02T00:00:00Z'),
  mfaEnabled: false,
};

function platformRequest(pathname: string, headers?: HeadersInit) {
  return new Request(`http://admin.localhost:4319${pathname}`, {
    headers: {
      cookie: 'df_platform_session=opaque-platform-token',
      host: 'admin.localhost:4319',
      ...headers,
    },
  });
}

describe('platform proxy authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlatformSession.mockResolvedValue(operationsIdentity);
  });

  it.each([
    ['document', undefined],
    ['RSC', { RSC: '1', 'Next-Router-Prefetch': '1' }],
  ])('redirects a denied %s request before rendering a response body', async (_, headers) => {
    const response = await proxy(platformRequest('/platform', headers));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://admin.localhost:4319/platform/organizations'
    );
    expect(await response.text()).toBe('');
  });

  it('passes a granted route after revalidating the platform session', async () => {
    const request = platformRequest('/platform/organizations/org-1');
    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(mocks.getPlatformSession).toHaveBeenCalledWith(request);
  });

  it('redirects an authenticated operator away from the platform login page', async () => {
    const request = platformRequest('/platform/login');
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://admin.localhost:4319/platform');
    expect(mocks.getPlatformSession).toHaveBeenCalledWith(request);
  });

  it('keeps the authenticated redirect fixed when the login URL has a callback', async () => {
    const request = platformRequest('/platform/login?callbackUrl=https://attacker.invalid');
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://admin.localhost:4319/platform');
    expect(mocks.getPlatformSession).toHaveBeenCalledWith(request);
  });

  it('renders login after the server verifier rejects a missing session', async () => {
    mocks.getPlatformSession.mockResolvedValueOnce(null);
    const request = platformRequest('/platform/login', { cookie: '' });
    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.getPlatformSession).toHaveBeenCalledWith(request);
  });

  it.each([
    ['forged', 'forged-platform-session-token-that-is-long-enough'],
    ['expired', 'expired-platform-session-token-that-is-long-enough'],
  ])('renders the platform login page when its session cookie is %s', async (_, token) => {
    mocks.getPlatformSession.mockResolvedValueOnce(null);
    const request = platformRequest('/platform/login', {
      cookie: `df_platform_session=${token}`,
    });
    const response = await proxy(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.getPlatformSession).toHaveBeenCalledWith(request);
  });
});

describe('private upload paths', () => {
  const paths = [
    '/uploads',
    '/uploads/',
    '/uploads/org-a/file.png',
    '/private-uploads',
    '/private-uploads/org-a/file.pdf',
    '/%75ploads/file.png',
    '/%70rivate%2duploads/file.pdf',
    '/uploads%2ffile.png',
    '/private-uploads%5cfile.pdf',
    '/%2575ploads%252ffile.png',
    '/%2570rivate-uploads/file.pdf',
    '/safe%2f..%2fuploads/file.png',
    '/safe%255c..%255cprivate-uploads/file.pdf',
    '/%2fuploads/file.png',
    '/UPLOADS/file.png',
    '/uploads/%broken.png',
    '/%75ploads%2ffile%ZZ.png',
  ];
  it.each(paths)('returns 404 for %s on every host and session', async (path) => {
    for (const host of ['tenant.localhost', 'admin.localhost']) {
      for (const cookie of ['', 'authjs.session-token=tenant; df_platform_session=operator']) {
        for (const method of ['GET', 'HEAD', 'POST']) {
          const response = await proxy(
            new Request(`http://${host}${path}`, {
              method,
              headers: { host, cookie },
            })
          );
          expect(response.status).toBe(404);
          expect(response.headers.get('location')).toBeNull();
          expect(response.headers.get('x-middleware-next')).toBeNull();
          expect(await response.text()).toBe('');
        }
      }
    }
  });

  it.each(['/api/files/file.png', '/brand/logo.png', '/uploads-guide.png'])(
    'preserves authorized API routing and unrelated public assets: %s',
    async (path) => {
      const response = await proxy(new Request(`http://tenant.localhost${path}`));
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  );
});
