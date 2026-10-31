import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';

export type AIUsageRecord = {
  organizationId: string;
  branchId: string;
  feature: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** Persist tenant-attributed metering. Callers decide whether metering is fail-open. */
export async function recordAIUsage(usage: AIUsageRecord): Promise<void> {
  await withTenantDb(
    usage.organizationId,
    async (db) => {
      await db.aIUsage.create({ data: usage });
    },
    { skipDrain: true }
  );
}
