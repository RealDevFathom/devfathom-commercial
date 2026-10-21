import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Read the organization installed by withTenantDb from the trusted session; fail closed
 * when none is set. `row_security = on` (transaction-local) only undoes a caller's
 * `row_security = off`; it does NOT apply RLS to a SUPERUSER or BYPASSRLS connection.
 * Tenant isolation on such connections rests on the explicit organizationId predicates
 * every catalog query adds with this value.
 */
export async function catalogOrganizationId(db: ScopedDb): Promise<string> {
  const [scope] = await db.$queryRaw<{ organizationId: string | null }[]>`
    SELECT NULLIF(current_setting('app.current_organization_id', true), '') AS "organizationId",
           set_config('row_security', 'on', true)
  `;
  if (!scope?.organizationId) throw new Error('Catalog requires an active organization.');
  return scope.organizationId;
}
