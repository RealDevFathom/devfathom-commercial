import { isSoloPharmacyOwner } from './solo-owner';
import { randomUUID } from 'node:crypto';
import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

export type ControlledRestorationPin = { staffProfileId: string; pin: string };
export type ControlledRestorationWitness = { witnessedByUserId: string; signatureRef: string };

export class ControlledRestorationDenied extends Error {
  constructor(readonly forbidden = false) {
    super(
      forbidden
        ? 'Dispense permission is required.'
        : 'A different pharmacist must enter a fresh witness PIN.'
    );
  }
}

/** Called inside the sale transaction, before any stock or status mutation. */
export async function authorizeControlledRestoration(
  db: ScopedDb,
  scope: Omit<LedgerScope, 'branchId'> & { branchId: string | null },
  input?: ControlledRestorationPin,
  purpose: 'controlled-restoration' | 'purchase-order' = 'controlled-restoration'
): Promise<ControlledRestorationWitness> {
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  });
  if (!actor || !(await can(actor, 'pharmacy:dispense', undefined, { db }))) {
    throw new ControlledRestorationDenied(true);
  }
  if (!input) throw new ControlledRestorationDenied();
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${input.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: input.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const witness = credential?.staffProfile.user;
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !witness ||
    witness.organizationId !== scope.organizationId ||
    witness.status !== 'ACTIVE' ||
    isLockedOut(credential, now) ||
    !(await can(witness, 'pharmacy:dispense', undefined, { db, now }))
  ) {
    throw new ControlledRestorationDenied();
  }
  const selfApproval = witness.id === scope.actorId;
  if (selfApproval && !(await isSoloPharmacyOwner(db, scope.organizationId, scope.actorId))) {
    throw new ControlledRestorationDenied();
  }
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    throw new ControlledRestorationDenied();
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  if (selfApproval) {
    await db.auditLog.create({
      data: {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacy.soloOwnerSelfApproval',
        metadata: {
          branchId: scope.branchId,
          credentialId: credential.id,
          purpose,
        },
      },
    });
  }
  return { witnessedByUserId: witness.id, signatureRef: `pin:${credential.id}:${randomUUID()}` };
}
