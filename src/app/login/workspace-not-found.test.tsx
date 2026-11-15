import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedSignInUrl } from '@/lib/tenancy/host-routing';
import { WorkspaceNotFound } from './workspace-not-found';

const mocks = vi.hoisted(() => ({ back: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-devfathom-host': 'typo.localhost:3000' }),
}));
vi.mock('@/lib/tenancy/host', () => ({ TENANT_HOST_HEADER: 'x-devfathom-host' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: mocks.back }) }));
afterEach(() => vi.unstubAllEnvs());

it('offers a shared sign-in outside the mistyped host and working back navigation', () => {
  render(<WorkspaceNotFound signInUrl="http://app.localhost:3000/login" />);
  expect(screen.getByRole('heading', { level: 1, name: 'Workspace not found' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Find your workspace' })).toHaveAttribute(
    'href',
    'http://app.localhost:3000/login'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
  expect(mocks.back).toHaveBeenCalledOnce();
});

it('keeps back navigation when a shared host is not configured', () => {
  render(<WorkspaceNotFound signInUrl={null} />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Go back' })).toBeVisible();
});

it('preserves the local port and uses the configured base outside local development', () => {
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'staging.example.test');
  expect(sharedSignInUrl('typo.localhost:3000')).toBe('http://app.localhost:3000/login');
  expect(sharedSignInUrl('typo.staging.example.test')).toBe(
    'https://app.staging.example.test/login'
  );
  expect(sharedSignInUrl('attacker.example:9999')).toBe('https://app.staging.example.test/login');
  vi.stubEnv('PLATFORM_BASE_DOMAIN', '');
  expect(sharedSignInUrl('typo.example.test')).toBeNull();
});

it('renders the login 404 inside the branded auth shell', async () => {
  const { default: LoginNotFound } = await import('./not-found');
  render(await LoginNotFound());
  expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { level: 1 }));
  expect(screen.getAllByText('DevFathom').length).toBeGreaterThan(0);
  expect(screen.getByRole('link', { name: 'Find your workspace' })).toHaveAttribute(
    'href',
    'http://app.localhost:3000/login'
  );
});
