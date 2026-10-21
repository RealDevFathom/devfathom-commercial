import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Read only the organization installed by withTenantDb from the trusted session.
 * Fail closed outside tenant scope, even when the connection bypasses RLS.
 */
export async function catalogOrganizationId(db: ScopedDb): Promise<string> {
  const [scope] = await db.$queryRaw<{ organizationId: string | null }[]>`
    SELECT NULLIF(current_setting('app.current_organization_id', true), '') AS "organizationId"
  `;
  if (!scope?.organizationId) throw new Error('Catalog requires an active organization.');
  return scope.organizationId;
}
