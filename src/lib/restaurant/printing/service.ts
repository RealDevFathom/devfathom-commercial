import type { PrintBridgeAdapter, PrintJob, PrintResult, PrintRoutingConfig } from './contract';
import { renderEscPos } from './esc-pos';
import { resolvePrintRoute } from './routing';

export class PrintBridgeService {
  private readonly completed = new Map<string, Extract<PrintResult, { status: 'PRINTED' }>>();
  private readonly inFlight = new Map<string, Promise<PrintResult>>();

  constructor(private readonly adapter: PrintBridgeAdapter) {}

  async submit(
    organizationId: string,
    config: PrintRoutingConfig,
    job: PrintJob
  ): Promise<PrintResult> {
    if (job.branchId !== config.branchId)
      return { status: 'NO_PRINTER', retryable: true, replayed: false };
    const replayKey = `${organizationId}:${job.branchId}:${job.idempotencyKey}`;
    const prior = this.completed.get(replayKey);
    if (prior) return { ...prior, replayed: true };

    const active = this.inFlight.get(replayKey);
    if (active) {
      const result = await active;
      return result.status === 'PRINTED' ? { ...result, replayed: true } : result;
    }

    const submission = this.deliver(config, job, replayKey);
    this.inFlight.set(replayKey, submission);
    try {
      return await submission;
    } finally {
      this.inFlight.delete(replayKey);
    }
  }

  private async deliver(
    config: PrintRoutingConfig,
    job: PrintJob,
    replayKey: string
  ): Promise<PrintResult> {
    const route = resolvePrintRoute(config.routes, job);
    if (!route) return { status: 'NO_PRINTER', retryable: true, replayed: false };
    const bytes = renderEscPos(job.document);
    const delivery = await this.adapter.send(route.printerId, bytes);
    if (delivery === 'OFFLINE') return { status: 'OFFLINE', retryable: true, replayed: false };

    const result = {
      status: 'PRINTED',
      printerId: route.printerId,
      bytes: bytes.length,
      replayed: false,
    } as const;
    this.completed.set(replayKey, result);
    return result;
  }
}
