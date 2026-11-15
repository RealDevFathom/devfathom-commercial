import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  shared: true,
  organization: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/host', () => ({
  resolveOrganizationByHost: mocks.organization,
  TENANT_HOST_HEADER: 'x-devfathom-host',
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: () => mocks.shared }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: vi.fn() }));
vi.mock('./login-form', () => ({ LoginForm: () => null }));
vi.mock('./shared-login-form', () => ({ SharedLoginForm: () => null }));
vi.mock('./login-hero', () => ({ LoginHero: () => null }));
import LoginPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shared = true;
  mocks.organization.mockResolvedValue(null);
  mocks.notFound.mockImplementation(() => {
    throw new Error('not-found');
  });
  mocks.headers.mockResolvedValue(new Headers());
  mocks.redirect.mockImplementation(() => {
    throw new Error('redirect');
  });
});

it('redirects a verified tenant actor to the workspace before rendering sign-in', async () => {
  mocks.actor.mockResolvedValue({ session: { user: { id: 'member' } } });
  await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect');
  expect(mocks.redirect).toHaveBeenCalledWith('/dashboard');
  expect(mocks.headers).not.toHaveBeenCalled();
});

it('renders sign-in when the workspace guard rejects the session', async () => {
  mocks.actor.mockResolvedValue(null);
  expect(await LoginPage({ searchParams: Promise.resolve({}) })).toBeTruthy();
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it.each([
  [{}, '/dashboard?landing=1'],
  [{ callbackUrl: '/dashboard' }, '/dashboard'],
  [{ callbackUrl: '/pos?station=counter' }, '/pos?station=counter'],
])(
  'passes the default landing or explicit callback through to the form: %s',
  async (params, expected) => {
    mocks.actor.mockResolvedValue(null);
    const page = await LoginPage({ searchParams: Promise.resolve(params) });
    function findCallback(node: unknown): string | undefined {
      if (!node || typeof node !== 'object') return;
      const props = (node as { props?: { callbackUrl?: string; children?: unknown } }).props;
      if (props?.callbackUrl) return props.callbackUrl;
      const children = props?.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = findCallback(child);
        if (found) return found;
      }
    }
    expect(findCallback(page)).toBe(expected);
  }
);

it('renders a 404 for an unresolved tenant instead of a misleading sign-in form', async () => {
  mocks.actor.mockResolvedValue(null);
  mocks.shared = false;
  mocks.headers.mockResolvedValue(new Headers({ 'x-devfathom-host': 'typo.localhost' }));
  await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('not-found');
  expect(mocks.organization).toHaveBeenCalledWith('typo.localhost');
});

it('does not turn a tenant lookup outage into a missing-workspace response', async () => {
  mocks.actor.mockResolvedValue(null);
  mocks.shared = false;
  mocks.organization.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    'database unavailable'
  );
  expect(mocks.notFound).not.toHaveBeenCalled();
});

it('keeps a recognized tenant on its sign-in flow', async () => {
  mocks.actor.mockResolvedValue(null);
  mocks.shared = false;
  mocks.organization.mockResolvedValue({ id: 'tenant', vertical: 'PHARMACY' });
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  vi.mocked(withTenantDb).mockResolvedValueOnce({ connections: [], enforced: false });
  expect(await LoginPage({ searchParams: Promise.resolve({}) })).toBeTruthy();
  expect(mocks.notFound).not.toHaveBeenCalled();
});
