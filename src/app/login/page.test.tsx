import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), headers: vi.fn(), redirect: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/lib/tenancy/host', () => ({
  resolveOrganizationByHost: vi.fn(),
  TENANT_HOST_HEADER: 'x-devfathom-host',
}));
vi.mock('@/lib/tenancy/host-routing', () => ({ isSharedHost: () => true }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ resolveOrganizationEntitlements: vi.fn() }));
vi.mock('./login-form', () => ({ LoginForm: () => null }));
vi.mock('./shared-login-form', () => ({ SharedLoginForm: () => null }));
vi.mock('./login-hero', () => ({ LoginHero: () => null }));
import LoginPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
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

it('starts with a skip link targeting the main sign-in landmark', async () => {
  mocks.actor.mockResolvedValue(null);
  render(await LoginPage({ searchParams: Promise.resolve({}) }));

  const skipLink = screen.getByRole('link', { name: 'Skip to content' });
  const main = screen.getByRole('main');
  expect(document.querySelectorAll('a, button, input, select, textarea')[0]).toBe(skipLink);
  expect(skipLink).toHaveAttribute('href', '#main-content');
  expect(main).toHaveAttribute('id', 'main-content');
  expect(main).toHaveAttribute('tabindex', '-1');
  main.focus();
  expect(main).toHaveFocus();
});
