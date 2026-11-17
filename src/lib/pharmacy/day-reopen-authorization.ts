import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { verifyRefundPin } from './refund-authorization';

/**
 * DEV-631: reopening a closed business day for trading is the owner's or a
 * manager's, and only after re-entering their own staff PIN for this one action
 * (the fresh re-authentication the refund approval uses). A solo owner meets it alone.
 */
export const DAY_REOPEN_PIN_POLICY = 'PHARMACY_DAY_REOPEN_MANAGER_PIN';
export const DAY_REOPEN_PIN_BLOCKED = 'Day not reopened. Enter your owner or manager PIN.';

/**
 * The PIN check in its own tenant transaction, so a refused PIN commits its lockout
 * strike and a FAILURE audit row even though the reopen itself never runs.
 */
export function authenticateDayReopenPin(input: {
  organizationId: string;
  actorId: string;
  pin: string;
}): Promise<{ verified: true } | { blocked: string }> {
  return withTenantDb(
    input.organizationId,
    async (db) => {
      const result = await verifyRefundPin(db, input);
      if ('verified' in result) return result;
      await db.auditLog.create({
        data: {
          organizationId: input.organizationId,
          actorId: input.actorId,
          source: 'TRPC',
          category: 'PHARMACY',
          operation: 'EXECUTE',
          action: 'pharmacySales.reopenDay',
          outcome: 'FAILURE',
          errorCode: 'DAY_REOPEN_PIN_REFUSED',
          metadata: { policy: DAY_REOPEN_PIN_POLICY, pinVerified: false },
        },
      });
      return { blocked: DAY_REOPEN_PIN_BLOCKED };
    },
    { skipDrain: true }
  );
}
