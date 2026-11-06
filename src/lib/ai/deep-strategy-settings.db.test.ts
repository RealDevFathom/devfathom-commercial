/**
 * @vitest-environment node
 *
 * DEV-576: the router reads a pharmacy's deep-strategy opt-in from the tenant
 * database under that organization's own row-level security. This runs against
 * a REAL, migrated PostgreSQL reached as the application role, so the column
 * default and the RLS boundary are the database's, not a mock's.
 *
 * Requires TEST_DATABASE_URL (a migrated throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 5 }),
    log: ['error'],
  }),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_dev576_deep_a_${suffix}`;
const ORG_B = `org_dev576_deep_b_${suffix}`;

let scoped: typeof import('@/lib/tenancy/scoped-db');
let settings: typeof import('./deep-strategy-settings');

describeIfDatabase('deep-strategy opt-in (real database, tenant RLS)', () => {
  beforeAll(async () => {
    scoped = await import('@/lib/tenancy/scoped-db');
    settings = await import('./deep-strategy-settings');
    await scoped.withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO "organizations"
          ("id", "slug", "legalName", "displayName", "vertical", "status", "deploymentMode", "createdAt", "updatedAt")
         VALUES
          ($1, $2, 'DEV-576 A', 'DEV-576 A', 'PHARMACY', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ($3, $4, 'DEV-576 B', 'DEV-576 B', 'PHARMACY', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ORG_A,
        `dev576-deep-a-${suffix}`,
        ORG_B,
        `dev576-deep-b-${suffix}`
      )
    );
  });

  afterAll(async () => {
    if (!scoped) return;
    await scoped
      .withPlatformDb((db) =>
        db.$executeRawUnsafe(`DELETE FROM "organizations" WHERE "id" IN ($1, $2)`, ORG_A, ORG_B)
      )
      .catch(() => undefined);
  });

  it('is off by default', async () => {
    await expect(settings.readDeepStrategyEnabled(ORG_A)).resolves.toBe(false);
    await expect(
      scoped.withTenantDb(ORG_A, (db) => settings.readDeepStrategySettings(db, ORG_A))
    ).resolves.toEqual({ organizationId: ORG_A, aiDeepStrategyEnabled: false });
  });

  it('reads an opt-in for that organization only', async () => {
    await scoped.withTenantDb(ORG_A, (db) =>
      db.organization.update({ where: { id: ORG_A }, data: { aiDeepStrategyEnabled: true } })
    );
    await expect(settings.readDeepStrategyEnabled(ORG_A)).resolves.toBe(true);
    await expect(settings.readDeepStrategyEnabled(ORG_B)).resolves.toBe(false);
  });

  it("cannot see another organization's opt-in", async () => {
    await expect(
      scoped.withTenantDb(ORG_B, (db) => settings.readDeepStrategySettings(db, ORG_A))
    ).resolves.toBeNull();
  });

  it('treats a missing organization as not opted in', async () => {
    await expect(settings.readDeepStrategyEnabled(`org_dev576_missing_${suffix}`)).resolves.toBe(
      false
    );
  });
});
