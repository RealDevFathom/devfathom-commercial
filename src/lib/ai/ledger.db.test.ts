import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { DEFAULT_AI_MODELS } from './model-defaults';

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
    const [{ withTenantDb }, { cancelAIUsage, reserveAIUsage, recordAIUsage }] = await Promise.all([
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
    expect(first).toEqual(expect.objectContaining({ isReplay: false }));
    expect(retry).toEqual({ provider: first.provider, model: first.model, isReplay: true });

    const [completed, competingCompletion] = await Promise.all([
      withTenantDb(orgA, (db) =>
        recordAIUsage(db, { organizationId: orgA, requestId, inputTokens: 1_000, outputTokens: 500 })
      ),
      withTenantDb(orgA, (db) =>
        recordAIUsage(db, { organizationId: orgA, requestId, inputTokens: 2_000, outputTokens: 1_000 })
      ),
    ]);
    expect(competingCompletion.costUsd.toFixed(6)).toBe(completed.costUsd.toFixed(6));
    expect(['0.010500', '0.021000']).toContain(completed.costUsd.toFixed(6));

    const crossover = await withTenantDb(orgA, (db) =>
      reserveAIUsage(db, {
        organizationId: orgA,
        requestId: `crossover-${suffix}`,
        tier: 'standard',
        monthlyBudgetUsd: new Prisma.Decimal('3.9'),
      })
    );
    expect(crossover.provider).toBe('bedrock');

    await withTenantDb(orgA, (db) => cancelAIUsage(db, orgA, `crossover-${suffix}`));
    await withTenantDb(orgA, async (db) => {
      const cancelled = await db.aiUsage.findUniqueOrThrow({
        where: {
          organizationId_requestId: {
            organizationId: orgA,
            requestId: `crossover-${suffix}`,
          },
        },
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.costUsd.toFixed(6)).toBe('0.000000');
    });
    await withTenantDb(orgA, async (db) => {
      expect(await db.aiUsage.count({ where: { organizationId: orgA, requestId } })).toBe(1);
    });
    await withTenantDb(orgB, async (db) => {
      expect(await db.aiUsage.count({ where: { organizationId: orgB } })).toBe(0);
    });
  });

  it('keeps an expired in-flight reservation in the budget and charges an abort', async () => {
    const [{ withTenantDb }, { commitAIUsageReservation, reserveAIUsage }] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./ledger'),
    ]);
    const expiredId = `expired-${suffix}`;
    const old = new Date(Date.now() - 10 * 60_000);
    const first = await withTenantDb(orgA, (db) =>
      reserveAIUsage(db, {
        organizationId: orgA,
        requestId: expiredId,
        tier: 'standard',
        monthlyBudgetUsd: new Prisma.Decimal(5),
        occurredAt: old,
      })
    );
    expect(first.provider).toBe('anthropic');

    const second = await withTenantDb(orgA, (db) =>
      reserveAIUsage(db, {
        organizationId: orgA,
        requestId: `after-expiry-${suffix}`,
        tier: 'standard',
        monthlyBudgetUsd: new Prisma.Decimal(5),
      })
    );
    expect(second.provider).toBe('bedrock');

    await withTenantDb(orgA, (db) => commitAIUsageReservation(db, orgA, expiredId));
    await withTenantDb(orgA, async (db) => {
      const charged = await db.aiUsage.findUniqueOrThrow({
        where: { organizationId_requestId: { organizationId: orgA, requestId: expiredId } },
      });
      expect(charged.status).toBe('COMPLETED');
      expect(charged.costUsd.toFixed(6)).toBe('3.968640');
    });
  });

  it('has an effective catalog price for every default provider/model pair', async () => {
    const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
    await withTenantDb(orgA, async (db) => {
      for (const [provider, tiers] of Object.entries(DEFAULT_AI_MODELS)) {
        for (const model of Object.values(tiers)) {
          const price = await db.aiModelPrice.findFirst({
            where: { provider, model, effectiveFrom: { lte: new Date() } },
            orderBy: { effectiveFrom: 'desc' },
          });
          expect(price, `${provider}/${model}`).not.toBeNull();
        }
      }
    });
  });
});
