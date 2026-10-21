import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/components/restaurant/catering/catering-console', () => ({
  CateringConsole: () => null,
}));
import RestaurantCateringPage from './page';

describe('RestaurantCateringPage currency handoff', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(['USD', 'PKR', ''])(
    'passes the resolved tenant organization currency %s',
    async (currency) => {
      // The actor resolver handles shared hosts and support sessions, as in createTRPCContext.
      mocks.resolveTenantActor.mockResolvedValue({
        organization: { id: 'tenant_b', currency },
        session: { user: { organizationId: 'tenant_b' } },
      });
      expect((await RestaurantCateringPage()).props.currency).toBe(currency);
      expect(mocks.resolveTenantActor).toHaveBeenCalledExactlyOnceWith();
    }
  );
  it('keeps currency unknown without a usable actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    expect((await RestaurantCateringPage()).props.currency).toBeNull();
  });
  it('does not bypass tenant resolution errors with a default currency', async () => {
    mocks.resolveTenantActor.mockRejectedValue(new Error('Workspace mismatch'));
    await expect(RestaurantCateringPage()).rejects.toThrow('Workspace mismatch');
  });
});
