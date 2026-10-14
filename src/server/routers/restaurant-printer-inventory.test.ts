import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ allowed: true, branchAllowed: true, register: vi.fn(), list: vi.fn(), enroll: vi.fn(), branch: vi.fn(), resolve: vi.fn(), assertBranch: vi.fn(), audit: vi.fn() }));
vi.mock('../trpc', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const t = initTRPC.context<Record<string, unknown>>().create();
  return { router: t.router, auditedProtectedProcedure: t.procedure, capabilityProcedure: (capability: string) => t.procedure.use(({ next }) => {
    if (capability !== 'devices:manage' || !h.allowed) throw new TRPCError({ code: 'FORBIDDEN' }); return next();
  }) };
});
vi.mock('../audit', () => ({ annotateAudit: h.audit }));
vi.mock('@/lib/restaurant/printer-inventory', async () => ({ ...await vi.importActual<typeof import('@/lib/restaurant/printer-inventory')>('@/lib/restaurant/printer-inventory'), registerPrintersForExistingBridge: h.register }));
vi.mock('@/lib/restaurant/commercial-limits', async () => ({ ...await vi.importActual<typeof import('@/lib/restaurant/commercial-limits')>('@/lib/restaurant/commercial-limits'), enrollPrintBridgeWithinCommercialLimits: h.enroll }));
vi.mock('@/lib/restaurant/staff-branch-authorization', async () => {
  const { TRPCError } = await import('@trpc/server');
  return { resolveCapabilityBranchAuthorization: h.resolve, assertAuthorizedBranch: (authorization: unknown, branchId: string) => { h.assertBranch(authorization, branchId); if (!h.branchAllowed) throw new TRPCError({ code: 'FORBIDDEN' }); }, assertActorEligibleForBranch: vi.fn(), denyStaffBranchAccess: vi.fn(), resolveDemoDirectoryScope: vi.fn() };
});
import { restaurantDevicesRouter } from './restaurant-devices';
import { PrinterInventoryError, publicPrinterSelect } from '@/lib/restaurant/printer-inventory';
const context = { db: { restaurantBranch: { findFirst: h.branch }, restaurantPrinter: { findMany: h.list } }, session: { user: { id: 'admin' } }, entitlements: { limits: { 'pos.registeredDevices.max': 2 } } };
const caller = () => restaurantDevicesRouter.createCaller(context as never);
const printer = { name: 'Kitchen', address: 'tcp://localhost:9100', paperWidthMm: 80 as const };
const input = { branchId: 'branch', bridgeId: 'bridge', printers: [printer] };
beforeEach(() => {
  vi.clearAllMocks(); h.allowed = true; h.branchAllowed = true; h.resolve.mockResolvedValue({ branchIds: ['branch'] });
  h.branch.mockResolvedValue({ id: 'branch' }); h.register.mockResolvedValue(1); h.list.mockResolvedValue([]);
  h.enroll.mockResolvedValue({ device: { id: 'new', branchId: 'branch', name: 'Bridge', kind: 'PRINT_BRIDGE', deviceSecretHash: 'private' }, enrollment: { code: 'pbe_synthetic', expiresAt: new Date() }, printerCount: 1 });
});
it('lists only the authorized branch with explicit public printer and bridge selection', async () => {
  await caller().listPrinters({ branchId: 'branch' });
  expect(h.resolve).toHaveBeenCalledWith(context.db, context.session.user, 'devices:manage'); expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch');
  expect(h.list).toHaveBeenCalledWith({ where: { branchId: 'branch' }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: publicPrinterSelect });
  expect(publicPrinterSelect).toEqual({ id: true, branchId: true, bridgeId: true, name: true, connectionKind: true, address: true, paperWidthMm: true, status: true, lastSeenAt: true, lastError: true, createdAt: true, updatedAt: true, bridge: { select: { id: true, name: true, kind: true, status: true, revokedAt: true } } });
});
it('registers existing-bridge printers without enrollment or secret operations and audits the count', async () => {
  await expect(caller().registerPrinters(input)).resolves.toEqual({ registered: 1 });
  expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch'); expect(h.register).toHaveBeenCalledWith(context.db, input); expect(h.enroll).not.toHaveBeenCalled();
  expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetId: 'bridge', metadata: { branchId: 'branch', registered: 1 } }));
});
it('forwards optional printers into atomic enrollment and returns only approved fields', async () => {
  const request = { branchId: 'branch', name: 'Bridge', printers: [printer] };
  const result = await caller().initiatePrintBridgeEnrollment(request);
  expect(h.enroll).toHaveBeenCalledWith(context.db, context.entitlements.limits, request); expect(h.assertBranch).toHaveBeenCalledWith({ branchIds: ['branch'] }, 'branch');
  expect(result.printerCount).toBe(1); expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain('pbe_');
});
it.each(['capability', 'branch'])('denies %s before inventory reads or writes', async (denial) => {
  if (denial === 'capability') h.allowed = false; else h.branchAllowed = false;
  for (const call of [() => caller().listPrinters({ branchId: 'branch' }), () => caller().registerPrinters(input), () => caller().initiatePrintBridgeEnrollment({ branchId: 'branch', name: 'Bridge', printers: [printer] })])
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(h.list).not.toHaveBeenCalled(); expect(h.register).not.toHaveBeenCalled(); expect(h.enroll).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
});
it('rejects invalid registrations and forged organization ownership before service calls', async () => {
  for (const request of [{ ...input, printers: [] }, { ...input, organizationId: 'other' }, { ...input, printers: [{ ...printer, address: '/tmp/output' }] }])
    await expect(caller().registerPrinters(request)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(h.register).not.toHaveBeenCalled();
});
it('maps inventory denial and does not audit success', async () => {
  h.register.mockRejectedValueOnce(new PrinterInventoryError('Active print bridge not found in this branch.'));
  await expect(caller().registerPrinters(input)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(h.audit).not.toHaveBeenCalled();
});
