import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), capabilities: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (original) => ({
  ...(await original<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  annotateAudit: vi.fn(),
}));
vi.mock('../trpc', async () => {
  const { initTRPC } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    adminProcedure: t.procedure,
    capabilityProcedure: (capability: string) => {
      // Recorded at module load, so it is a list rather than a clearable mock.
      mocks.capabilities.push(capability);
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
    expect(new Set(mocks.capabilities)).toEqual(new Set(['hotel:housekeeping']));
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

  it('maps a coded domain error to a client error instead of a 500', async () => {
    db.$transaction.mockRejectedValue(new Error('INVALID_HOUSEKEEPING_TRANSITION'));
    await expect(
      hotelHousekeepingRouter
        .createCaller(context() as never)
        .setStatus({ branchId: 'branch_1', roomId: 'room_1', status: 'INSPECTED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('re-checks property scope inside the locked write transaction, before any write', async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push('query');
        return [];
      }),
      $executeRaw: vi.fn(),
      hotelProperty: { findFirst: vi.fn() },
      hotelRoom: { findFirst: vi.fn(), updateMany: vi.fn() },
    };
    db.$transaction.mockImplementation(async (run: (client: typeof tx) => unknown) => {
      order.push('transaction');
      return run(tx);
    });
    mocks.scope.mockImplementation(async () => {
      order.push('scope');
      throw new TRPCError({ code: 'FORBIDDEN' });
    });
    for (const call of [
      (caller: ReturnType<typeof hotelHousekeepingRouter.createCaller>) =>
        caller.setStatus({ branchId: 'branch_1', roomId: 'room_1', status: 'VACANT_CLEAN' }),
      (caller: ReturnType<typeof hotelHousekeepingRouter.createCaller>) =>
        caller.createTask({ branchId: 'branch_1', roomId: 'room_1', title: 'Turn down' }),
      (caller: ReturnType<typeof hotelHousekeepingRouter.createCaller>) =>
        caller.updateTask({ branchId: 'branch_1', taskId: 'task_1', status: 'COMPLETED' }),
    ]) {
      order.length = 0;
      await expect(call(hotelHousekeepingRouter.createCaller(context() as never))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // Transaction, then the property lock, then the scope check — and nothing after it.
      expect(order).toEqual(['transaction', 'query', 'scope']);
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.hotelRoom.updateMany).not.toHaveBeenCalled();
  });
});
