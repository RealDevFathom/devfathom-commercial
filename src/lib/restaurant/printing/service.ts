import type {
  ClaimedPrintJob,
  PrintBridgeAdapter,
  PrintEnqueueResult,
  PrintJob,
  PrintResult,
  PrintRoutingConfig,
} from './contract';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PrintDocumentSchema } from './contract';
import { renderEscPos } from './esc-pos';
import { resolvePrintRoute } from './routing';

const CLAIM_LEASE_MS = 30_000;

type PrintDb = Pick<ScopedDb, '$executeRawUnsafe' | 'restaurantPrintJob'>;

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
    job: PrintJob
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
    await this.db.restaurantPrintJob.create({
      data: {
        organizationId,
        branchId: job.branchId,
        stationId: job.stationId,
        idempotencyKey: job.idempotencyKey,
        documentType: job.document.type,
        document: job.document,
        printerId: route.printerId,
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
    const queued = await this.enqueue(organizationId, config, job);
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

/** Atomically lease one queued job for a branch-bound bridge device. */
export async function claimNextPrintJob(
  db: ScopedDb,
  bridgeId: string,
  now = new Date()
): Promise<ClaimedPrintJob | null> {
  const leaseBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const bridge = await db.restaurantRegisteredDevice.findUnique({
    where: { id: bridgeId },
    select: { branchId: true, kind: true },
  });
  if (!bridge || bridge.kind !== 'PRINT_BRIDGE') return null;
  const candidates = await db.restaurantPrintJob.findMany({
    where: {
      branchId: bridge.branchId,
      printer: { bridgeId },
      status: { in: ['PENDING', 'OFFLINE'] },
      OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: leaseBefore } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10,
  });
  for (const candidate of candidates) {
    const claimed = await db.restaurantPrintJob.updateMany({
      where: {
        id: candidate.id,
        branchId: bridge.branchId,
        printer: { bridgeId },
        status: { in: ['PENDING', 'OFFLINE'] },
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: leaseBefore } }],
      },
      data: { lastAttemptAt: now, attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1 || !candidate.printerId) continue;
    const document = PrintDocumentSchema.parse(candidate.document);
    const printer = await db.restaurantPrinter.findFirst({
      where: { id: candidate.printerId, bridgeId },
      select: { address: true },
    });
    if (!printer) continue;
    return {
      id: candidate.id,
      printerId: candidate.printerId,
      address: printer.address,
      documentType: candidate.documentType,
      bytes: Buffer.from(renderEscPos(document)).toString('base64'),
    };
  }
  return null;
}

/** Acknowledge a claimed job without allowing a bridge to cross its bound branch. */
export async function acknowledgePrintJob(
  db: ScopedDb,
  input: {
    bridgeId: string;
    jobId: string;
    status: 'PRINTED' | 'OFFLINE';
    error?: string;
    now?: Date;
  }
): Promise<{ acknowledged: boolean; replayed: boolean }> {
  const current = await db.restaurantPrintJob.findFirst({
    where: { id: input.jobId, printer: { bridgeId: input.bridgeId } },
    select: { status: true, document: true, printerId: true },
  });
  if (!current) return { acknowledged: false, replayed: false };
  if (current.status === 'PRINTED') return { acknowledged: true, replayed: true };
  const now = input.now ?? new Date();
  const document = PrintDocumentSchema.parse(current.document);
  await db.restaurantPrintJob.update({
    where: { id: input.jobId },
    data:
      input.status === 'PRINTED'
        ? {
            status: 'PRINTED',
            byteCount: renderEscPos(document).length,
            printedAt: now,
            lastAttemptAt: now,
          }
        : { status: 'OFFLINE', lastAttemptAt: now },
  });
  if (current.printerId)
    await db.restaurantPrinter.update({
      where: { id: current.printerId },
      data: {
        status: input.status === 'PRINTED' ? 'ONLINE' : 'OFFLINE',
        lastSeenAt: now,
        lastError:
          input.status === 'OFFLINE'
            ? (input.error?.slice(0, 500) ?? 'Printer unavailable.')
            : null,
      },
    });
  return { acknowledged: true, replayed: false };
}
