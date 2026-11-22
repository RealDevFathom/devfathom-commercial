import 'server-only';

import { Prisma, type PlatformJob, type PrismaClient } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

export type JobResult = Record<string, unknown>;
const RETRY_BASE_MS = 30_000;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function claimJob(resetJobId?: string): Promise<PlatformJob | null> {
  return withPlatformDb(async (db) => {
    const candidates = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "platform_jobs"
      WHERE "status" = 'QUEUED'
        AND "scheduledAt" <= NOW()
        ${resetJobId === undefined ? Prisma.empty : Prisma.sql`AND "id" = ${resetJobId} AND "type" = 'password.reset.request.v1'`}
      ORDER BY ("type" = 'password.reset.request.v1') ASC, "scheduledAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const id = candidates[0]?.id;
    if (!id) return null;
    return db.platformJob.update({
      where: { id },
      data: {
        status: 'RUNNING',
        attempts: { increment: 1 },
        startedAt: new Date(),
        finishedAt: null,
        error: null,
      },
    });
  });
}

async function canSettleJob(db: PrismaClient, job: PlatformJob): Promise<boolean> {
  if (job.type === 'PASSWORD_RESET_REQUEST_V1') {
    // A slow provider can outlive the worker lease. Only the current claim may
    // scrub the payload or reschedule this row after a recovery or cancellation.
    const current = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM platform_jobs
      WHERE id = ${job.id} AND status = 'RUNNING' AND attempts = ${job.attempts}
      FOR UPDATE
    `);
    return current.length === 1;
  }
  const current = await db.platformJob.findUnique({
    where: { id: job.id },
    select: { status: true },
  });
  return !!current && current.status !== 'CANCELLED';
}

async function completeJob(job: PlatformJob, result: JobResult): Promise<void> {
  await withPlatformDb(async (db) => {
    if (!(await canSettleJob(db, job))) return;
    await db.platformJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        ...(job.type === 'PASSWORD_RESET_REQUEST_V1' ? { payload: Prisma.DbNull } : {}),
        result: json(result),
        error: null,
        finishedAt: new Date(),
      },
    });
  });
}

async function failJob(
  job: PlatformJob,
  error: unknown,
  permanent: boolean
): Promise<'retried' | 'failed'> {
  const message = error instanceof Error ? error.message : 'Unknown worker error.';
  // An export over its size cap or build time limit stays over it: retrying only repeats the work.
  const retry = !permanent && job.attempts < job.maxAttempts;
  await withPlatformDb(async (db) => {
    if (!(await canSettleJob(db, job))) return;
    await db.platformJob.update({
      where: { id: job.id },
      data: retry
        ? {
            status: 'QUEUED',
            scheduledAt: new Date(
              Date.now() + Math.min(RETRY_BASE_MS * 2 ** Math.max(0, job.attempts - 1), 30 * 60_000)
            ),
            startedAt: null,
            error: message.slice(0, 2_000),
          }
        : {
            status: 'FAILED',
            ...(job.type === 'PASSWORD_RESET_REQUEST_V1' ? { payload: Prisma.DbNull } : {}),
            error: message.slice(0, 2_000),
            finishedAt: new Date(),
          },
    });
  });
  return retry ? 'retried' : 'failed';
}

export async function runClaimedJob(
  job: PlatformJob,
  execute: (job: PlatformJob) => Promise<JobResult>,
  isPermanent?: (error: unknown) => boolean
): Promise<'succeeded' | 'retried' | 'failed'> {
  try {
    await completeJob(job, await execute(job));
    return 'succeeded';
  } catch (error) {
    return failJob(job, error, isPermanent?.(error) ?? false);
  }
}
