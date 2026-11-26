import { expect, it, vi } from 'vitest';
import { enrollmentContext } from './shared';

vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<typeof import('@/lib/tenancy/host')>()),
  resolveOrganizationForRequest: async () => ({ id: 'tenant', status: 'ACTIVE' }),
}));

it('keeps wallet enrolment on the exact tenant authority', async () => {
  const host = 'restaurant.localhost:3111';
  const context = (origin: string) =>
    enrollmentContext(new Request('http://' + host, { headers: { host, origin } }));
  expect(await context('http://' + host)).toBeTruthy();
  expect(await context('http://restaurant.localhost:3112')).toBeNull();
  expect(await context('null')).toBeNull();
});
