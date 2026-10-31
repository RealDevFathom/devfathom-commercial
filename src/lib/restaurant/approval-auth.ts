import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { authenticateOperator } from './terminal-auth';

/** The tenant ID must come from a scoped database row, never caller input.
 * A failed request rolls back its HTTP transaction, so credential attempts use
 * a new committed transaction. Returning failure normally preserves lockouts.
 * The caller may still hold its own connection, so the credential transaction
 * waits only briefly for a pooled connection and fails closed (throws) under
 * pool exhaustion instead of stalling the outer transaction.
 */
export function authenticateApprovalPin(
  organizationId: string,
  params: Parameters<typeof authenticateOperator>[1]
) {
  return withTenantDb(
    organizationId,
    async (credentialDb) => {
      await credentialDb.$queryRawUnsafe(
        `SELECT id FROM restaurant_operator_credentials WHERE "staffProfileId" = $1
       AND type = 'PIN' AND ("deviceId" IS NULL OR "deviceId" = $2)
       AND "revokedAt" IS NULL ORDER BY id FOR UPDATE`,
        params.staffProfileId,
        params.deviceId ?? null
      );
      return authenticateOperator(credentialDb, params);
    },
    { skipDrain: true, maxWait: 2_000, timeout: 5_000 }
  );
}
