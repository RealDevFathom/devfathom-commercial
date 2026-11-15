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
export type ControlledRestorationWitness = {
  witnessedByUserId: string;
  signatureRef: string;
  /** True when a sole pharmacist witnessed their own change with a fresh PIN. */
  soloSelfWitness?: boolean;
};

/** Audit policy for a sole pharmacist's PIN-reauthenticated self-witness. */
export const SOLO_PHARMACIST_WITNESS_POLICY = 'PHARMACY_SOLO_PHARMACIST_PIN';
/** Register signature prefix the database accepts on a self-witnessed restoration. */
export const SOLO_WITNESS_SIGNATURE_PREFIX = 'solo-pin:';

/**
 * Solo-pharmacy rule: nobody else in the organization could witness. Counts
 * every other active or on-leave member who holds a dispensing grant, with or
 * without a PIN, so an unset PIN never turns a staffed pharmacy into a solo one.
 */
export async function isSolePharmacist(
  db: ScopedDb,
  organizationId: string,
  actorId: string
): Promise<boolean> {
  const others = await db.user.findMany({
    where: { organizationId, id: { not: actorId }, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
  });
  for (const other of others) {
    if (await can(other, 'pharmacy:dispense', undefined, { db })) return false;
  }
  return true;
}

export class ControlledRestorationDenied extends Error {
  constructor(readonly forbidden = false) {
    super(
      forbidden
        ? 'Permission to change controlled stock is required.'
        : 'A different pharmacist must enter a fresh witness PIN.'
    );
  }
}

/**
 * Check the actor inside the stock transaction, before any stock or status write.
 * PIN verification owns an independent tenant transaction: a refusal (or a later
 * stock failure) must never roll back the credential's lockout state.
 */
export async function authorizeControlledRestoration(
  db: ScopedDb,
  scope: LedgerScope,
  input?: ControlledRestorationPin,
  actorCapability: 'pharmacy:dispense' | 'pharmacy:safety' = 'pharmacy:dispense',
  options: { allowSoloSelfWitness?: boolean } = {}
): Promise<ControlledRestorationWitness> {
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  });
  if (!actor || !(await can(actor, actorCapability, undefined, { db }))) {
    throw new ControlledRestorationDenied(true);
  }
  if (!input) throw new ControlledRestorationDenied();
  // A sole pharmacist may witness their own change, but only with their own
  // dispensing grant and a fresh PIN; any second pharmacist ends the exception.
  const selfAllowed =
    options.allowSoloSelfWitness === true &&
    (await can(actor, 'pharmacy:dispense', undefined, { db })) &&
    (await isSolePharmacist(db, scope.organizationId, scope.actorId));
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const result = await withTenantDb(
    scope.organizationId,
    (credentialDb) => verifyRestorationPin(credentialDb, scope, input, selfAllowed),
    { userId: scope.actorId, skipDrain: true }
  );
  // Throw only after the credential transaction has committed failed attempts.
  if (!result) throw new ControlledRestorationDenied();
  return result;
}

async function verifyRestorationPin(
  db: ScopedDb,
  scope: LedgerScope,
  input: ControlledRestorationPin,
  selfAllowed: boolean
): Promise<ControlledRestorationWitness | null> {
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
    (witness.id === scope.actorId && !selfAllowed) ||
    isLockedOut(credential, now) ||
    !(await can(witness, 'pharmacy:dispense', undefined, { db, now }))
  ) {
    return null;
  }
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return null;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  if (witness.id === scope.actorId) {
    return {
      witnessedByUserId: witness.id,
      signatureRef: `${SOLO_WITNESS_SIGNATURE_PREFIX}${credential.id}:${randomUUID()}`,
      soloSelfWitness: true,
    };
  }
  return { witnessedByUserId: witness.id, signatureRef: `pin:${credential.id}:${randomUUID()}` };
}
