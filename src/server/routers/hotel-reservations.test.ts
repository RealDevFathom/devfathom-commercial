import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), capabilities: [] as string[] }));
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
    protectedProcedure: t.procedure,
    adminProcedure: t.procedure,
    capabilityProcedure: (capability: string) => {
      mocks.capabilities.push(capability);
      return t.procedure;
    },
  };
});

import { availabilityInput, hotelReservationsRouter } from './hotel-reservations';

const db = {
  $queryRaw: vi.fn(async () => []),
  hotelProperty: {
    findFirst: vi.fn(async () => ({
      organizationId: 'org_1',
      branchId: 'branch_1',
      currency: 'PKR',
    })),
  },
};
const caller = () =>
  hotelReservationsRouter.createCaller({
    session: { user: { id: 'user_1', organizationId: 'org_1' } },
    entitlements: { organizationId: 'org_1' },
    requestMeta: { ip: null },
    db,
  } as never);

beforeEach(() => {
  mocks.scope.mockReset();
  db.$queryRaw.mockClear();
});

describe('hotelReservations.getWithFolio', () => {
  it('is mounted only behind hotel:reservations; no route is gated on hotel:folio alone', () => {
    expect(new Set(mocks.capabilities)).toEqual(new Set(['hotel:reservations']));
  });

  it('refuses a folio-only role before reading guest identity', async () => {
    // e.g. Housekeeping Supervisor: hotel:folio for this property, no hotel:reservations.
    mocks.scope.mockImplementation(async (_ctx: unknown, _branchId: string, capability: string) => {
      if (capability !== 'hotel:folio') throw new TRPCError({ code: 'FORBIDDEN' });
      return { organizationId: 'org_1', branchId: 'branch_1' };
    });
    await expect(
      caller().getWithFolio({ branchId: 'branch_1', id: 'res_1' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a reservations-only role the folio projection', async () => {
    mocks.scope.mockImplementation(async (_ctx: unknown, _branchId: string, capability: string) => {
      if (capability !== 'hotel:reservations') throw new TRPCError({ code: 'FORBIDDEN' });
      return { organizationId: 'org_1', branchId: 'branch_1' };
    });
    await expect(
      caller().getWithFolio({ branchId: 'branch_1', id: 'res_1' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('checks both capabilities for the selected property', async () => {
    mocks.scope.mockResolvedValue({ organizationId: 'org_1', branchId: 'branch_1' });
    await caller()
      .getWithFolio({ branchId: 'branch_1', id: 'res_1' })
      .catch(() => undefined);
    expect(mocks.scope.mock.calls.map((call) => call[2])).toEqual([
      'hotel:reservations',
      'hotel:folio',
    ]);
  });
});

describe('hotelReservations.availability input', () => {
  it('rejects a millennia-long range without walking its nights', () => {
    const range = { branchId: 'branch_1', arrivalDate: '2026-10-22', departureDate: '2026-10-24' };
    expect(availabilityInput.safeParse(range).success).toBe(true);
    const started = performance.now();
    const result = availabilityInput.safeParse({
      ...range,
      arrivalDate: '0000-01-01',
      departureDate: '9999-12-31',
    });
    const elapsed = performance.now() - started;
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['departureDate']);
    expect(elapsed).toBeLessThan(25);
  });
});
