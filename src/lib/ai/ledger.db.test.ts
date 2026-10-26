import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDatabase = DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const orgA = `org_ai_a_${suffix}`;
const orgB = `org_ai_b_${suffix}`;
let owner: Client;

describeIfDatabase('AI ledger database integration', () => {
  beforeAll(async () => {
    owner = new Client({ connectionString: DATABASE_URL });
    await owner.connect();
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "vertical", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'AI A', 'AI A', 'RESTAURANT', 'ACTIVE', 'SHARED', now(), now()),
              ($3, $4, 'AI B', 'AI B', 'RESTAURANT', 'ACTIVE', 'SHARED', now(), now())`,
      [orgA, `ai-a-${suffix}`, orgB, `ai-b-${suffix}`]
    );
  });

  afterAll(async () => {
    if (!owner) return;
    await owner.query('DELETE FROM "ai_usages" WHERE "organization_id" = ANY($1)', [[orgA, orgB]]);
    await owner.query('DELETE FROM "organizations" WHERE "id" = ANY($1)', [[orgA, orgB]]);
    await owner.end();
  });

  it('reads seeded prices, isolates tenants, and makes retries idempotent', async () => {
    const [{ withTenantDb }, { reserveAIUsage, recordAIUsage }] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./ledger'),
    ]);
    const requestId = `request-${suffix}`;
    const reserve = () =>
      withTenantDb(orgA, (db) =>
        reserveAIUsage(db, {
          organizationId: orgA,
          requestId,
          tier: 'standard',
          monthlyBudgetUsd: new Prisma.Decimal(10),
        })
      );
    const [first, retry] = await Promise.all([reserve(), reserve()]);
    expect(retry).toEqual(first);

    const completed = await withTenantDb(orgA, (db) =>
      recordAIUsage(db, { organizationId: orgA, requestId, inputTokens: 1_000, outputTokens: 500 })
    );
    expect(completed.costUsd.toFixed(6)).toBe('0.010500');
    await withTenantDb(orgA, async (db) => {
      expect(await db.aiUsage.count({ where: { organizationId: orgA, requestId } })).toBe(1);
    });
    await withTenantDb(orgB, async (db) => {
      expect(await db.aiUsage.count({ where: { organizationId: orgB } })).toBe(0);
    });
  });
});
