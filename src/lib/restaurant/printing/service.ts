import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ClaimedPrintJob,
  ExpectedPrintDestination,
  PrintBridgeAdapter,
  PrintEnqueueResult,
  PrintJob,
  PrintResult,
  PrintRoutingConfig,
} from './contract';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  StoredPrintDocumentSchema,
  RawPrintValidationError,
  validateRawPrintDocument,
  validateRawStoredPrintDocument,
} from './contract';
import { renderEscPos } from './esc-pos';
import { resolvePrintRoute } from './routing';
import {
  registeredRouteAvailable,
  registeredRouteTicketSnapshot,
  PrintRoutingError,
} from './registered-routing';

const CLAIM_LEASE_MS = 30_000;

type PrintDb = Pick<ScopedDb, '$executeRawUnsafe' | 'restaurantPrintJob' | 'restaurantPrinter'> &
  Partial<Pick<ScopedDb, '$queryRaw' | 'restaurantPrintRoute'>>;

function renderRawDocument(document: unknown): Uint8Array {
  try {
    return renderEscPos(validateRawStoredPrintDocument(document));
  } catch (error) {
    if (error instanceof RawPrintValidationError) throw error;
    // Never expose receipt contents or parser diagnostics to the bridge/logs.
    throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  }
}

export class PrintBridgeService {
  private readonly adapter: PrintBridgeAdapter | null;
  private readonly db: PrintDb;

  constructor(db: PrintDb);
  constructor(adapter: PrintBridgeAdapter, db: PrintDb);
  constructor(adapterOrDb: PrintBridgeAdapter | PrintDb, db?: PrintDb) {
    this.adapter = db ? (adapterOrDb as PrintBridgeAdapter) : null;
    this.db = db ?? (adapterOrDb as PrintDb);
  }

  async enqueue(
    organizationId: string,
    config: PrintRoutingConfig,
    job: PrintJob,
    expectedDestination?: ExpectedPrintDestination
  ): Promise<PrintEnqueueResult> {
    return this.enqueueJob(organizationId, config, job, false, expectedDestination);
  }

  private async enqueueJob(
    organizationId: string,
    config: PrintRoutingConfig,
    job: PrintJob,
    synchronous: boolean,
    expectedDestination?: ExpectedPrintDestination
  ): Promise<PrintEnqueueResult> {
    if (job.branchId !== config.branchId) {
      return { status: 'NO_PRINTER', retryable: true, replayed: false };
    }
    let route = expectedDestination ? null : resolvePrintRoute(config.routes, job);
    if (!expectedDestination && !route)
      return { status: 'NO_PRINTER', retryable: true, replayed: false };

    await this.db.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `${organizationId}:${job.branchId}:${job.idempotencyKey}`
    );
    const key = {
      organizationId_branchId_idempotencyKey: {
        organizationId,
        branchId: job.branchId,
        idempotencyKey: job.idempotencyKey,
      },
    };
    const prior = await this.db.restaurantPrintJob.findUnique({ where: key });
    if (synchronous && (route?.registeredPrinterId || prior?.registeredPrinterId)) {
      throw new Error('Registered printers require authenticated bridge delivery.');
    }
    const matches = (destination: {
      printerId: string | null;
      registeredPrinterId?: string | null;
    }) =>
      destination.printerId === expectedDestination!.printerId &&
      (destination.registeredPrinterId ?? null) === expectedDestination!.registeredPrinterId;
    if (expectedDestination && prior && !matches(prior)) {
      throw new PrintRoutingError(
        'REFRESH_REQUIRED',
        'This print request belongs to a different destination. Refresh and review the saved routes.'
      );
    }
    if (prior?.status === 'PRINTED') {
      return {
        status: 'PRINTED',
        printerId: prior.printerId!,
        bytes: prior.byteCount!,
        replayed: true,
      };
    }
    if (prior) {
      return {
        status: 'QUEUED',
        printerId: prior.printerId ?? route?.printerId ?? expectedDestination!.printerId,
        replayed: true,
      };
    }
    if (expectedDestination) {
      if (!this.db.$queryRaw || !this.db.restaurantPrintRoute) {
        throw new Error('Guarded printing requires a transaction with routing access.');
      }
      // The HTTP caller requests READ COMMITTED. This lock conflicts with route
      // replacement and stays held through the outer transaction's commit.
      const branches = await this.db.$queryRaw<Array<{ id: string; active: boolean }>>`
        SELECT id, active FROM restaurant_branches
        WHERE "organizationId" = ${organizationId} AND id = ${job.branchId}
        FOR SHARE`;
      if (!branches[0]?.active) {
        throw new PrintRoutingError(
          'REFRESH_REQUIRED',
          'The printer branch is unavailable. Refresh the saved routes.'
        );
      }
      const routes = await this.db.restaurantPrintRoute.findMany({
        where: { organizationId, branchId: job.branchId },
        orderBy: { createdAt: 'asc' },
        select: {
          documentType: true,
          stationId: true,
          printerId: true,
          registeredPrinterId: true,
          enabled: true,
        },
      });
      route = resolvePrintRoute(routes, job);
      if (!route || !matches(route)) {
        throw new PrintRoutingError(
          'REFRESH_REQUIRED',
          'The printer destination changed. Refresh and review the saved routes.'
        );
      }
    }
    if (!route) return { status: 'NO_PRINTER', retryable: true, replayed: false };
    if (!expectedDestination && route.registeredPrinterId) {
      if (!this.db.$queryRaw)
        throw new Error('Registered printing requires a transaction with row locking.');
      // Unguarded order/receipt producers participate after prior-job replay too.
      const branches = await this.db.$queryRaw<Array<{ id: string; active: boolean }>>`
        SELECT id, active FROM restaurant_branches
        WHERE "organizationId" = ${organizationId} AND id = ${job.branchId}
        FOR SHARE`;
      if (!branches[0]?.active) return { status: 'NO_PRINTER', retryable: true, replayed: false };
    }
    // Typed callers are not a runtime validation boundary. Validate before any
    // new job is persisted, using the same raw renderer as the claim path.
    const snapshotTicket =
      !!route.registeredPrinterId &&
      (job.document.type === 'KITCHEN_TICKET' || job.document.type === 'BAR_TICKET');
    const ticketPrintSnapshot = snapshotTicket
      ? await registeredRouteTicketSnapshot(this.db, organizationId, job.branchId, route)
      : undefined;
    const available = snapshotTicket
      ? ticketPrintSnapshot !== null
      : await registeredRouteAvailable(this.db, organizationId, job.branchId, route);
    if (!available) {
      if (expectedDestination) {
        throw new PrintRoutingError(
          'REFRESH_REQUIRED',
          'The registered printer is unavailable. Refresh the saved routes.'
        );
      }
      return { status: 'NO_PRINTER', retryable: true, replayed: false };
    }
    // The public validator remains strict even for direct service callers.
    const callerDocument = validateRawPrintDocument(job.document);
    const document = ticketPrintSnapshot
      ? { ...callerDocument, ticketPrintSnapshot }
      : callerDocument;
    renderRawDocument(document);
    await this.db.restaurantPrintJob.create({
      data: {
        organizationId,
        branchId: job.branchId,
        stationId: job.stationId,
        idempotencyKey: job.idempotencyKey,
        documentType: job.document.type,
        document,
        printerId: route.printerId,
        registeredPrinterId: route.registeredPrinterId ?? null,
      },
    });
    return { status: 'QUEUED', printerId: route.printerId, replayed: false };
  }

  async submit(
    organizationId: string,
    config: PrintRoutingConfig,
    job: PrintJob
  ): Promise<PrintResult> {
    if (!this.adapter) throw new Error('A print adapter is required for synchronous delivery.');
    const key = {
      organizationId_branchId_idempotencyKey: {
        organizationId,
        branchId: job.branchId,
        idempotencyKey: job.idempotencyKey,
      },
    };
    const queued = await this.enqueueJob(organizationId, config, job, true);
    if (queued.status === 'NO_PRINTER') return queued;
    if (queued.status === 'PRINTED') {
      return {
        status: 'PRINTED',
        printerId: queued.printerId,
        bytes: queued.bytes,
        replayed: true,
      };
    }
    return this.deliver(config, job, key);
  }

  private async deliver(
    config: PrintRoutingConfig,
    job: PrintJob,
    key: {
      organizationId_branchId_idempotencyKey: {
        organizationId: string;
        branchId: string;
        idempotencyKey: string;
      };
    }
  ): Promise<PrintResult> {
    const route = resolvePrintRoute(config.routes, job);
    if (!route) {
      await this.db.restaurantPrintJob.update({
        where: key,
        data: { status: 'NO_PRINTER', attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
      });
      return { status: 'NO_PRINTER', retryable: true, replayed: false };
    }
    const bytes = renderEscPos(validateRawPrintDocument(job.document));
    const delivery = await this.adapter!.send(route.printerId, bytes);
    if (delivery === 'OFFLINE') {
      await this.db.restaurantPrintJob.update({
        where: key,
        data: {
          status: 'OFFLINE',
          printerId: route.printerId,
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
        },
      });
      return { status: 'OFFLINE', retryable: true, replayed: false };
    }

    const result = {
      status: 'PRINTED',
      printerId: route.printerId,
      bytes: bytes.length,
      replayed: false,
    } as const;
    await this.db.restaurantPrintJob.update({
      where: key,
      data: {
        status: 'PRINTED',
        printerId: route.printerId,
        byteCount: bytes.length,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        printedAt: new Date(),
      },
    });
    return result;
  }
}

// Signed proof binds the authenticated device to the persisted attempt. Keep the
// attempt timestamp unchanged on ACK so retries can verify the same proof.
function claimToken(
  job: {
    id: string;
    organizationId: string;
    branchId: string;
    attemptCount: number;
    lastAttemptAt: Date;
  },
  deviceId: string
) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required for print claims.');
  return createHmac('sha256', secret)
    .update(
      JSON.stringify([
        'restaurant-print-claim-v1',
        job.organizationId,
        job.branchId,
        job.id,
        deviceId,
        job.attemptCount,
        job.lastAttemptAt.toISOString(),
      ])
    )
    .digest('hex');
}

/**
 * Claim fresh work only. A lost response, disconnect or write-before-ACK can
 * mean bytes reached the printer. Expiry does NOT authorize physical retry;
 * attempted PENDING/OFFLINE jobs require operator reconciliation.
 */
export async function claimNextPrintJob(
  db: ScopedDb,
  branchId: string,
  deviceId: string,
  now = new Date()
): Promise<(ClaimedPrintJob & { claimToken: string }) | null> {
  const ownership = {
    OR: [
      { registeredPrinterId: null },
      {
        registeredPrinter: {
          is: {
            branchId,
            bridgeId: deviceId,
            branch: { is: { active: true } },
            bridge: {
              is: {
                id: deviceId,
                branchId,
                kind: 'PRINT_BRIDGE',
                status: 'ACTIVE',
                revokedAt: null,
              },
            },
          },
        },
      },
    ],
  } satisfies Prisma.RestaurantPrintJobWhereInput;
  const candidates = await db.restaurantPrintJob.findMany({
    where: {
      branchId,
      printerId: { not: null },
      ...ownership,
      status: 'PENDING',
      attemptCount: 0,
      lastAttemptAt: null,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10,
  });
  for (const candidate of candidates) {
    if (!candidate.printerId) continue;
    let bytes: string;
    try {
      bytes = Buffer.from(renderRawDocument(candidate.document)).toString('base64');
    } catch (error) {
      if (!(error instanceof RawPrintValidationError)) throw error;
      // OFFLINE + zero attempts + no timestamp is a pre-dispatch hold. Retain
      // the original document/route for reconciliation, and continue this batch.
      // The predicate cannot change a job already claimed by another worker.
      await db.restaurantPrintJob.updateMany({
        where: {
          id: candidate.id,
          branchId,
          registeredPrinterId: candidate.registeredPrinterId,
          printerId: candidate.printerId,
          ...ownership,
          status: 'PENDING',
          attemptCount: 0,
          lastAttemptAt: null,
        },
        data: { status: 'OFFLINE' },
      });
      continue;
    }
    const token = claimToken({ ...candidate, attemptCount: 1, lastAttemptAt: now }, deviceId);
    const claimed = await db.restaurantPrintJob.updateMany({
      where: {
        id: candidate.id,
        branchId,
        registeredPrinterId: candidate.registeredPrinterId,
        printerId: candidate.printerId,
        ...ownership,
        status: 'PENDING',
        attemptCount: 0,
        lastAttemptAt: null,
      },
      data: { lastAttemptAt: now, attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    return {
      id: candidate.id,
      printerId: candidate.printerId,
      documentType: candidate.documentType,
      bytes,
      claimToken: token,
    };
  }
  return null;
}

/** Only a live matching claim may change delivery state. No physical exactly-once guarantee. */
export async function acknowledgePrintJob(
  db: ScopedDb,
  input: {
    branchId: string;
    deviceId: string;
    jobId: string;
    claimToken: string;
    status: 'PRINTED' | 'OFFLINE';
    now?: Date;
  }
): Promise<{ acknowledged: boolean; replayed: boolean }> {
  const rejected = { acknowledged: false, replayed: false };
  if (!input.deviceId || !/^[a-f0-9]{64}$/.test(input.claimToken ?? '')) return rejected;
  const current = await db.restaurantPrintJob.findFirst({
    where: { id: input.jobId, branchId: input.branchId },
  });
  if (!current?.lastAttemptAt || current.attemptCount < 1) return rejected;
  const token = claimToken({ ...current, lastAttemptAt: current.lastAttemptAt }, input.deviceId);
  if (!timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(input.claimToken, 'hex')))
    return rejected;
  if (current.status === input.status) return { acknowledged: true, replayed: true };
  const now = input.now ?? new Date();
  const age = now.getTime() - current.lastAttemptAt.getTime();
  if (current.status !== 'PENDING' || age < 0 || age >= CLAIM_LEASE_MS) return rejected;
  const document = StoredPrintDocumentSchema.parse(current.document);
  const updated = await db.restaurantPrintJob.updateMany({
    where: {
      id: input.jobId,
      branchId: input.branchId,
      status: 'PENDING',
      attemptCount: current.attemptCount,
      lastAttemptAt: current.lastAttemptAt,
    },
    data:
      input.status === 'PRINTED'
        ? {
            status: 'PRINTED',
            byteCount: renderEscPos(document).length,
            printedAt: now,
          }
        : { status: 'OFFLINE' },
  });
  if (updated.count !== 1) {
    const replay = await db.restaurantPrintJob.findFirst({
      where: {
        id: input.jobId,
        branchId: input.branchId,
        status: input.status,
        attemptCount: current.attemptCount,
        lastAttemptAt: current.lastAttemptAt,
      },
      select: { id: true },
    });
    return replay ? { acknowledged: true, replayed: true } : rejected;
  }
  return { acknowledged: true, replayed: false };
}
