// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgePrintJob, claimNextPrintJob } from './service';

if (!process.env.TEST_DATABASE_URL) throw new Error('Disposable TEST_DATABASE_URL required.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const org = `claim-${randomUUID()}`;
const otherOrg = `other-${org}`;
const branch = `branch-${org}`;
const sibling = `sibling-${org}`;
const now = new Date('2026-09-05T12:00:00Z');
let tenancy: typeof import('@/lib/tenancy/scoped-db');
const document = {
  type: 'BAR_TICKET',
  reference: 'KOT 1',
  title: 'BAR',
  createdAt: now.toISOString(),
  lines: [{ quantity: 1, label: 'Soda' }],
};
const run = <T>(fn: (db: import('@/lib/tenancy/scoped-db').ScopedDb) => Promise<T>) =>
  tenancy.withTenantDb(org, fn);
const claim = (device = 'device-a', at = now) =>
  run((db) => claimNextPrintJob(db, branch, device, at));
const ack = (jobId: string, claimToken: string, extra = {}) =>
  run((db) =>
    acknowledgePrintJob(db, {
      branchId: branch,
      deviceId: 'device-a',
      jobId,
      claimToken,
      status: 'PRINTED',
      now,
      ...extra,
    })
  );

describe('durable claim authorization', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb((db) =>
      db.organization.createMany({
        data: [org, otherOrg].map((id) => ({ id, slug: id, legalName: id, displayName: id })),
      })
    );
    await run((db) =>
      db.restaurantBranch.createMany({
        data: [branch, sibling].map((id) => ({ id, organizationId: org, name: id })),
      })
    );
  });
  beforeEach(async () => {
    await run((db) => db.restaurantPrintJob.deleteMany({}));
    await run((db) =>
      db.restaurantPrintJob.create({
        data: {
          organizationId: org,
          branchId: branch,
          idempotencyKey: randomUUID(),
          documentType: 'BAR_TICKET',
          document,
          printerId: 'printer-a',
        },
      })
    );
  });
  afterAll(async () => {
    if (tenancy)
      await tenancy.withPlatformDb((db) =>
        db.organization.deleteMany({ where: { id: { in: [org, otherOrg] } } })
      );
  });
  it('rejects acknowledgement of an unclaimed job', async () => {
    const job = await run((db) => db.restaurantPrintJob.findFirstOrThrow());
    expect(await ack(job.id, '0'.repeat(64))).toEqual({ acknowledged: false, replayed: false });
    expect((await run((db) => db.restaurantPrintJob.findFirstOrThrow())).status).toBe('PENDING');
  });
  it('rejects a different authenticated device even with the current token', async () => {
    const job = (await claim())!;
    expect(await ack(job.id, job.claimToken, { deviceId: 'device-b' })).toEqual({
      acknowledged: false,
      replayed: false,
    });
    expect(await ack(job.id, job.claimToken)).toEqual({ acknowledged: true, replayed: false });
  });
  it('rejects sibling branch and cross-tenant acknowledgements', async () => {
    const job = (await claim())!;
    expect(await ack(job.id, job.claimToken, { branchId: sibling })).toMatchObject({
      acknowledged: false,
    });
    expect(
      await tenancy.withTenantDb(otherOrg, (db) =>
        acknowledgePrintJob(db, {
          branchId: branch,
          deviceId: 'device-a',
          jobId: job.id,
          claimToken: job.claimToken,
          status: 'PRINTED',
          now,
        })
      )
    ).toMatchObject({ acknowledged: false });
  });
  it('rejects expired claims at the exact lease boundary and never reclaims uncertain bytes', async () => {
    const job = (await claim())!;
    expect(
      await ack(job.id, job.claimToken, { now: new Date(now.getTime() + 30_000) })
    ).toMatchObject({ acknowledged: false });
    expect(await claim('device-b', new Date(now.getTime() + 60_000))).toBeNull();
    expect((await run((db) => db.restaurantPrintJob.findFirstOrThrow())).attemptCount).toBe(1);
  });
  it('rejects tokens for a previous attempt and tampered tokens', async () => {
    const job = (await claim())!;
    expect(await ack(job.id, 'f'.repeat(64))).toMatchObject({ acknowledged: false });
    await run((db) =>
      db.restaurantPrintJob.update({
        where: { id: job.id },
        data: { attemptCount: { increment: 1 } },
      })
    );
    expect(await ack(job.id, job.claimToken)).toMatchObject({ acknowledged: false });
  });
  it('accepts concurrent matching acknowledgements idempotently and rejects status changes', async () => {
    const job = (await claim())!;
    const results = await Promise.all([ack(job.id, job.claimToken), ack(job.id, job.claimToken)]);
    expect(results.every((r) => r.acknowledged)).toBe(true);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await ack(job.id, job.claimToken, { status: 'OFFLINE' })).toMatchObject({
      acknowledged: false,
    });
    expect(await ack(job.id, job.claimToken, { deviceId: 'device-b' })).toMatchObject({
      acknowledged: false,
    });
  });
  it('holds OFFLINE outcomes without retrying or rerouting them', async () => {
    const job = (await claim())!;
    expect(await ack(job.id, job.claimToken, { status: 'OFFLINE' })).toEqual({
      acknowledged: true,
      replayed: false,
    });
    expect(await ack(job.id, job.claimToken, { status: 'OFFLINE' })).toEqual({
      acknowledged: true,
      replayed: true,
    });
    expect(await claim('device-b', new Date(now.getTime() + 60_000))).toBeNull();
    expect((await run((db) => db.restaurantPrintJob.findFirstOrThrow())).printerId).toBe(
      'printer-a'
    );
  });
  it('lets only one concurrent claimant obtain bytes', async () => {
    const jobs = await Promise.all([claim(), claim('device-b')]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
  });
});
