import { afterEach, expect, it, vi } from 'vitest';
import { tenantInviteUrl } from './invite-url';
import type { ScopedDb } from './scoped-db';
vi.mock('@/lib/email', () => ({ appUrl: () => 'https://agency.example.com' }));
afterEach(() => vi.unstubAllEnvs());
it.each([
  [[], 'https://bistro.example.com/invite/token'],
  [[{ host: 'restaurant.custom.test' }], 'https://restaurant.custom.test/invite/token'],
])('uses the authenticated tenant host', async (domains, expected) => {
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'example.com');
  const findUnique = vi.fn(async () => ({ slug: 'bistro', domains }));
  const db = { organization: { findUnique } } as unknown as ScopedDb;
  expect(await tenantInviteUrl(db, 'session_org', 'token')).toBe(expected);
  expect(findUnique).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'session_org' } })
  );
});

it('preserves the configured development port through the shared host helper', async () => {
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'localhost');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://agency.localhost:3100');
  const db = { organization: { findUnique: vi.fn(async () => ({ slug: 'bistro', domains: [] })) } } as unknown as ScopedDb;
  expect(await tenantInviteUrl(db, 'session_org', 'token')).toBe('http://bistro.localhost:3100/invite/token');
});
