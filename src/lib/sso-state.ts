import { clientIp, rateLimitStorageKey } from '@/lib/rate-limit';
import { SSO_PENDING_PER_CONNECTION, SSO_PENDING_PER_SOURCE } from '@/lib/sso-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class SsoStateCapacityError extends Error {}

export async function reserveSsoStateCapacity(
  db: ScopedDb,
  connectionId: string,
  request: Request,
  slots: 1 | 2
) {
  // The transaction holding this lock creates all rows for one start.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'sso-state:' + connectionId}, 0))`;
  const sourceKey = rateLimitStorageKey(`sso:pending:${connectionId}:${clientIp(request)}`);
  // Read both counts at one snapshot. Older rows without a source key still
  // count toward the connection total until consumed or expired.
  const [counts] = await db.$queryRaw<Array<{ total: number; fromSource: number }>>`
    SELECT count(*)::int AS total,
           (count(*) FILTER (WHERE payload->>'sourceKey' = ${sourceKey}))::int AS "fromSource"
    FROM organization_sso_states
    WHERE "identityConnectionId" = ${connectionId} AND "usedAt" IS NULL AND "expiresAt" > ${new Date()}
  `;
  if (
    !counts ||
    counts.total + slots > SSO_PENDING_PER_CONNECTION ||
    counts.fromSource + slots > SSO_PENDING_PER_SOURCE
  ) {
    throw new SsoStateCapacityError('Sign-in state capacity reached.');
  }
  return sourceKey;
}

export const SSO_CLEANUP_BATCH_SIZE = 500;

export function deleteSpentSsoStates(db: ScopedDb) {
  return db.$executeRaw`
    WITH spent AS MATERIALIZED (
      SELECT id FROM "organization_sso_states"
      WHERE "usedAt" IS NOT NULL OR "expiresAt" <= CURRENT_TIMESTAMP
      ORDER BY "expiresAt", id LIMIT ${SSO_CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "organization_sso_states" USING spent WHERE "organization_sso_states".id = spent.id
  `;
}
