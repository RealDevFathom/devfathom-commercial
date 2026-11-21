import { randomUUID } from 'node:crypto';
import { can } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import { POLICIES } from '@/lib/abac/policies';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';

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

export class ControlledRestorationDenied extends Error {
  constructor(
    readonly forbidden = false,
    /** A sole pharmacist's own PIN was refused (wrong, or locked out). */
    readonly soloPinRefused = false,
    supplierDispatch = false
  ) {
    super(
      forbidden
        ? 'Permission to change controlled stock is required.'
        : soloPinRefused
          ? 'Your PIN was not accepted. Check it and try again, or wait if your PIN is locked.'
          : supplierDispatch
            ? 'A different pharmacist must enter a valid witness PIN or approval code before dispatch.'
            : 'A different pharmacist must enter a fresh witness PIN.'
    );
  }
}

/**
 * Solo-pharmacy rule: nobody else in the organization could witness. Counts
 * every other active or on-leave member with an ALLOW grant that covers
 * `pharmacy:dispense`, with or without a PIN, so an unset PIN never turns a
 * staffed pharmacy into a solo one. A DENY on that member is ignored here: it
 * can only make the answer "not solo", which is the safe side.
 *
 * Fails closed. One query reads every grant and a lookup error propagates
 * (`can()` would turn it into "cannot dispense", i.e. "solo"). If dispensing
 * ever gains a fallback policy, explicit grants no longer decide, so nobody
 * is treated as solo until this check is revisited.
 */
export async function isSolePharmacist(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  now: Date = new Date()
): Promise<boolean> {
  if (POLICIES['pharmacy:dispense'].length > 0) return false;
  const others = await db.user.findMany({
    where: { organizationId, id: { not: actorId }, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
    select: {
      id: true,
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  return !others.some((other) =>
    [...other.permissionOverrides, ...(other.organizationRole?.permissions ?? [])].some(
      (rule) =>
        rule.effect === 'ALLOW' && capabilityMatches(rule.capability, 'pharmacy:dispense', 'ALLOW')
    )
  );
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
  options: { allowSoloSelfWitness?: boolean; supplierDispatch?: boolean } = {}
): Promise<ControlledRestorationWitness> {
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  });
  if (!actor || !(await can(actor, actorCapability, undefined, { db }))) {
    throw new ControlledRestorationDenied(true);
  }
  if (!input) throw new ControlledRestorationDenied(false, false, options.supplierDispatch);
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const result = await withTenantDb(
    scope.organizationId,
    (credentialDb) => verifyRestorationPin(credentialDb, scope, input, options),
    { userId: scope.actorId, skipDrain: true }
  );
  // Throw only after the credential transaction has committed failed attempts.
  if (result === 'SOLO_PIN_REFUSED') throw new ControlledRestorationDenied(false, true);
  if (!result) throw new ControlledRestorationDenied(false, false, options.supplierDispatch);
  return result;
}

async function verifyRestorationPin(
  db: ScopedDb,
  scope: LedgerScope,
  input: ControlledRestorationPin,
  options: { allowSoloSelfWitness?: boolean; supplierDispatch?: boolean }
): Promise<ControlledRestorationWitness | 'SOLO_PIN_REFUSED' | null> {
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
    !(await can(witness, 'pharmacy:dispense', undefined, { db, now }))
  ) {
    return null;
  }
  // A sole pharmacist may witness their own change with their own dispensing
  // grant and a fresh PIN. The check runs only for a self-witness attempt, and
  // any second pharmacist ends the exception.
  const selfWitness = witness.id === scope.actorId;
  if (
    selfWitness &&
    !(
      options.allowSoloSelfWitness &&
      !options.supplierDispatch &&
      (await isSolePharmacist(db, scope.organizationId, scope.actorId, now))
    )
  ) {
    return null;
  }
  const refused = selfWitness ? 'SOLO_PIN_REFUSED' : null;
  if (isLockedOut(credential, now)) return refused;
  const method = await verifyApprovalSecret(db, {
    organizationId: scope.organizationId,
    approverUserId: witness.id,
    credentialHash: credential.credentialHash,
    secret: input.pin,
    action: options.supplierDispatch
      ? 'pharmacyPurchasing.dispatchPurchaseReturn'
      : 'pharmacy.controlledRestorationWitness',
    requestedById: scope.actorId,
    now,
  });
  if (!method) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return refused;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  if (selfWitness) {
    return {
      witnessedByUserId: witness.id,
      signatureRef: `${SOLO_WITNESS_SIGNATURE_PREFIX}${credential.id}:${randomUUID()}`,
      soloSelfWitness: true,
    };
  }
  const signatureMethod =
    options.supplierDispatch && method === 'AUTHENTICATOR' ? 'authenticator' : 'pin';
  return {
    witnessedByUserId: witness.id,
    signatureRef: `${signatureMethod}:${credential.id}:${randomUUID()}`,
  };
}
