import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PharmacyInventoryError } from './inventory';
import { assertStoredBranchMayOperate } from './regulatory';
import type { LedgerScope } from './stock-ledger';

export async function assertControlledWarehouseStorage(
  db: ScopedDb,
  scope: LedgerScope,
  destinationKind: string,
  action: 'warehouse.controlledPutAway' | 'warehouse.controlledQualityRelease',
  at = new Date()
) {
  if (destinationKind !== 'SAFE')
    throw new PharmacyInventoryError('UNSALEABLE_DESTINATION', 'Scan a safe for controlled stock.');
  const user = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
    include: { organizationRole: { include: { permissions: true } }, permissionOverrides: true },
  });
  if (!user || !(await can(user, 'pharmacy:dispense', undefined, { db, now: at })))
    throw new PharmacyInventoryError(
      'COAUTH_REQUIRED',
      'A qualified pharmacist must confirm controlled stock placement.'
    );
  await assertStoredBranchMayOperate(db, scope.organizationId, scope.branchId, {
    name: action,
    at,
    requiresQualifiedPerson: true,
    requiresPharmacistPresence: true,
  });
}
