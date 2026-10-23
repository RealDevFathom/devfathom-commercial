import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { MarketingCopyGeneration } from './marketing-assistance';
import type { MarketingScope } from './marketing-service';

type StoredGeneration = {
  id: string;
  status: 'PENDING' | 'COMPLETE';
  body: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

/** Reserve before invoking a paid provider. The tenant-qualified unique key is the charge fence. */
export async function reserveMarketingGeneration(
  db: ScopedDb,
  scope: MarketingScope,
  idempotencyKey: string
) {
  const id = randomUUID();
  const rows = await db.$queryRaw<StoredGeneration[]>(Prisma.sql`
    INSERT INTO "pharmacy_marketing_ai_generations"
      ("id", "organizationId", "branchId", "idempotencyKey", "status", "createdAt", "updatedAt")
    VALUES (${id}, ${scope.organizationId}, ${scope.branchId}, ${idempotencyKey}, 'PENDING', NOW(), NOW())
    ON CONFLICT ("organizationId", "branchId", "idempotencyKey") DO NOTHING
    RETURNING "id", "status", "body", "inputTokens", "outputTokens", "totalTokens"
  `);
  if (rows[0]) return { generation: rows[0], claimed: true as const };
  const existing = await db.$queryRaw<StoredGeneration[]>(Prisma.sql`
    SELECT "id", "status", "body", "inputTokens", "outputTokens", "totalTokens"
    FROM "pharmacy_marketing_ai_generations"
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND "idempotencyKey"=${idempotencyKey}
    LIMIT 1
  `);
  if (!existing[0]) throw new Error('AI generation reservation unavailable.');
  return { generation: existing[0], claimed: false as const };
}

/** Save paid output before the independently retryable usage insert. */
export async function persistMarketingGeneration(
  db: ScopedDb,
  scope: MarketingScope,
  generationId: string,
  result: MarketingCopyGeneration
) {
  await db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_marketing_ai_generations"
    SET "status"='COMPLETE', "body"=${result.body},
        "inputTokens"=${result.usage.inputTokens}, "outputTokens"=${result.usage.outputTokens},
        "totalTokens"=${result.usage.totalTokens}, "updatedAt"=NOW()
    WHERE "id"=${generationId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} AND "status"='PENDING'
  `);
}

/** Idempotent outbox drain. Failure is deliberately non-fatal: COMPLETE retains paid output. */
export async function recordMarketingUsage(
  db: ScopedDb,
  scope: MarketingScope,
  generation: StoredGeneration
) {
  if (generation.status !== 'COMPLETE' || generation.body === null) return;
  try {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "pharmacy_marketing_ai_usage"
        ("id", "organizationId", "branchId", "generationId", "inputTokens", "outputTokens", "totalTokens", "recordedAt")
      VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${generation.id},
        ${generation.inputTokens ?? 0}, ${generation.outputTokens ?? 0}, ${generation.totalTokens ?? 0}, NOW())
      ON CONFLICT ("organizationId", "generationId") DO NOTHING
    `);
  } catch {
    // The generation row is the durable outbox; a request retry drains it. Never log provider data.
  }
}

export function replayMarketingGeneration(generation: StoredGeneration) {
  if (generation.status !== 'COMPLETE' || generation.body === null) return null;
  return { available: true as const, body: generation.body, approved: false as const };
}
