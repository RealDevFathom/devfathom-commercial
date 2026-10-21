import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  allowed: true,
  branchAllowed: true,
  register: vi.fn(),
  rename: vi.fn(),
  retire: vi.fn(),
  list: vi.fn(),
  enroll: vi.fn(),
  branch: vi.fn(),
  resolve: vi.fn(),
  assertBranch: vi.fn(),
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
vi.mock('@/lib/restaurant/printer-inventory', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/printer-inventory')>(
    '@/lib/restaurant/printer-inventory'
  )),
  registerPrintersForExistingBridge: h.register,
  renamePrinterInventory: h.rename,
  retirePrinterInventory: h.retire,
}));
vi.mock('@/lib/restaurant/commercial-limits', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/commercial-limits')>(
    '@/lib/restaurant/commercial-limits'
  )),
  enrollPrintBridgeWithinCommercialLimits: h.enroll,
}));
vi.mock('@/lib/restaurant/staff-branch-authorization', async () => {
  const { TRPCError } = await import('@trpc/server');
  return {
    resolveCapabilityBranchAuthorization: h.resolve,
    assertAuthorizedBranch: (authorization: unknown, branchId: string) => {
      h.assertBranch(authorization, branchId);
      if (!h.branchAllowed) throw new TRPCError({ code: 'FORBIDDEN' });
    },
    assertActorEligibleForBranch: vi.fn(),
    denyStaffBranchAccess: vi.fn(),
    resolveDemoDirectoryScope: vi.fn(),
  };
});
import { restaurantDevicesRouter } from './restaurant-devices';
import {
  PrinterInventoryError,
  PrinterRenameError,
  PrinterRetirementError,
  publicPrinterSelect,
} from '@/lib/restaurant/printer-inventory';
const context = {
  db: { restaurantBranch: { findFirst: h.branch }, restaurantPrinter: { findMany: h.list } },
  session: { user: { id: 'admin' } },
  entitlements: { organizationId: 'org_1', limits: { 'pos.registeredDevices.max': 2 } },
};
const caller = () => restaurantDevicesRouter.createCaller(context as never);
const printer = { name: 'Kitchen', address: 'tcp://localhost:9100', paperWidthMm: 80 as const };
const input = { branchId: 'branch', bridgeId: 'bridge', printers: [printer] };
beforeEach(() => {
  vi.clearAllMocks();
  h.allowed = true;
  h.branchAllowed = true;
  h.resolve.mockResolvedValue({ branchIds: ['branch'] });
  h.branch.mockResolvedValue({ id: 'branch' });
  h.register.mockResolvedValue(1);
  h.list.mockResolvedValue([]);
  h.enroll.mockResolvedValue({
    device: {
      id: 'new',
      branchId: 'branch',
      name: 'Bridge',
      kind: 'PRINT_BRIDGE',
      deviceSecretHash: 'private',
    },
    enrollment: { code: 'pbe_synthetic', expiresAt: new Date() },
    printerCount: 1,
  });
});
it('lists only the authorized branch with explicit public printer and bridge selection', async () => {
  await caller().listPrinters({ branchId: 'branch' });
  expect(h.resolve).toHaveBeenCalledWith(context.db, context.session.user, 'devices:manage', {
    organizationId: 'org_1',
  });
  expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch');
  expect(h.list).toHaveBeenCalledWith({
    where: { branchId: 'branch' },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: publicPrinterSelect,
  });
  expect(publicPrinterSelect).toEqual({
    id: true,
    branchId: true,
    bridgeId: true,
    name: true,
    connectionKind: true,
    address: true,
    paperWidthMm: true,
    status: true,
    lastSeenAt: true,
    lastError: true,
    retiredAt: true,
    createdAt: true,
    updatedAt: true,
    bridge: { select: { id: true, name: true, kind: true, status: true, revokedAt: true } },
  });
});
it('registers existing-bridge printers without enrollment or secret operations and audits the count', async () => {
  await expect(caller().registerPrinters(input)).resolves.toEqual({ registered: 1 });
  expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch');
  expect(h.register).toHaveBeenCalledWith(context.db, input);
  expect(h.enroll).not.toHaveBeenCalled();
  expect(h.audit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ targetId: 'bridge', metadata: { branchId: 'branch', registered: 1 } })
  );
});
it('forwards optional printers into atomic enrollment and returns only approved fields', async () => {
  const request = { branchId: 'branch', name: 'Bridge', printers: [printer] };
  const result = await caller().initiatePrintBridgeEnrollment(request);
  expect(h.enroll).toHaveBeenCalledWith(context.db, context.entitlements.limits, request);
  expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch');
  expect(result.printerCount).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain('pbe_');
});
it.each(['capability', 'branch'])('denies %s before inventory reads or writes', async (denial) => {
  if (denial === 'capability') h.allowed = false;
  else h.branchAllowed = false;
  for (const call of [
    () => caller().listPrinters({ branchId: 'branch' }),
    () => caller().registerPrinters(input),
    () =>
      caller().initiatePrintBridgeEnrollment({
        branchId: 'branch',
        name: 'Bridge',
        printers: [printer],
      }),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(h.list).not.toHaveBeenCalled();
  expect(h.register).not.toHaveBeenCalled();
  expect(h.enroll).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
});
it('rejects invalid registrations and forged organization ownership before service calls', async () => {
  for (const request of [
    { ...input, printers: [] },
    { ...input, organizationId: 'other' },
    { ...input, printers: [{ ...printer, address: '/tmp/output' }] },
  ])
    await expect(caller().registerPrinters(request)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(h.register).not.toHaveBeenCalled();
});
it('maps inventory denial and does not audit success', async () => {
  h.register.mockRejectedValueOnce(
    new PrinterInventoryError('Active print bridge not found in this branch.')
  );
  await expect(caller().registerPrinters(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(h.audit).not.toHaveBeenCalled();
});

const rename = { branchId: 'branch', printerId: 'printer', expectedName: 'Old', name: 'New' };
it('authorizes name correction before service access and returns only the public result', async () => {
  h.rename.mockResolvedValue({
    printer: { id: 'printer', branchId: 'branch', name: 'New' },
    changed: true,
    bridgeId: 'bridge',
    previousName: 'Old',
  });
  await expect(caller().renamePrinter(rename)).resolves.toEqual({
    printer: { id: 'printer', branchId: 'branch', name: 'New' },
    changed: true,
  });
  expect(h.rename).toHaveBeenCalledWith(context.db, rename);
  expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch');
  expect(h.assertBranch.mock.invocationCallOrder[0]).toBeLessThan(
    h.rename.mock.invocationCallOrder[0]
  );
  expect(h.audit).toHaveBeenCalledWith(context, {
    targetType: 'RestaurantPrinter',
    targetId: 'printer',
    targetLabel: 'New',
    description: 'Renamed printer inventory label',
    metadata: { branchId: 'branch', bridgeId: 'bridge', previousName: 'Old', changed: true },
  });
});
it.each(['capability', 'branch'])(
  'denies name correction at %s before service access',
  async (denial) => {
    if (denial === 'capability') h.allowed = false;
    else h.branchAllowed = false;
    await expect(caller().renamePrinter(rename)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  }
);
it.each(['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'] as const)(
  'maps typed rename %s without success audit',
  async (code) => {
    h.rename.mockRejectedValueOnce(
      new PrinterRenameError(code, 'Scoped name correction rejected.')
    );
    await expect(caller().renamePrinter(rename)).rejects.toMatchObject({ code });
    expect(h.audit).not.toHaveBeenCalled();
  }
);
it('rejects extra transport and tenant fields before rename service', async () => {
  for (const request of [
    { ...rename, address: 'tcp://other:9100' },
    { ...rename, organizationId: 'other' },
    { ...rename, name: ' ' },
  ])
    await expect(caller().renamePrinter(request)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(h.rename).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
});
it('describes a no-op as unchanged instead of a completed rename', async () => {
  h.rename.mockResolvedValue({
    printer: { id: 'printer', branchId: 'branch', name: 'Old' },
    changed: false,
    bridgeId: 'bridge',
    previousName: 'Old',
  });
  await expect(caller().renamePrinter({ ...rename, name: 'Old' })).resolves.toMatchObject({
    changed: false,
  });
  expect(h.audit).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      description: 'Printer inventory label unchanged',
      metadata: expect.objectContaining({ changed: false }),
    })
  );
});

const retirement = { branchId: 'branch', printerId: 'printer' };
const retiredAt = new Date('2026-10-14T12:00:00Z');
it.each([true, false])(
  'authorizes and audits retirement changed=%s with a public result',
  async (changed) => {
    const result = {
      printer: { id: 'printer', branchId: 'branch', name: 'Kitchen', retiredAt },
      bridgeId: 'bridge',
      changed,
    };
    h.retire.mockResolvedValue(result);
    await expect(caller().retirePrinter(retirement)).resolves.toEqual({
      printer: result.printer,
      changed,
    });
    expect(h.retire).toHaveBeenCalledWith(context.db, retirement);
    expect(h.resolve).toHaveBeenCalledWith(context.db, context.session.user, 'devices:manage', {
      organizationId: 'org_1',
    });
    expect(h.assertBranch.mock.invocationCallOrder[0]).toBeLessThan(
      h.retire.mock.invocationCallOrder[0]
    );
    expect(h.audit).toHaveBeenCalledWith(context, {
      targetType: 'RestaurantPrinter',
      targetId: 'printer',
      targetLabel: 'Kitchen',
      description: changed ? 'Retired printer inventory' : 'Printer inventory already retired',
      metadata: {
        branchId: 'branch',
        bridgeId: 'bridge',
        retiredAt: retiredAt.toISOString(),
        changed,
      },
    });
  }
);
it.each(['capability', 'branch'])(
  'denies retirement at %s before service or success audit',
  async (denial) => {
    if (denial === 'capability') h.allowed = false;
    else h.branchAllowed = false;
    await expect(caller().retirePrinter(retirement)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  }
);
it.each(['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'] as const)(
  'maps retirement %s without success audit',
  async (code) => {
    h.retire.mockRejectedValueOnce(new PrinterRetirementError(code, 'Scoped retirement rejected.'));
    await expect(caller().retirePrinter(retirement)).rejects.toMatchObject({ code });
    expect(h.audit).not.toHaveBeenCalled();
  }
);
it('propagates unknown retirement errors without auditing success', async () => {
  h.retire.mockRejectedValueOnce(new Error('unexpected failure'));
  await expect(caller().retirePrinter(retirement)).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });
  expect(h.audit).not.toHaveBeenCalled();
});
it.each(['organizationId', 'retiredAt', 'address', 'restore'])(
  'rejects forged retirement %s before service',
  async (key) => {
    await expect(caller().retirePrinter({ ...retirement, [key]: 'forged' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  }
);
it('keeps retired inventory visible in the authorized list', async () => {
  const row = { id: 'printer', name: 'Kitchen', retiredAt };
  h.list.mockResolvedValueOnce([row]);
  await expect(caller().listPrinters({ branchId: 'branch' })).resolves.toEqual([row]);
  expect(h.list.mock.calls[0][0].where).toEqual({ branchId: 'branch' });
  expect(publicPrinterSelect.retiredAt).toBe(true);
});
