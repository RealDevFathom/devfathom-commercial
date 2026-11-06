import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

export type DeepStrategySettings = {
  organizationId: string;
  /** The pharmacy opted in to deep strategy on the deep model. Off by default. */
  aiDeepStrategyEnabled: boolean;
};

/** Read the organization's deep-strategy opt-in from the tenant database. */
export async function readDeepStrategySettings(
  db: Pick<ScopedDb, 'organization'>,
  organizationId: string
): Promise<DeepStrategySettings | null> {
  if (!organizationId) return null;
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, aiDeepStrategyEnabled: true },
  });
  if (
    organization?.id !== organizationId ||
    typeof organization.aiDeepStrategyEnabled !== 'boolean'
  ) {
    return null;
  }
  return { organizationId, aiDeepStrategyEnabled: organization.aiDeepStrategyEnabled };
}

/**
 * The router's read: under the organization's own row-level security, and false
 * whenever the row is missing or unreadable. The router caches it for 30 s.
 */
export async function readDeepStrategyEnabled(organizationId: string): Promise<boolean> {
  const settings = await withTenantDb(
    organizationId,
    (db) => readDeepStrategySettings(db, organizationId),
    { skipDrain: true }
  );
  return settings?.aiDeepStrategyEnabled === true;
}
