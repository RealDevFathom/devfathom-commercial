import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type AskFathomSettings = {
  organizationId: string;
  askFathomEnabled: boolean;
};

/** Read current chat policy from the tenant database, never a session or cache. */
export async function readAskFathomSettings(
  db: Pick<ScopedDb, 'organization'>,
  organizationId: string
): Promise<AskFathomSettings | null> {
  if (!organizationId) return null;
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, askFathomEnabled: true },
  });
  if (organization?.id !== organizationId || typeof organization.askFathomEnabled !== 'boolean') {
    return null;
  }
  return { organizationId, askFathomEnabled: organization.askFathomEnabled };
}
