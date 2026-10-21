/**
 * QA-147 — duplicate organization slugs against real PostgreSQL.
 *
 * The pg driver adapter reports P2002 with no meta.target and no constraint when
 * Postgres sends an empty DETAIL. The cause still carries originalCode 23505 and
 * an originalMessage that names organizations_slug_key. Case and whitespace
 * variants are the same slug and must be a 409, including when two creates race.
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
const packageId = `pkg_qa147_${suffix}`;
const actor: PlatformIdentity = {
  sessionId: `sess_qa147_${suffix}`,
  id: `plat_qa147_${suffix}`,
  name: 'QA 147',
  email: `qa147-${suffix}@test.local`,
  role: 'SUPER_ADMIN',
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  mfaEnabled: true,
};
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

function payload(slug: string, adminEmail: string) {
  return {
    slug,
    legalName: `QA 147 ${suffix}`,
    displayName: `QA 147 ${suffix}`,
    deploymentMode: 'SHARED' as const,
    packageId,
    timezone: 'UTC',
    locale: 'en',
    currency: 'usd',
    primaryContactName: 'Ops',
    primaryContactEmail: `ops-${suffix}@test.local`,
    adminName: 'QA Admin',
    adminEmail,
    adminPassword: 'a-strong-password',
  };
}

async function createOrganization(slug: string, adminEmail: string) {
  return executePlatformCommand(actor, 'organization.create', payload(slug, adminEmail), request);
}

describeIfDatabase('organization.create duplicate slug on PostgreSQL', () => {
  const slug = `qa147-${suffix}`;

  beforeAll(async () => {
    await withPlatformDb((tx) =>
      tx.platformPackage.create({
        data: {
          id: packageId,
          key: `qa147-${suffix}`,
          name: 'QA 147',
          vertical: 'AGENCY',
          active: true,
          defaultSeats: 5,
        },
      })
    );
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('returns 409 for a duplicate slug, including case and whitespace', async () => {
    const created = await createOrganization(`  ${slug.toUpperCase()}  `, `admin-${suffix}@test.local`);
    expect(created).toMatchObject({ slug });

    for (const [variant, email] of [
      [slug, `again-${suffix}@test.local`],
      [slug.toUpperCase(), `case-${suffix}@test.local`],
      [`  ${slug}  `, `space-${suffix}@test.local`],
      [`  ${slug.toUpperCase()}  `, `both-${suffix}@test.local`],
    ] as const) {
      const error = await createOrganization(variant, email).catch((caught: unknown) => caught);
      expect(error, variant).toBeInstanceOf(PlatformSecurityError);
      expect(error, variant).toMatchObject({
        status: 409,
        message: 'That organization slug is already taken.',
      });
    }

    const stored = await withPlatformDb((tx) => tx.organization.count({ where: { slug } }));
    expect(stored).toBe(1);
  });

  it('returns 409 when two creates of the same slug race', async () => {
    const raced = `qa147-race-${suffix}`;
    const results = await Promise.all([
      createOrganization(raced, `race-a-${suffix}@test.local`).then(
        (organization) => organization,
        (error: unknown) => error
      ),
      createOrganization(`  ${raced.toUpperCase()}  `, `race-b-${suffix}@test.local`).then(
        (organization) => organization,
        (error: unknown) => error
      ),
    ]);
    const conflicts = results.filter((result) => result instanceof PlatformSecurityError);
    const created = results.filter(
      (result) =>
        result !== null &&
        typeof result === 'object' &&
        'slug' in result &&
        (result as { slug: unknown }).slug === raced
    );
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      status: 409,
      message: 'That organization slug is already taken.',
    });
    expect(await withPlatformDb((tx) => tx.organization.count({ where: { slug: raced } }))).toBe(1);
  });
});
