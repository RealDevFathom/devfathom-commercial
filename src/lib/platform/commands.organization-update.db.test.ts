/**
 * The deployment-mode check and write must be serialized against PostgreSQL.
 * This recreates the stale-update race: an unchanged DEDICATED request runs
 * alongside a DEDICATED-to-SHARED transition while provisioning is disabled.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlatformIdentity } from '@/lib/platform/auth';
import { db } from '@/lib/db';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

import { executePlatformCommand } from './commands';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(4).toString('hex');
const organizationId = `org_mode_race_${suffix}`;
const actor = {
  id: `operator_mode_race_${suffix}`,
  role: 'SUPER_ADMIN',
} as PlatformIdentity;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

describeIfDatabase('organization.update deployment-mode concurrency', () => {
  beforeAll(async () => {
    delete process.env.VERCEL_ACCESS_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_ORG_ID;
    await withPlatformDb((tx) =>
      tx.organization.create({
        data: {
          id: organizationId,
          slug: `mode-race-${suffix}`,
          legalName: 'Deployment mode race test',
          displayName: 'Deployment mode race test',
          deploymentMode: 'DEDICATED',
        },
      })
    );
  });

  afterAll(async () => {
    if (TEST_DATABASE_URL) {
      await withPlatformDb(async (tx) => {
        await tx.platformAuditLog.deleteMany({ where: { targetId: organizationId } });
        await tx.organization.deleteMany({ where: { id: organizationId } });
      });
      await db.$disconnect();
    }
  });

  it('cannot restore dedicated from a stale unchanged request while switching to shared', async () => {
    const update = (deploymentMode: 'DEDICATED' | 'SHARED') =>
      executePlatformCommand(
        actor,
        'organization.update',
        { id: organizationId, deploymentMode },
        request
      );

    const results = await Promise.allSettled([update('DEDICATED'), update('SHARED')]);

    // The transition to SHARED must always succeed; only the stale DEDICATED
    // request may be rejected after it acquires the row lock.
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    if (results[0].status === 'rejected') {
      expect(results[0].reason).toMatchObject({
        message: expect.stringContaining('Dedicated provisioning is unavailable'),
        status: 400,
      });
    }
    const stored = await withPlatformDb((tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { deploymentMode: true },
      })
    );
    expect(stored.deploymentMode).toBe('SHARED');
    expect(
      await withPlatformDb((tx) =>
        tx.platformJob.count({
          where: { organizationId, type: 'PROVISION_DEDICATED' },
        })
      )
    ).toBe(0);
  });
});
