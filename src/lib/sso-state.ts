import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export class SsoStateCapacityError extends Error {}

export async function reserveSsoStateCapacity(db: ScopedDb, connectionId: string, slots: 1 | 2) {
  // The transaction holding this lock creates all rows for one start.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'sso-state:' + connectionId}, 0))`;
  const outstanding = await db.organizationSsoState.count({
    where: { identityConnectionId: connectionId, usedAt: null, expiresAt: { gt: new Date() } },
  });
  if (outstanding + slots > 256) throw new SsoStateCapacityError('Sign-in state capacity reached.');
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
