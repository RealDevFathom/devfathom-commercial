import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ClaimedPrintJob,
  PrintBridgeAdapter,
  PrintEnqueueResult,
  PrintJob,
  PrintResult,
  PrintRoutingConfig,
} from './contract';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PrintDocumentSchema, RawPrintValidationError, validateRawPrintDocument } from './contract';
import { renderEscPos } from './esc-pos';
import { resolvePrintRoute } from './routing';
import { registeredRouteAvailable } from './registered-routing';

const CLAIM_LEASE_MS = 30_000;

type PrintDb = Pick<ScopedDb, '$executeRawUnsafe' | 'restaurantPrintJob' | 'restaurantPrinter'>;

function renderRawDocument(document: unknown): Uint8Array {
  try {
    return renderEscPos(validateRawPrintDocument(document));
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

  async enqueue(organizationId: string, config: PrintRoutingConfig, job: PrintJob): Promise<PrintEnqueueResult> {
    return this.enqueueJob(organizationId, config, job, false);
  }

  private async enqueueJob(
    organizationId: string,
    config: PrintRoutingConfig,
    job: PrintJob,
    synchronous: boolean
  ): Promise<PrintEnqueueResult> {
    if (job.branchId !== config.branchId) {
      return { status: 'NO_PRINTER', retryable: true, replayed: false };
    }
    const route = resolvePrintRoute(config.routes, job);
    if (!route) return { status: 'NO_PRINTER', retryable: true, replayed: false };

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
    if (synchronous && (route.registeredPrinterId || prior?.registeredPrinterId)) {
      throw new Error('Registered printers require authenticated bridge delivery.');
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
      return { status: 'QUEUED', printerId: prior.printerId ?? route.printerId, replayed: true };
    }
    // Typed callers are not a runtime validation boundary. Validate before any
    // new job is persisted, using the same raw renderer as the claim path.
    if (!(await registeredRouteAvailable(this.db, organizationId, job.branchId, route))) {
      return { status: 'NO_PRINTER', retryable: true, replayed: false };
    }
    renderRawDocument(job.document);
    await this.db.restaurantPrintJob.create({
      data: {
        organizationId,
        branchId: job.branchId,
        stationId: job.stationId,
        idempotencyKey: job.idempotencyKey,
        documentType: job.document.type,
        document: job.document,
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
    const bytes = renderEscPos(job.document);
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
            bridge: { is: { id: deviceId, branchId, kind: 'PRINT_BRIDGE', status: 'ACTIVE', revokedAt: null } },
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
  const document = PrintDocumentSchema.parse(current.document);
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
