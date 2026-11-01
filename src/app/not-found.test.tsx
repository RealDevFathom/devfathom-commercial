import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/unknown-tenant-host', () => ({
  currentUnknownTenantHost: mocks.current,
}));
vi.mock('@/app/login/login-hero', () => ({ LoginHero: () => null }));

import NotFound from './not-found';

beforeEach(() => vi.clearAllMocks());

it('renders a branded pharmacy-not-found page for an unknown pharmacy subdomain', async () => {
  mocks.current.mockResolvedValue({ unknown: true, vertical: 'pharmacy' });
  render(await NotFound());
  expect(screen.getByRole('heading', { level: 1, name: 'Pharmacy not found' })).toBeTruthy();
  expect(screen.getByText(/couldn.t find a pharmacy at this address/i)).toBeTruthy();
  // Never links into a workspace that does not exist.
  expect(screen.queryByRole('link', { name: 'Go to Dashboard' })).toBeNull();
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
