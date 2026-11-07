import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  resolve: vi.fn(),
  unknown: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/host', () => ({
  resolveOrganizationByHost: mocks.resolve,
  TENANT_HOST_HEADER: 'x-devfathom-host',
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: () => false }));
vi.mock('@/lib/tenancy/unknown-tenant-host', () => ({ isUnknownTenantHost: mocks.unknown }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: vi.fn() }));
vi.mock('./login-form', () => ({ LoginForm: () => null }));
vi.mock('./shared-login-form', () => ({ SharedLoginForm: () => null }));
vi.mock('./login-hero', () => ({ LoginHero: () => null }));
import LoginPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(null);
  mocks.headers.mockResolvedValue(
    new Headers({ 'x-devfathom-host': 'ehatcart.pharmacy.example.com' })
  );
  mocks.notFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

it('answers a mistyped tenant subdomain with the 404 page instead of a sign-in form', async () => {
  mocks.resolve.mockResolvedValue(null);
  mocks.unknown.mockResolvedValue(true);
  await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
  expect(mocks.notFound).toHaveBeenCalledTimes(1);
  expect(mocks.unknown.mock.calls[0]?.[0]).toBe('ehatcart.pharmacy.example.com');
});

it('renders sign-in for a host that is not an unknown tenant subdomain', async () => {
  mocks.resolve.mockResolvedValue(null);
  mocks.unknown.mockResolvedValue(false);
  expect(await LoginPage({ searchParams: Promise.resolve({}) })).toBeTruthy();
  expect(mocks.notFound).not.toHaveBeenCalled();
});
