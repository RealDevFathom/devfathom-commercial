import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  allowed: true,
  branchAllowed: true,
  enroll: vi.fn(),
  branch: vi.fn(),
  resolve: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../trpc', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return {
    router: t.router,
    auditedProtectedProcedure: t.procedure,
    capabilityProcedure: (capability: string) =>
      t.procedure.use(({ next }) => {
        if (capability !== 'devices:manage' || !h.allowed)
          throw new TRPCError({ code: 'FORBIDDEN' });
        return next();
      }),
  };
});
vi.mock('../audit', () => ({ annotateAudit: h.audit }));
vi.mock('@/lib/restaurant/commercial-limits', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/commercial-limits')>(
    '@/lib/restaurant/commercial-limits'
  );
  return { ...actual, enrollPrintBridgeWithinCommercialLimits: h.enroll };
});
vi.mock('@/lib/restaurant/staff-branch-authorization', async () => {
  const { TRPCError } = await import('@trpc/server');
  return {
    resolveCapabilityBranchAuthorization: h.resolve,
    assertAuthorizedBranch: () => {
      if (!h.branchAllowed) throw new TRPCError({ code: 'FORBIDDEN' });
    },
    assertActorEligibleForBranch: vi.fn(),
    denyStaffBranchAccess: vi.fn(),
    resolveDemoDirectoryScope: vi.fn(),
  };
});
import { restaurantDevicesRouter } from './restaurant-devices';
import { CommercialLimitError } from '@/lib/restaurant/commercial-limits';
const context = {
  db: { restaurantBranch: { findFirst: h.branch } },
  session: { user: { id: 'admin' } },
  entitlements: { limits: { 'pos.registeredDevices.max': 2 } },
};
const caller = () => restaurantDevicesRouter.createCaller(context as never);
const input = { branchId: 'branch', name: 'Kitchen bridge' };
beforeEach(() => {
  vi.clearAllMocks();
  h.allowed = true;
  h.branchAllowed = true;
  h.resolve.mockResolvedValue({ branchIds: ['branch'] });
  h.branch.mockResolvedValue({ id: 'branch' });
  h.enroll.mockResolvedValue({
    device: {
      id: 'new',
      name: input.name,
      branchId: 'branch',
      kind: 'PRINT_BRIDGE',
      deviceSecretHash: 'private-hash',
    },
    enrollment: { code: 'pbe_synthetic', expiresAt: new Date('2026-10-14') },
    secret: 'private-secret',
  });
});
it('returns only public device fields and one-use enrollment code', async () => {
  const result = await caller().initiatePrintBridgeEnrollment(input);
  expect(result.device).toEqual({
    id: 'new',
    name: input.name,
    branchId: 'branch',
    kind: 'PRINT_BRIDGE',
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(h.audit).toHaveBeenCalledOnce();
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain('pbe_');
  expect(h.branch).toHaveBeenCalledWith({
    where: { id: 'branch', active: true },
    select: { id: true },
  });
  expect(h.enroll).toHaveBeenCalledWith(context.db, context.entitlements.limits, input);
});
it('rejects an existing device ID instead of bypassing rotation authorization', async () => {
  await expect(
    caller().initiatePrintBridgeEnrollment({ ...input, deviceId: 'existing' } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(h.enroll).not.toHaveBeenCalled();
});
it('requires the device-management capability', async () => {
  h.allowed = false;
  await expect(caller().initiatePrintBridgeEnrollment(input)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(h.enroll).not.toHaveBeenCalled();
});
it('requires branch authorization before looking up or creating a device', async () => {
  h.branchAllowed = false;
  await expect(caller().initiatePrintBridgeEnrollment(input)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(h.branch).not.toHaveBeenCalled();
  expect(h.enroll).not.toHaveBeenCalled();
});
it('requires an active branch', async () => {
  h.branch.mockResolvedValue(null);
  await expect(caller().initiatePrintBridgeEnrollment(input)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(h.enroll).not.toHaveBeenCalled();
});
it('maps the commercial limit failure without recording success', async () => {
  h.enroll.mockRejectedValue(
    new CommercialLimitError('pos.registeredDevices.max', 'LIMIT_REACHED')
  );
  await expect(caller().initiatePrintBridgeEnrollment(input)).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  expect(h.audit).not.toHaveBeenCalled();
});
