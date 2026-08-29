import type { PrintBridgeAdapter, PrintJob, PrintResult, PrintRoutingConfig } from './contract';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { renderEscPos } from './esc-pos';
import { resolvePrintRoute } from './routing';

type PrintDb = Pick<ScopedDb, '$executeRawUnsafe' | 'restaurantPrintJob'>;

export class PrintBridgeService {
  constructor(
    private readonly adapter: PrintBridgeAdapter,
    private readonly db: PrintDb
  ) {}

  async submit(
    organizationId: string,
    config: PrintRoutingConfig,
    job: PrintJob
  ): Promise<PrintResult> {
    if (job.branchId !== config.branchId)
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
    if (prior?.status === 'PRINTED') {
      return {
        status: 'PRINTED',
        printerId: prior.printerId!,
        bytes: prior.byteCount!,
        replayed: true,
      };
    }
    if (!prior) {
      await this.db.restaurantPrintJob.create({
        data: {
          organizationId,
          branchId: job.branchId,
          stationId: job.stationId,
          idempotencyKey: job.idempotencyKey,
          documentType: job.document.type,
          document: job.document,
        },
      });
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
    const delivery = await this.adapter.send(route.printerId, bytes);
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
