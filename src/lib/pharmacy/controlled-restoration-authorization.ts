import { authorizeSoloApproval, pinProfileBelongsToActor } from './solo-approval';
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
  scope: LedgerScope,
  input?: ControlledRestorationPin
): Promise<ControlledRestorationWitness> {
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  });
  if (!actor || !(await can(actor, 'pharmacy:dispense', undefined, { db }))) {
    throw new ControlledRestorationDenied(true);
  }
  if (!input) throw new ControlledRestorationDenied();

  if (await pinProfileBelongsToActor(db, scope, input.staffProfileId)) {
    const signature = randomUUID();
    if (
      !(await authorizeSoloApproval(
        db,
        scope,
        { type: 'ControlledRestoration', id: signature },
        input.pin
      ))
    )
      throw new ControlledRestorationDenied();
    return { witnessedByUserId: scope.actorId, signatureRef: `solo-restoration:${signature}` };
  }
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
    witness.id === scope.actorId ||
    isLockedOut(credential, now) ||
    !(await can(witness, 'pharmacy:dispense', undefined, { db, now }))
  ) {
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
  return { witnessedByUserId: witness.id, signatureRef: `pin:${credential.id}:${randomUUID()}` };
}
