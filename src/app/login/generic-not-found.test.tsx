import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedSignInUrl } from '@/lib/tenancy/host-routing';
import { GenericNotFound } from './generic-not-found';

const mocks = vi.hoisted(() => ({ back: vi.fn(), host: 'typo.localhost:3000' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-devfathom-host': mocks.host }),
}));
vi.mock('@/lib/tenancy/host', () => ({ TENANT_HOST_HEADER: 'x-devfathom-host' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back: mocks.back }) }));
afterEach(() => {
  vi.unstubAllEnvs();
  mocks.host = 'typo.localhost:3000';
});

it('offers a shared sign-in outside the mistyped host and working back navigation', () => {
  render(<GenericNotFound signInUrl="http://app.localhost:3000/login" />);
  expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
    'href',
    'http://app.localhost:3000/login'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
  expect(mocks.back).toHaveBeenCalledOnce();
});

it('keeps back navigation when a shared host is not configured', () => {
  render(<GenericNotFound signInUrl={null} />);
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
  expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
    'href',
    'http://app.localhost:3000/login'
  );
});

it('SEC-G: the 404 neither confirms a workspace lookup nor echoes the requested workspace', async () => {
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'example.test');
  const { default: LoginNotFound } = await import('./not-found');

  mocks.host = 'acme-pharmacy.example.test';
  const first = render(await LoginNotFound());
  const firstText = first.container.textContent ?? '';
  const firstNotice = screen.getByRole('heading', { level: 1 }).parentElement?.textContent ?? '';
  const firstHtml = first.container.innerHTML;
  first.unmount();

  mocks.host = 'globex-clinic.example.test';
  const second = render(await LoginNotFound());
  const secondText = second.container.textContent ?? '';

  expect(firstNotice).not.toMatch(/workspace/i);
  expect(firstHtml).not.toMatch(/acme/i);
  expect(second.container.innerHTML).not.toMatch(/globex/i);
  // Every unknown host gets the same page, so nothing distinguishes one probe from another.
  expect(secondText).toBe(firstText);
  expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
});
