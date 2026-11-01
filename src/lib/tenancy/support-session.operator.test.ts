// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), operator: vi.fn(), tenant: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: async (fn: (db: unknown) => unknown) =>
    fn({
      platformSupportSession: { findUnique: mocks.session },
      platformUser: { findUnique: mocks.operator },
    }),
  withTenantDb: async (_org: string, fn: (db: unknown) => unknown) =>
    fn({ user: { findUnique: mocks.tenant } }),
}));
import { getSupportSession } from './support-session';
const request = new Request('http://localhost', {
  headers: { cookie: `df_support_session=${'x'.repeat(48)}` },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    id: 'support',
    organizationId: 'org',
    platformUserId: 'operator',
    tenantUserId: 'admin',
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 60000),
    reason: 'test support',
  });
  mocks.tenant.mockResolvedValue({ id: 'admin', role: 'ADMIN', status: 'ACTIVE' });
});
it.each([null, { active: false }])(
  'rejects a missing or inactive platform operator before tenant access',
  async (operator) => {
    mocks.operator.mockResolvedValue(operator);
    expect(await getSupportSession(request)).toBeNull();
    expect(mocks.tenant).not.toHaveBeenCalled();
  }
);
it('accepts an active operator and rechecks deactivation on the next request', async () => {
  mocks.operator.mockResolvedValue({ active: true });
  expect(await getSupportSession(request)).toMatchObject({
    platformUserId: 'operator',
    tenantUserId: 'admin',
  });
  mocks.operator.mockResolvedValue({ active: false });
  expect(await getSupportSession(request)).toBeNull();
  expect(mocks.operator).toHaveBeenCalledTimes(2);
});
