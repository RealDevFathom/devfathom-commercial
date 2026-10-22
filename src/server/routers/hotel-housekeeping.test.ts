import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), capability: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (original) => ({
  ...(await original<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return {
    router: t.router,
    capabilityProcedure: (capability: string) => {
      mocks.capability(capability);
      return t.procedure;
    },
  };
});

import { hotelHousekeepingRouter } from './hotel-housekeeping';

const db = { $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn() };
const context = () => ({
  session: { user: { id: 'user_1', organizationId: 'org_1' } },
  entitlements: { organizationId: 'org_1' },
  requestMeta: { ip: null },
  db,
});

beforeEach(() => {
  mocks.scope.mockReset();
  db.$queryRaw.mockReset();
  db.$executeRaw.mockReset();
  db.$transaction.mockReset();
  mocks.scope.mockResolvedValue({ organizationId: 'org_1', branchId: 'branch_1' });
});

describe('hotel housekeeping router isolation', () => {
  it('gates reads and writes with hotel:housekeeping', () => {
    expect(mocks.capability).toHaveBeenCalledWith('hotel:housekeeping');
  });

  it('denies a cross-tenant read before executing SQL', async () => {
    mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(
      hotelHousekeepingRouter
        .createCaller(context() as never)
        .list({ branchId: 'other-tenant-branch' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(mocks.scope).toHaveBeenCalledWith(
      expect.anything(),
      'other-tenant-branch',
      'hotel:housekeeping'
    );
  });
});
