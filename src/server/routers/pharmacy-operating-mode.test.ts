import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTRPC } from '@trpc/server';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), authorize: vi.fn() }));
vi.mock('../trpc', () => {
  const t = initTRPC.context().create();
  return { protectedProcedure: t.procedure, router: t.router };
});
vi.mock('@/lib/pharmacy/solo-approval', () => ({
  verifySoloOwnerPin: mocks.verify,
  authorizeSoloApproval: mocks.authorize,
}));
import { pharmacyOperatingModeRouter } from './pharmacy-operating-mode';
import type { TRPCContext } from '../trpc';
function fixture(mode = 'STAFFED', role = 'owner') {
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: { findFirst: vi.fn(async () => ({ organizationRole: { key: role, isSystem: true } })) },
    organization: {
      findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })),
      update: vi.fn(async ({ data }) => data),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (run) => run(db));
  const caller = pharmacyOperatingModeRouter.createCaller({
    db,
    session: { user: { id: 'owner' } },
    entitlements: { organizationId: 'org' },
  } as unknown as TRPCContext);
  return { db, caller };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockImplementation(async (_db, _scope, pin) => pin === '4729');
  mocks.authorize.mockImplementation(async (_db, _scope, _target, pin) => pin === '4729');
});
describe('owner-only operating-mode toggle', () => {
  it.each(['cashier', 'pharmacist', 'manager'])(
    'denies %s even with a correct PIN',
    async (role) => {
      const f = fixture('STAFFED', role);
      await expect(f.caller.set({ mode: 'SOLO', pin: '4729' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(f.db.organization.update).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
    }
  );
  it.each(['SOLO', 'STAFFED'] as const)(
    'requires owner PIN even for an unchanged %s setting',
    async (mode) => {
      const f = fixture(mode);
      await expect(f.caller.set({ mode, pin: '0000' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(f.db.organization.update).not.toHaveBeenCalled();
      expect(f.db.auditLog.create).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['STAFFED', 'SOLO'],
    ['SOLO', 'STAFFED'],
  ] as const)('audits %s to %s without persisting the PIN', async (from, to) => {
    const f = fixture(from);
    await expect(f.caller.set({ mode: to, pin: '4729' })).resolves.toEqual({
      pharmacyOperatingMode: to,
    });
    expect(f.db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PHARMACY:OPERATING_MODE_CHANGED',
        metadata: { from, to, reauthentication: 'PIN' },
      }),
    });
    expect(JSON.stringify(f.db.auditLog.create.mock.calls)).not.toContain('4729');
  });
  it('refuses missing PIN at the input boundary', async () => {
    const f = fixture();
    await expect(f.caller.set({ mode: 'SOLO' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.db.organization.update).not.toHaveBeenCalled();
  });
});
