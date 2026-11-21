// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PlatformJobType } from '@/generated/prisma/client';
import type { PlatformIdentity } from '@/lib/platform/auth';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase = testDatabaseUrl ? describe : describe.skip;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;

const suffix = randomUUID();
const retryAt = new Date('2098-01-01');
const priorReason = 'Original scheduling reason from the legacy job.';
const retryReason = 'Confirmed retention schedule and authorized the retry.';
const actor: PlatformIdentity = {
  id: `retry-admin-${suffix}`,
  name: 'Retry administrator',
  email: 'retry-admin@example.test',
  role: 'SUPER_ADMIN',
  sessionId: `retry-session-${suffix}`,
  expiresAt: new Date('2099-01-01'),
  mfaEnabled: true,
};
const request = new Request('http://platform.localhost/api/platform/control', { method: 'POST' });
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let executePlatformCommand: typeof import('./commands').executePlatformCommand;

async function failedJob(
  type: PlatformJobType,
  requestedById: string | null,
  organizationId?: string
) {
  return withPlatformDb((db) =>
    db.platformJob.create({
      data: {
        type,
        organizationId,
        requestedById,
        status: 'FAILED',
        attempts: 3,
        error: 'Failed',
        payload: { reason: priorReason, reference: 'fixture' },
      },
    })
  );
}

const retry = (id: string, identity = actor, reason?: string) =>
  executePlatformCommand(identity, 'job.retry', { id, reason }, request);

const readJob = (id: string) =>
  withPlatformDb((db) => db.platformJob.findUniqueOrThrow({ where: { id } }));

describeIfDatabase('DEV-805 platform purge retries', () => {
  beforeAll(async () => {
    ({ withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    ({ executePlatformCommand } = await import('./commands'));
    // Workers on the shared test database use PostgreSQL's clock to claim jobs.
    // Keep these requeued fixtures out of their claim window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(retryAt);
  });

  afterAll(async () => {
    vi.useRealTimers();
    const { db } = await import('@/lib/db');
    await db.$disconnect();
  });

  it('attributes the requeued legacy purge to the retrying admin and leaves retained data in place', async () => {
    const organizationId = `retry-org-${suffix}`;
    const purgeScheduledAt = new Date('2099-01-01');
    const original = await withPlatformDb(async (db) => {
      await db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          displayName: 'Purge retry fixture',
          legalName: 'Purge retry fixture',
          status: 'PURGING',
          purgeScheduledAt,
        },
      });
      return db.auditLog.create({
        data: { organizationId, source: 'AUTH', category: 'AUTH', action: 'login' },
      });
    });
    const job = await failedJob('PURGE_DATA', null, organizationId);

    await retry(job.id, actor, `  ${retryReason}  `);

    expect(await readJob(job.id)).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      requestedById: actor.id,
      scheduledAt: retryAt,
      payload: { reason: retryReason, reference: 'fixture' },
    });
    await withPlatformDb(async (db) => {
      expect(
        await db.platformAuditLog.findFirstOrThrow({
          where: { action: 'job.retry', targetId: job.id },
        })
      ).toMatchObject({
        actorPlatformUserId: actor.id,
        organizationId,
        success: true,
        reason: retryReason,
        before: { status: 'FAILED', requestedById: null },
        after: { status: 'QUEUED', requestedById: actor.id, reason: retryReason },
      });
      expect(
        await db.organization.findUniqueOrThrow({ where: { id: organizationId } })
      ).toMatchObject({
        status: 'PURGING',
        purgeScheduledAt,
      });
      expect(await db.auditLog.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    });
  });

  it.each([undefined, '  too short  ', 'x'.repeat(501)])(
    'refuses a missing or invalid reason before adopting a legacy purge (%s)',
    async (reason) => {
      const job = await failedJob('PURGE_DATA', null);

      await expect(retry(job.id, actor, reason)).rejects.toMatchObject({
        issues: expect.arrayContaining([expect.objectContaining({ path: ['reason'] })]),
      });
      expect(await readJob(job.id)).toMatchObject({
        status: 'FAILED',
        attempts: 3,
        requestedById: null,
        payload: { reason: priorReason, reference: 'fixture' },
      });
    }
  );

  it('requires lifecycle security permission when supplying a missing purge requester', async () => {
    const job = await failedJob('PURGE_DATA', null);

    await expect(retry(job.id, { ...actor, role: 'OPERATIONS' })).rejects.toMatchObject({
      status: 403,
    });
    expect(await readJob(job.id)).toMatchObject({ status: 'FAILED', requestedById: null });
  });

  it('keeps the original requester on a purge and leaves unrelated retries unattributed', async () => {
    const purge = await failedJob('PURGE_DATA', `original-${suffix}`);
    const unrelated = await failedJob('EXPORT_DATA', null);

    await retry(purge.id, { ...actor, role: 'OPERATIONS' });
    await retry(unrelated.id, { ...actor, role: 'OPERATIONS' });

    expect(await readJob(purge.id)).toMatchObject({
      status: 'QUEUED',
      requestedById: purge.requestedById,
      payload: { reason: priorReason, reference: 'fixture' },
    });
    expect(await readJob(unrelated.id)).toMatchObject({ status: 'QUEUED', requestedById: null });
  });
});
