// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { PrintRoutingConfigSchema, type PrintRoute } from './contract';
import { replacePrintRoutesInTransaction, registeredRouteAvailable } from './registered-routing';

const route: PrintRoute = { documentType: 'RECEIPT', stationId: null, printerId: 'tcp://printer:9100', registeredPrinterId: 'printer', enabled: true };
let db: ReturnType<typeof makeDb>;
function makeDb() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'branch', active: true }]),
    restaurantKitchenStation: { findMany: vi.fn().mockResolvedValue([{ id: 'station' }]) },
    restaurantPrinter: { findMany: vi.fn().mockResolvedValue([{ id: 'printer', address: route.printerId }]), findFirst: vi.fn().mockResolvedValue({ id: 'printer' }) },
    restaurantPrintRoute: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn(), createMany: vi.fn() },
  };
}
const replace = (routes: PrintRoute[]) => replacePrintRoutesInTransaction(db as unknown as Prisma.TransactionClient, 'org', { branchId: 'branch', routes });
beforeEach(() => { db = makeDb(); });

describe('registered configuration replacement', () => {
  it('preserves omission and explicit null distinctly through input parsing', () => {
    const legacy = { ...route };
    delete legacy.registeredPrinterId;
    const parsed = PrintRoutingConfigSchema.parse({ branchId: 'branch', routes: [legacy, { ...route, registeredPrinterId: null }] });
    expect(Object.hasOwn(parsed.routes[0], 'registeredPrinterId')).toBe(false);
    expect(parsed.routes[1].registeredPrinterId).toBeNull();
  });
  it('serializes replacement and validates ownership before deleting, without requiring ONLINE telemetry', async () => {
    await replace([route]);
    expect(db.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual(['org', 'branch']);
    expect(db.restaurantPrinter.findMany).toHaveBeenCalledWith({ where: { organizationId: 'org', branchId: 'branch', id: { in: ['printer'] }, bridge: { is: { organizationId: 'org', branchId: 'branch', kind: 'PRINT_BRIDGE', status: 'ACTIVE', revokedAt: null } } }, select: { id: true, address: true } });
    expect(db.restaurantPrintRoute.createMany).toHaveBeenCalledWith({ data: [{ ...route, organizationId: 'org', branchId: 'branch' }] });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(db.restaurantPrintRoute.findMany.mock.invocationCallOrder[0]);
    expect(db.restaurantPrinter.findMany.mock.invocationCallOrder[0]).toBeLessThan(db.restaurantPrintRoute.deleteMany.mock.invocationCallOrder[0]);
  });
  it.each(['missing', 'wrong-address'])('retains prior routes for %s printer validation failure', async (condition) => {
    db.restaurantPrinter.findMany.mockResolvedValue(condition === 'missing' ? [] : [{ id: 'printer', address: 'tcp://other:9100' }]);
    await expect(replace([route])).rejects.toMatchObject({ code: 'INVALID_ROUTE', status: 400 });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it.each([{ branches: [] }, { branches: [{ id: 'branch', active: false }] }])('rejects missing or inactive branches before mutations', async ({ branches }) => {
    db.$queryRaw.mockResolvedValue(branches);
    await expect(replace([route])).rejects.toMatchObject({ code: 'INVALID_ROUTE' });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('rejects a station outside the active branch before deletion', async () => {
    await expect(replace([{ ...route, stationId: 'other' }])).rejects.toMatchObject({ code: 'INVALID_ROUTE' });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('blocks omitted references when any registered route exists, including disabled routes', async () => {
    db.restaurantPrintRoute.findMany.mockResolvedValue([{ id: 'disabled' }]);
    const legacy = { ...route };
    delete legacy.registeredPrinterId;
    await expect(replace([legacy])).rejects.toMatchObject({ code: 'REFRESH_REQUIRED', status: 409 });
    expect(db.restaurantPrintRoute.findMany).toHaveBeenCalledWith({ where: { organizationId: 'org', branchId: 'branch', registeredPrinterId: { not: null } }, select: { id: true } });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('allows deliberate explicit null and empty clearing of registered routing', async () => {
    db.restaurantPrintRoute.findMany.mockResolvedValue([{ id: 'existing' }]);
    await replace([{ ...route, registeredPrinterId: null }]);
    expect(db.restaurantPrintRoute.createMany.mock.calls[0][0].data[0].registeredPrinterId).toBeNull();
    await replace([]);
    expect(db.restaurantPrintRoute.deleteMany).toHaveBeenCalledTimes(2);
    expect(db.restaurantPrintRoute.createMany).toHaveBeenCalledOnce();
  });
  it('keeps legacy raw-only configuration compatible when no bindings exist', async () => {
    const legacy = { ...route };
    delete legacy.registeredPrinterId;
    await replace([legacy]);
    expect(db.restaurantPrinter.findMany).not.toHaveBeenCalled();
    expect(db.restaurantPrintRoute.createMany.mock.calls[0][0].data[0]).toMatchObject({ printerId: route.printerId, registeredPrinterId: null });
  });
});

it('rechecks tenant, branch, address and active bridge for a newly enqueued registered snapshot', async () => {
  expect(await registeredRouteAvailable(db as unknown as Prisma.TransactionClient, 'org', 'branch', route)).toBe(true);
  expect(db.restaurantPrinter.findFirst).toHaveBeenCalledWith({ where: { id: 'printer', organizationId: 'org', branchId: 'branch', address: route.printerId, branch: { is: { active: true } }, bridge: { is: { organizationId: 'org', branchId: 'branch', kind: 'PRINT_BRIDGE', status: 'ACTIVE', revokedAt: null } } }, select: { id: true } });
  db.restaurantPrinter.findFirst.mockResolvedValue(null);
  expect(await registeredRouteAvailable(db as unknown as Prisma.TransactionClient, 'org', 'branch', route)).toBe(false);
});
