import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { parseMajorUnitsToMinor, safeMinorFromBigInt } from './money';

export const DEFAULT_AI_MONTHLY_BUDGET_MINOR = 20_000;

function envBudgetMinor(): number {
  return parseMajorUnitsToMinor(process.env.AI_MONTHLY_BUDGET) ?? DEFAULT_AI_MONTHLY_BUDGET_MINOR;
}

/**
 * The single budget seam shared by routing, reporting, and alerts. Piece 3 will
 * wire its persisted setting into this function when the parallel branches are
 * rebased; until then the environment/default fallback remains operational.
 */
export async function getAiBudgetMinor(): Promise<number> {
  let rows: Array<{ budgetMinor: bigint }>;
  try {
    rows = await withPlatformDb((db) =>
      db.$queryRaw<Array<{ budgetMinor: bigint }>>(Prisma.sql`
        SELECT ROUND("monthlyAnthropicBudgetUsd" * 100)::bigint AS "budgetMinor"
        FROM "ai_settings" WHERE "id" = 'default' LIMIT 1`)
    );
  } catch {
    // Supports deployments during the migration/rebase window where the piece-3
    // settings storage is not present yet. Never log configuration values.
    return envBudgetMinor();
  }
  return rows[0] ? safeMinorFromBigInt(rows[0].budgetMinor, 'AI monthly budget') : envBudgetMinor();
}
