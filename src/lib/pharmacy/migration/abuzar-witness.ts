import 'server-only';
import { randomUUID } from 'node:crypto';
import { can } from '@/lib/abac';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import {
  isLockedOut,
  registerFailedAttempt,
  clearLockout,
} from '@/lib/restaurant/operator-credentials';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { assignedRegisterBranchIds, lockRegister } from '../controlled-register';
import type { LedgerScope } from '../stock-ledger';

export async function eligibleOpeningWitness(db: ScopedDb, scope: LedgerScope, userId: string) {
  if (userId === scope.actorId) return false;
  const user = await db.user.findFirst({
    where: { organizationId: scope.organizationId, id: userId, status: 'ACTIVE' },
  });
  return (
    !!user &&
    (await assignedRegisterBranchIds(db, scope.organizationId, userId)).includes(scope.branchId) &&
    (await can(user, 'pharmacy:dispense', undefined, { db }))
  );
}
/** Separate transaction: a wrong secret must leave a strike even if the document rolls back. */
export function verifyOpeningWitness(scope: LedgerScope, userId: string, secret: string) {
  return withTenantDb(
    scope.organizationId,
    async (db) => {
      if (!(await eligibleOpeningWitness(db, scope, userId))) return false;
      await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" AND s."organizationId"=c."organizationId" WHERE c."organizationId"=${scope.organizationId} AND s."userId"=${userId} AND s.status='ACTIVE' AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL FOR UPDATE OF c`;
      const credential = await db.restaurantOperatorCredential.findFirst({
        where: {
          organizationId: scope.organizationId,
          type: 'PIN',
          deviceId: null,
          revokedAt: null,
          staffProfile: { organizationId: scope.organizationId, userId, status: 'ACTIVE' },
        },
      });
      const now = new Date();
      if (!credential || isLockedOut(credential, now)) return false;
      const method = await verifyApprovalSecret(db, {
        organizationId: scope.organizationId,
        approverUserId: userId,
        credentialHash: credential.credentialHash,
        secret,
        requestedById: scope.actorId,
        approverRight: 'pharmacy:dispense',
        action: 'pharmacy.abuzar.verifyOpeningWitness',
      });
      await db.restaurantOperatorCredential.update({
        where: { id: credential.id },
        data: method ? clearLockout() : registerFailedAttempt(credential, now),
      });
      return !!method;
    },
    { userId: scope.actorId }
  );
}
export async function appendOpeningRegister(
  db: ScopedDb,
  scope: LedgerScope,
  sessionId: string,
  witnessId: string
) {
  await lockRegister(db, scope.organizationId, scope.branchId);
  const lines = await db.$queryRaw<
    {
      medicineId: string;
      movementId: string;
      lotId: string;
      units: number;
      batch: string | null;
      held: boolean;
    }[]
  >`
    SELECT b."medicineId",l."postedMovementId" AS "movementId",l."postedLotId" AS "lotId",l."countedUnits" AS units,b."batchNumber" AS batch,a."unverifiedBatch" AS held
    FROM pharmacy_opening_stock_lines l JOIN pharmacy_abuzar_openings a ON a."organizationId"=l."organizationId" AND a."openingLineId"=l.id
    JOIN pharmacy_manufacturing_batches b ON b."organizationId"=l."organizationId" AND b.id=l."manufacturingBatchId"
    JOIN pharmacy_medicines m ON m."organizationId"=b."organizationId" AND m.id=b."medicineId"
    WHERE l."organizationId"=${scope.organizationId} AND l."branchId"=${scope.branchId} AND l."sessionId"=${sessionId} AND m.controlled AND l."countedUnits">0 ORDER BY l.id`;
  if (!lines.length) return;
  const proof = await db.auditLog.create({
    data: {
      id: randomUUID(),
      organizationId: scope.organizationId,
      actorId: witnessId,
      source: 'AUTH',
      category: 'PHARMACY',
      operation: 'EXECUTE',
      action: 'pharmacy.abuzar.openingWitness',
      metadata: { sessionId, recordedBy: scope.actorId, branchId: scope.branchId },
    },
  });
  const last = await db.pharmacyControlledRegisterEntry.aggregate({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    _max: { serial: true },
  });
  let serial = last._max.serial ?? 0;
  for (const line of lines) {
    const delta = line.held ? 0 : line.units;
    await db.pharmacyControlledRegisterEntry.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        recordedByUserId: scope.actorId,
        witnessedByUserId: witnessId,
        signatureRef: 'abuzar-opening:' + proof.id,
        entryKind: 'OPENING',
        serial: ++serial,
        medicineId: line.medicineId,
        stockMovementId: line.movementId,
        inventoryLotId: line.lotId,
        batchNumber: line.batch,
        quantityCanonicalUnits: line.units,
        balanceDelta: delta,
        runningBalance: delta,
      },
    });
  }
}
