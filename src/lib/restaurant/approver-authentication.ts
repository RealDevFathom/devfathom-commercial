import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { authenticateOperator } from './terminal-auth';

type ApproverCredentialCheck = Omit<
  Parameters<typeof authenticateOperator>[1],
  'deviceId' | 'branchId' | 'forTerminalBinding'
>;

/**
 * DEV-1055: verify a back-office approver's organization-wide PIN or badge in its
 * OWN committed tenant transaction.
 *
 * `authenticateOperator` charges the attempt on the credential row before it
 * compares. A back-office request answers a wrong credential with an error, and
 * an error rolls the request transaction back. Run inside that transaction, the
 * charge would be rolled back with it, and the durable counter that the terminal
 * routes commit would never see the back-office guesses. Committing the check
 * here keeps ONE durable counter for every route that can test the credential:
 * five compares per lockout window in total, wherever the guesses are sent.
 *
 * The `FOR UPDATE` lock on the approver's credential rows serializes parallel
 * guesses. The organization is the caller's trusted tenant, never request input.
 */
export function authenticateOperatorCommitted(
  organizationId: string,
  check: ApproverCredentialCheck
): ReturnType<typeof authenticateOperator> {
  return withTenantDb(organizationId, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT id FROM restaurant_operator_credentials
       WHERE "staffProfileId" = $1 AND type::text = $2
         AND "deviceId" IS NULL AND "revokedAt" IS NULL
       ORDER BY id FOR UPDATE`,
      check.staffProfileId,
      check.type
    );
    return authenticateOperator(tx, check);
  });
}
