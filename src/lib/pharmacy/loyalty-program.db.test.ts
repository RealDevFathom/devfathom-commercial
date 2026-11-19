/**
 * DEV-930: a points redemption reads the loyalty program under a shared advisory lock. Prisma
 * cannot deserialize that lock's void result, so the read must select it as text; uncast, every
 * counter redemption failed with an internal error. Real PostgreSQL through the tenant client.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('DEV-930 lockedLoyaltyProgram on PostgreSQL', () => {
  it('takes the shared program lock and reads the program inside the transaction', async () => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    const { lockedLoyaltyProgram } = await import('./loyalty-program');
    const organizationId = `org_dev930_${randomUUID()}`;
    await expect(
      withTenantDb(organizationId, (db) => lockedLoyaltyProgram(db, organizationId))
    ).resolves.toBeNull();
  });
});
