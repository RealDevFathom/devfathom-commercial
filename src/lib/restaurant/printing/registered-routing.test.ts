// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  PrintRoutingConfigSchema,
  PrintRoutingRequestSchema,
  ExpectedPrintDestinationSchema,
  type PrintRoute,
} from './contract';
import { samePrintRoutingConfig } from './routing';
import { replacePrintRoutesInTransaction, registeredRouteAvailable } from './registered-routing';

const route: PrintRoute = {
  documentType: 'RECEIPT',
  stationId: null,
  printerId: 'tcp://printer:9100',
  registeredPrinterId: 'printer',
  enabled: true,
};
let db: ReturnType<typeof makeDb>;
function makeDb() {
  return {
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) =>
      query.join('').includes('restaurant_printers')
        ? [{ id: String(values.at(-1)), active: true }]
        : [{ id: 'branch', active: true }]
    ),
    restaurantKitchenStation: { findMany: vi.fn().mockResolvedValue([{ id: 'station' }]) },
    restaurantPrinter: {
      findMany: vi.fn().mockResolvedValue([{ id: 'printer', address: route.printerId }]),
      findFirst: vi.fn().mockResolvedValue({ id: 'printer' }),
    },
    restaurantPrintRoute: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };
}
const replace = (routes: PrintRoute[]) =>
  replacePrintRoutesInTransaction(db as unknown as Prisma.TransactionClient, 'org', {
    branchId: 'branch',
    routes,
  });
beforeEach(() => {
  db = makeDb();
});

describe('registered configuration replacement', () => {
  it('preserves omission and explicit null distinctly through input parsing', () => {
    const legacy = { ...route };
    delete legacy.registeredPrinterId;
    const parsed = PrintRoutingConfigSchema.parse({
      branchId: 'branch',
      routes: [legacy, { ...route, registeredPrinterId: null }],
    });
    expect(Object.hasOwn(parsed.routes[0], 'registeredPrinterId')).toBe(false);
    expect(parsed.routes[1].registeredPrinterId).toBeNull();
  });
  it('serializes replacement and validates ownership before deleting, without requiring ONLINE telemetry', async () => {
    await replace([route]);
    expect(db.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(db.$queryRaw.mock.calls[0].slice(1)).toEqual(['org', 'branch']);
    expect(db.restaurantPrinter.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org',
        branchId: 'branch',
        id: { in: ['printer'] },
        retiredAt: null,
        bridge: {
          is: {
            organizationId: 'org',
            branchId: 'branch',
            kind: 'PRINT_BRIDGE',
            status: 'ACTIVE',
            revokedAt: null,
          },
        },
      },
      select: { id: true, address: true },
    });
    expect(db.restaurantPrintRoute.createMany).toHaveBeenCalledWith({
      data: [{ ...route, organizationId: 'org', branchId: 'branch' }],
    });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.restaurantPrintRoute.findMany.mock.invocationCallOrder[0]
    );
    expect(db.restaurantPrinter.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.restaurantPrintRoute.deleteMany.mock.invocationCallOrder[0]
    );
  });
  it.each(['missing', 'wrong-address'])(
    'retains prior routes for %s printer validation failure',
    async (condition) => {
      db.restaurantPrinter.findMany.mockResolvedValue(
        condition === 'missing' ? [] : [{ id: 'printer', address: 'tcp://other:9100' }]
      );
      await expect(replace([route])).rejects.toMatchObject({ code: 'INVALID_ROUTE', status: 400 });
      expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
    }
  );
  it.each([{ branches: [] }, { branches: [{ id: 'branch', active: false }] }])(
    'rejects missing or inactive branches before mutations',
    async ({ branches }) => {
      db.$queryRaw.mockResolvedValue(branches);
      await expect(replace([route])).rejects.toMatchObject({ code: 'INVALID_ROUTE' });
      expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
    }
  );
  it('rejects a station outside the active branch before deletion', async () => {
    await expect(replace([{ ...route, stationId: 'other' }])).rejects.toMatchObject({
      code: 'INVALID_ROUTE',
    });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('blocks omitted references when any registered route exists, including disabled routes', async () => {
    db.restaurantPrintRoute.findMany.mockResolvedValue([{ id: 'disabled' }]);
    const legacy = { ...route };
    delete legacy.registeredPrinterId;
    await expect(replace([legacy])).rejects.toMatchObject({
      code: 'REFRESH_REQUIRED',
      status: 409,
    });
    expect(db.restaurantPrintRoute.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', branchId: 'branch', registeredPrinterId: { not: null } },
      select: { id: true },
    });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('allows deliberate explicit null and empty clearing of registered routing', async () => {
    db.restaurantPrintRoute.findMany.mockResolvedValue([{ id: 'existing' }]);
    await replace([{ ...route, registeredPrinterId: null }]);
    expect(
      db.restaurantPrintRoute.createMany.mock.calls[0][0].data[0].registeredPrinterId
    ).toBeNull();
    await replace([]);
    expect(db.restaurantPrintRoute.deleteMany).toHaveBeenCalledTimes(2);
    expect(db.restaurantPrintRoute.createMany).toHaveBeenCalledOnce();
  });
  it('keeps legacy raw-only configuration compatible when no bindings exist', async () => {
    const legacy = { ...route };
    delete legacy.registeredPrinterId;
    await replace([legacy]);
    expect(db.restaurantPrinter.findMany).not.toHaveBeenCalled();
    expect(db.restaurantPrintRoute.createMany.mock.calls[0][0].data[0]).toMatchObject({
      printerId: route.printerId,
      registeredPrinterId: null,
    });
  });
});

it('rechecks tenant, branch, address and active bridge for a newly enqueued registered snapshot', async () => {
  expect(
    await registeredRouteAvailable(
      db as unknown as Prisma.TransactionClient,
      'org',
      'branch',
      route
    )
  ).toBe(true);
  expect(db.restaurantPrinter.findFirst).toHaveBeenCalledWith({
    where: {
      id: 'printer',
      organizationId: 'org',
      branchId: 'branch',
      address: route.printerId,
      retiredAt: null,
      branch: { is: { active: true } },
      bridge: {
        is: {
          organizationId: 'org',
          branchId: 'branch',
          kind: 'PRINT_BRIDGE',
          status: 'ACTIVE',
          revokedAt: null,
        },
      },
    },
    select: { id: true },
  });
  db.restaurantPrinter.findFirst.mockResolvedValue(null);
  expect(
    await registeredRouteAvailable(
      db as unknown as Prisma.TransactionClient,
      'org',
      'branch',
      route
    )
  ).toBe(false);
});

describe('atomic routing expectations', () => {
  const config = { branchId: 'branch', routes: [route] };
  const guarded = (expected = config, routes: PrintRoute[] = []) =>
    replacePrintRoutesInTransaction(
      db as unknown as Prisma.TransactionClient,
      'org',
      { branchId: 'branch', routes },
      expected
    );
  it('checks the complete baseline after locking and before replacing even with an empty save', async () => {
    db.restaurantPrintRoute.findMany
      .mockResolvedValueOnce([route])
      .mockResolvedValueOnce([{ id: 'prior' }]);
    await guarded();
    expect(db.restaurantPrintRoute.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: 'org', branchId: 'branch' },
      orderBy: { createdAt: 'asc' },
      select: {
        documentType: true,
        stationId: true,
        printerId: true,
        registeredPrinterId: true,
        enabled: true,
      },
    });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.restaurantPrintRoute.findMany.mock.invocationCallOrder[0]
    );
    expect(db.restaurantPrintRoute.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.restaurantPrintRoute.deleteMany.mock.invocationCallOrder[0]
    );
    expect(db.restaurantPrintRoute.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', branchId: 'branch' },
    });
  });
  it.each(
    [
      [],
      [{ ...route, enabled: false }],
      [{ ...route, printerId: 'other' }],
      [{ ...route, registeredPrinterId: 'other' }],
      [{ ...route, stationId: 'station' }],
    ].map((current) => ({ current }))
  )('rejects changed saved configuration without deleting any rows: %j', async ({ current }) => {
    db.restaurantPrintRoute.findMany.mockResolvedValue(current);
    await expect(guarded()).rejects.toMatchObject({ code: 'REFRESH_REQUIRED', status: 409 });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
    expect(db.restaurantPrintRoute.createMany).not.toHaveBeenCalled();
  });
  it('does not confuse an empty expected baseline with no guard', async () => {
    db.restaurantPrintRoute.findMany.mockResolvedValue([route]);
    await expect(guarded({ branchId: 'branch', routes: [] })).rejects.toMatchObject({
      code: 'REFRESH_REQUIRED',
    });
    expect(db.restaurantPrintRoute.deleteMany).not.toHaveBeenCalled();
  });
  it('rejects a different expected branch even for direct callers', async () => {
    db.restaurantPrintRoute.findMany.mockResolvedValue([route]);
    await expect(guarded({ ...config, branchId: 'other' })).rejects.toMatchObject({
      code: 'REFRESH_REQUIRED',
    });
  });
  it('normalizes whitespace and distinct-scope ordering without mutating payload order', () => {
    const other = { ...route, documentType: 'BAR_TICKET' as const, stationId: 'station' };
    const first = {
      branchId: ' branch ',
      routes: [{ ...route, printerId: ' tcp://printer:9100 ' }, other],
    };
    const before = JSON.stringify(first);
    expect(samePrintRoutingConfig(first, { branchId: 'branch', routes: [other, route] })).toBe(
      true
    );
    expect(JSON.stringify(first)).toBe(before);
    expect(
      samePrintRoutingConfig(
        { branchId: 'branch', routes: [route, { ...route, printerId: 'other' }] },
        { branchId: 'branch', routes: [{ ...route, printerId: 'other' }, route] }
      )
    ).toBe(false);
  });
  it('accepts optional strict guards, rejecting cross-branch, extra keys and ambiguous destination ownership', () => {
    expect(PrintRoutingRequestSchema.safeParse(config).success).toBe(true);
    expect(PrintRoutingRequestSchema.safeParse({ ...config, expectedConfig: config }).success).toBe(
      true
    );
    expect(
      PrintRoutingRequestSchema.safeParse({
        ...config,
        expectedConfig: { ...config, branchId: 'other' },
      }).success
    ).toBe(false);
    expect(
      PrintRoutingRequestSchema.safeParse({ ...config, expectedConfig: { ...config, extra: true } })
        .success
    ).toBe(false);
    expect(ExpectedPrintDestinationSchema.safeParse({ printerId: 'raw' }).success).toBe(false);
    expect(
      ExpectedPrintDestinationSchema.safeParse({
        printerId: 'raw',
        registeredPrinterId: null,
        extra: true,
      }).success
    ).toBe(false);
    expect(
      ExpectedPrintDestinationSchema.parse({ printerId: ' raw ', registeredPrinterId: null })
    ).toEqual({ printerId: 'raw', registeredPrinterId: null });
  });
});
