import 'server-only';

import { afterTenantTransaction } from '@/lib/side-effects/scope';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { captureReceiptArrivals } from './back-in-stock';
import { captureSafeRestockArrival, PharmacySaleError } from './sales';
import type { LedgerScope } from './stock-ledger';

/**
 * DEV-79: queue back-in-stock notices for the lots a goods receipt posted.
 *
 * A tRPC request runs in one tenant transaction and nested `$transaction`
 * calls reuse it, so capturing inside the request could abort or roll back the
 * receipt posting on any database error. The capture therefore waits until
 * the owning transaction has ended and gives each lot its own transaction. If
 * the posting rolled back, its lots do not exist and the capture finds
 * nothing to notify.
 */
export function scheduleReceiptArrivalCapture(
  scope: LedgerScope,
  inventoryLotIds: readonly string[]
) {
  const lots = [...inventoryLotIds];
  afterTenantTransaction(() => {
    void captureReceiptArrivals(
      lots,
      (inventoryLotId) =>
        withTenantDb(
          scope.organizationId,
          (tx) => captureSafeRestockArrival(tx, scope, { inventoryLotId }),
          { userId: scope.actorId }
        ),
      (inventoryLotId, error) => {
        if (!(error instanceof PharmacySaleError))
          console.error('[back-in-stock] Arrival capture failed', {
            inventoryLotId,
            error: error instanceof Error ? error.name : 'error',
          });
      }
    );
  });
}
