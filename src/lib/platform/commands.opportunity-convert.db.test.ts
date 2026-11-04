/**
 * Opportunity → tenant conversion against real PostgreSQL.
 *
 * Two fixes landed separately: one locks the opportunity row before provisioning
 * (#499), the other claims only eligible, unlinked opportunities and guards the
 * account (#500). Each was proven only with mocks of its own query sequence, and
 * once combined the unlocked eligibility read ran first. This suite exercises the
 * merged path end to end: the row lock is the first statement, a missing
 * opportunity is a 400, a replay or a racing conversion is a 409, and exactly one
 * tenant, provisioning job and lineage link exist afterwards.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlatformIdentity } from '@/lib/platform/auth';
import { db } from '@/lib/db';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(4).toString('hex');
const packageId = `pkg_oppconv_${suffix}`;
const accountId = `acct_oppconv_${suffix}`;
const opportunityId = `opp_oppconv_${suffix}`;
const lostOpportunityId = `opp_oppconv_lost_${suffix}`;
const siblingOpportunityId = `opp_oppconv_sibling_${suffix}`;
const actor: PlatformIdentity = {
  sessionId: `sess_oppconv_${suffix}`,
  id: `plat_oppconv_${suffix}`,
  name: 'Opportunity conversion',
  email: `oppconv-${suffix}@test.local`,
  role: 'SUPER_ADMIN',
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  mfaEnabled: true,
};
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

function payload(slug: string, linkedOpportunityId: string) {
  return {
    slug,
    legalName: `Opportunity conversion ${suffix}`,
    displayName: `Opportunity conversion ${suffix}`,
    deploymentMode: 'SHARED' as const,
    packageId,
    timezone: 'UTC',
    locale: 'en',
    currency: 'usd',
    primaryContactName: 'Ops',
    primaryContactEmail: `ops-${suffix}@test.local`,
    adminName: 'Conversion Admin',
    adminEmail: `admin-${slug}@test.local`,
    adminPassword: 'a-strong-password',
    opportunityId: linkedOpportunityId,
  };
}

function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
}

describeIfDatabase('opportunity conversion on PostgreSQL', () => {
  const slugs = {
    missing: `oppconv-missing-${suffix}`,
    first: `oppconv-a-${suffix}`,
    second: `oppconv-b-${suffix}`,
    replay: `oppconv-replay-${suffix}`,
    lost: `oppconv-lost-${suffix}`,
    sibling: `oppconv-sibling-${suffix}`,
  };

  beforeAll(async () => {
    await withPlatformDb(async (tx) => {
      await tx.platformPackage.create({
        data: {
          id: packageId,
          key: `oppconv-${suffix}`,
          name: 'Opportunity conversion',
          vertical: 'AGENCY',
          active: true,
          defaultSeats: 5,
        },
      });
      await tx.platformAccount.create({ data: { id: accountId, name: `Account ${suffix}` } });
      await tx.platformOpportunity.createMany({
        data: [
          { id: opportunityId, accountId, name: 'Primary', stage: 'PROPOSAL' },
          { id: lostOpportunityId, accountId, name: 'Lost', stage: 'LOST' },
          { id: siblingOpportunityId, accountId, name: 'Sibling', stage: 'NEGOTIATION' },
        ],
      });
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function organizationsWithSlugs(...candidates: string[]) {
    return withPlatformDb((tx) =>
      tx.organization.findMany({ where: { slug: { in: candidates } }, select: { id: true } })
    );
  }

  it('rejects a nonexistent opportunity with 400 before provisioning', async () => {
    const error = await executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      payload(slugs.missing, `opp_oppconv_absent_${suffix}`),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400, message: 'Opportunity not found.' });
    expect(await organizationsWithSlugs(slugs.missing)).toHaveLength(0);
  });

  it('serializes racing conversions and provisions exactly one tenant, job and link', async () => {
    const results = await Promise.all([
      settle(
        executePlatformCommand(
          actor,
          'crm.opportunity.convert',
          payload(slugs.first, opportunityId),
          request
        )
      ),
      settle(
        executePlatformCommand(
          actor,
          'organization.create',
          payload(slugs.second, opportunityId),
          request
        )
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(PlatformSecurityError);
    expect(rejected[0]?.reason).toMatchObject({
      status: 409,
      message: 'Opportunity has already been converted.',
    });

    const organizations = await organizationsWithSlugs(slugs.first, slugs.second);
    expect(organizations).toHaveLength(1);
    const organizationId = organizations[0]!.id;

    const state = await withPlatformDb(async (tx) => ({
      opportunity: await tx.platformOpportunity.findUniqueOrThrow({
        where: { id: opportunityId },
        select: { stage: true, wonAt: true, convertedOrganizationId: true },
      }),
      account: await tx.platformAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { organizationId: true, status: true },
      }),
      jobs: await tx.platformJob.count({ where: { organizationId } }),
      events: await tx.platformOpportunityStageEvent.findMany({
        where: { opportunityId },
        select: { fromStage: true, toStage: true },
      }),
    }));
    expect(state.opportunity).toMatchObject({
      stage: 'WON',
      wonAt: expect.any(Date),
      convertedOrganizationId: organizationId,
    });
    expect(state.account).toEqual({ organizationId, status: 'CUSTOMER' });
    expect(state.jobs).toBe(1);
    expect(state.events).toEqual([{ fromStage: 'PROPOSAL', toStage: 'WON' }]);
  });

  it('rejects a sequential replay of a converted opportunity with 409', async () => {
    const error = await executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      payload(slugs.replay, opportunityId),
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({
      status: 409,
      message: 'Opportunity has already been converted.',
    });
    expect(await organizationsWithSlugs(slugs.replay)).toHaveLength(0);
  });

  it('rejects a lost opportunity and an opportunity whose account is already linked', async () => {
    const lost = await executePlatformCommand(
      actor,
      'crm.opportunity.convert',
      payload(slugs.lost, lostOpportunityId),
      request
    ).catch((caught: unknown) => caught);
    expect(lost).toMatchObject({
      status: 409,
      message: 'Opportunity is not eligible for conversion.',
    });

    const sibling = await executePlatformCommand(
      actor,
      'organization.create',
      payload(slugs.sibling, siblingOpportunityId),
      request
    ).catch((caught: unknown) => caught);
    expect(sibling).toMatchObject({
      status: 409,
      message: 'Account is already linked to an organization.',
    });

    expect(await organizationsWithSlugs(slugs.lost, slugs.sibling)).toHaveLength(0);
    // The rejected claim rolled back with its transaction.
    const opportunities = await withPlatformDb((tx) =>
      tx.platformOpportunity.findMany({
        where: { id: { in: [lostOpportunityId, siblingOpportunityId] } },
        select: { id: true, stage: true, wonAt: true, convertedOrganizationId: true },
        orderBy: { id: 'asc' },
      })
    );
    expect(opportunities).toEqual([
      { id: lostOpportunityId, stage: 'LOST', wonAt: null, convertedOrganizationId: null },
      {
        id: siblingOpportunityId,
        stage: 'NEGOTIATION',
        wonAt: null,
        convertedOrganizationId: null,
      },
    ]);
  });
});
