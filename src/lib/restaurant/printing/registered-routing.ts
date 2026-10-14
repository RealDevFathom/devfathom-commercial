import 'server-only';
import type { Prisma } from '@/generated/prisma/client';
import type { PrintRoute, PrintRoutingConfig } from './contract';
import { samePrintRoutingConfig } from './routing';
import { TicketPrintSnapshotSchema } from './contract';

/** Eligibility is identical for availability and server-derived ticket snapshots. */
function registeredPrinterScope(
  organizationId: string,
  branchId: string,
  route: PrintRoute
): Prisma.RestaurantPrinterWhereInput {
  return {
    id: route.registeredPrinterId ?? undefined,
    organizationId,
    branchId,
    address: route.printerId,
    branch: { is: { active: true } },
    bridge: {
      is: { organizationId, branchId, kind: 'PRINT_BRIDGE', status: 'ACTIVE', revokedAt: null },
    },
  };
}

/** Validate new snapshots only; replayed jobs keep their original registry and target. */
export async function registeredRouteAvailable(
  tx: Pick<Prisma.TransactionClient, 'restaurantPrinter'>,
  organizationId: string,
  branchId: string,
  route: PrintRoute
) {
  if (!route.registeredPrinterId) return true;
  return (
    (await tx.restaurantPrinter.findFirst({
      where: registeredPrinterScope(organizationId, branchId, route),
      select: { id: true },
    })) !== null
  );
}

/** A new registered ticket snapshots one eligible inventory observation. */
export async function registeredRouteTicketSnapshot(
  tx: Pick<Prisma.TransactionClient, 'restaurantPrinter'>,
  organizationId: string,
  branchId: string,
  route: PrintRoute
) {
  if (!route.registeredPrinterId) return null;
  const printer = await tx.restaurantPrinter.findFirst({
    where: registeredPrinterScope(organizationId, branchId, route),
    select: { id: true, paperWidthMm: true },
  });
  if (!printer) return null;
  const snapshot = TicketPrintSnapshotSchema.safeParse({ paperWidthMm: printer.paperWidthMm });
  return snapshot.success ? snapshot.data : null;
}

export class PrintRoutingError extends Error {
  constructor(
    readonly code: 'INVALID_ROUTE' | 'REFRESH_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'PrintRoutingError';
  }
  get status() {
    return this.code === 'REFRESH_REQUIRED' ? 409 : 400;
  }
}

/** Caller owns the authorized tenant transaction. Validate before replacing any rows. */
export async function replacePrintRoutesInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  config: PrintRoutingConfig,
  expectedConfig?: PrintRoutingConfig
) {
  // Every configuration writer uses the same branch row lock, including empty saves.
  const branches = await tx.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT id, active FROM restaurant_branches
    WHERE "organizationId" = ${organizationId} AND id = ${config.branchId}
    FOR UPDATE`;
  if (!branches[0]?.active)
    throw new PrintRoutingError('INVALID_ROUTE', 'Active branch not found.');
  if (expectedConfig) {
    const routes = await tx.restaurantPrintRoute.findMany({
      where: { organizationId, branchId: config.branchId },
      orderBy: { createdAt: 'asc' },
      select: {
        documentType: true,
        stationId: true,
        printerId: true,
        registeredPrinterId: true,
        enabled: true,
      },
    });
    if (!samePrintRoutingConfig({ branchId: config.branchId, routes }, expectedConfig)) {
      throw new PrintRoutingError(
        'REFRESH_REQUIRED',
        'Saved printer routing changed. Refresh and review before saving.'
      );
    }
  }
  const prior = await tx.restaurantPrintRoute.findMany({
    where: { organizationId, branchId: config.branchId, registeredPrinterId: { not: null } },
    select: { id: true },
  });
  if (prior.length && config.routes.some((route) => route.registeredPrinterId === undefined)) {
    throw new PrintRoutingError(
      'REFRESH_REQUIRED',
      'Refresh printer routing before saving registered routes.'
    );
  }
  const stations = await tx.restaurantKitchenStation.findMany({
    where: { organizationId, branchId: config.branchId, active: true },
    select: { id: true },
  });
  const stationIds = new Set(stations.map((station) => station.id));
  if (config.routes.some((route) => route.stationId && !stationIds.has(route.stationId))) {
    throw new PrintRoutingError(
      'INVALID_ROUTE',
      'A print route references a station outside this branch.'
    );
  }
  const ids = [
    ...new Set(
      config.routes.flatMap((route) =>
        route.registeredPrinterId ? [route.registeredPrinterId] : []
      )
    ),
  ];
  if (ids.length) {
    const printers = await tx.restaurantPrinter.findMany({
      where: {
        organizationId,
        branchId: config.branchId,
        id: { in: ids },
        bridge: {
          is: {
            organizationId,
            branchId: config.branchId,
            kind: 'PRINT_BRIDGE',
            status: 'ACTIVE',
            revokedAt: null,
          },
        },
      },
      select: { id: true, address: true },
    });
    const addresses = new Map(printers.map((printer) => [printer.id, printer.address]));
    if (
      config.routes.some(
        (route) =>
          route.registeredPrinterId && addresses.get(route.registeredPrinterId) !== route.printerId
      )
    ) {
      throw new PrintRoutingError(
        'INVALID_ROUTE',
        'A registered printer is unavailable or its address does not match this route.'
      );
    }
  }
  await tx.restaurantPrintRoute.deleteMany({
    where: { organizationId, branchId: config.branchId },
  });
  if (config.routes.length) {
    await tx.restaurantPrintRoute.createMany({
      data: config.routes.map((route) => ({
        ...route,
        registeredPrinterId: route.registeredPrinterId ?? null,
        organizationId,
        branchId: config.branchId,
      })),
    });
  }
}
