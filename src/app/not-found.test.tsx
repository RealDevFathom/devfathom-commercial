import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/unknown-tenant-host', () => ({
  currentUnknownTenantHost: mocks.current,
}));
vi.mock('@/app/login/login-hero', () => ({ LoginHero: () => null }));

import NotFound from './not-found';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_BASE_DOMAIN;
});

afterEach(() => {
  if (ORIGINAL_BASE_DOMAIN === undefined) delete process.env.PLATFORM_BASE_DOMAIN;
  else process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
});

it('renders a branded pharmacy-not-found page for an unknown pharmacy subdomain', async () => {
  mocks.current.mockResolvedValue({ unknown: true, vertical: 'pharmacy' });
  render(await NotFound());
  expect(screen.getByRole('heading', { level: 1, name: 'Pharmacy not found' })).toBeTruthy();
  expect(screen.getByText(/couldn.t find a pharmacy at this address/i)).toBeTruthy();
  // Never links into a workspace that does not exist.
  expect(screen.queryByRole('link', { name: 'Go to Dashboard' })).toBeNull();
});

it('links an unknown tenant back to the shared sign-in, keeping its vertical', async () => {
  process.env.PLATFORM_BASE_DOMAIN = 'pharmacy.example.com';
  mocks.current.mockResolvedValue({ unknown: true, vertical: 'pharmacy' });
  render(await NotFound());
  const link = screen.getByRole('link', { name: 'Go to sign-in' });
  expect(link.getAttribute('href')).toBe('https://pharmacy.example.com/login?vertical=pharmacy');
  for (const anchor of screen.getAllByRole('link')) {
    expect(anchor.getAttribute('href')).not.toContain('/dashboard');
  }
});

it('omits the sign-in link when no base domain is configured', async () => {
  mocks.current.mockResolvedValue({ unknown: true, vertical: 'pharmacy' });
  render(await NotFound());
  expect(screen.getByRole('heading', { level: 1, name: 'Pharmacy not found' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Go to sign-in' })).toBeNull();
});

it('keeps the generic page-not-found for a missing page on a known host', async () => {
  mocks.current.mockResolvedValue({ unknown: false, vertical: 'default' });
  render(await NotFound());
  expect(screen.getByText('Page not found')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toBeTruthy();
});

it('falls back to the generic page when the host lookup fails', async () => {
  mocks.current.mockRejectedValue(new Error('db down'));
  render(await NotFound());
  expect(screen.getByText('Page not found')).toBeTruthy();
});
