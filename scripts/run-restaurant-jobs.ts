import 'dotenv/config';
import { hostname } from 'node:os';

import { runRestaurantWorker, runRestaurantWorkerTick } from '@/lib/restaurant/job-runner';

/**
 * `restaurant:jobs` — the restaurant background worker entry point (M7-L2).
 *
 * Default: a daemon loop that drains the tenant scheduler queue + transactional
 * outbox across organizations until SIGINT/SIGTERM, then STOPS GRACEFULLY — the
 * first signal aborts, the runtime finishes the current claim (releasing an
 * unstarted job back to QUEUED, per scheduler.ts), and exits; a second signal
 * forces exit. `--once` runs a single tick and exits (the CI / cron shape,
 * mirroring `scripts/process-platform-jobs.ts`).
 *
 * Flags: `--once`, `--worker-id=<id>`, `--poll-ms=<n>`, `--max-ticks=<n>`,
 * `--max-jobs-per-org=<n>`, `--max-outbox-per-org=<n>`.
 */

type ParsedArgs = {
  once: boolean;
  workerId: string;
  pollIntervalMs: number;
  maxTicks?: number;
  maxJobsPerOrg?: number;
  maxOutboxPerOrg?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);
  const rawValue = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const found = args.find((value) => value.startsWith(prefix));
    return found?.slice(prefix.length);
  };
  const positiveInt = (name: string): number | undefined => {
    const raw = rawValue(name);
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  return {
    once: hasFlag('once'),
    workerId: rawValue('worker-id') ?? `restaurant-jobs@${hostname()}:${process.pid}`,
    pollIntervalMs: positiveInt('poll-ms') ?? 1_000,
    maxTicks: positiveInt('max-ticks'),
    maxJobsPerOrg: positiveInt('max-jobs-per-org'),
    maxOutboxPerOrg: positiveInt('max-outbox-per-org'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.once) {
    const result = await runRestaurantWorkerTick({
      workerId: args.workerId,
      maxJobsPerOrg: args.maxJobsPerOrg,
      maxOutboxPerOrg: args.maxOutboxPerOrg,
    });
    console.log(JSON.stringify({ mode: 'once', ...result }));
    return;
  }

  const controller = new AbortController();
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      console.error(`[restaurant:jobs] second ${signal} — forcing exit`);
      process.exit(1);
    }
    stopping = true;
    console.error(
      `[restaurant:jobs] ${signal} received — draining; will stop after the current claim`
    );
    controller.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const result = await runRestaurantWorker({
    workerId: args.workerId,
    signal: controller.signal,
    pollIntervalMs: args.pollIntervalMs,
    maxTicks: args.maxTicks,
    maxJobsPerOrg: args.maxJobsPerOrg,
    maxOutboxPerOrg: args.maxOutboxPerOrg,
    onTick: (tick) => {
      const outboxTouched = tick.outbox.dispatched + tick.outbox.retried + tick.outbox.dead;
      if (tick.jobs.claimed > 0 || outboxTouched > 0 || tick.recovered > 0) {
        console.log(JSON.stringify({ mode: 'tick', ...tick }));
      }
    },
  });
  console.log(JSON.stringify({ mode: 'loop', ...result }));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
