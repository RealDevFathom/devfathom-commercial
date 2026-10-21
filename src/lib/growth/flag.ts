import 'server-only';

import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function isGrowthEnabled(organizationId: string): Promise<boolean> {
  return withTenantDb(organizationId, async (db) =>
    hasModule(await resolveOrganizationEntitlements(organizationId, db), 'growth_ai')
  );
}
