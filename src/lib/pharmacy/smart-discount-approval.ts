import 'server-only';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  CredentialLifecycleError,
  issueOperatorCredential,
  rotateOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import {
  clearLockout,
  CredentialPolicyError,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

export type SmartDiscountApproval = Readonly<{
  organizationId: string;
  branchId: string;
  actorId: string;
  ownerId: string;
  signatureRef: string;
}>;
const proofs = new WeakSet<SmartDiscountApproval>();

/** Credential policy/lifecycle failures are caller errors, not internal 500s. */
function mapCredentialError(err: unknown): never {
  if (err instanceof CredentialPolicyError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  if (err instanceof CredentialLifecycleError) {
    const code =
      err.reason === 'ALREADY_EXISTS' || err.reason === 'REVOKED'
        ? 'CONFLICT'
        : err.reason === 'NOT_FOUND' || err.reason === 'STAFF_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

/** Pharmacy owners can enroll their own PIN without enabling restaurant modules. */
export async function setSmartDiscountOwnerPin(
  db: ScopedDb,
  scope: LedgerScope,
  pin: string,
  currentPin?: string
) {
  await db.$queryRaw`SELECT id FROM users WHERE id=${scope.actorId}
    AND "organizationId"=${scope.organizationId} FOR UPDATE`;
  const user = await db.user.findFirst({
    where: {
      id: scope.actorId,
      organizationId: scope.organizationId,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  if (!user)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Current owner access is required.' });
  let staff = await db.restaurantStaffProfile.findFirst({
    where: {
      organizationId: scope.organizationId,
      userId: user.id,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (staff && staff.status !== 'ACTIVE')
    throw new TRPCError({ code: 'FORBIDDEN', message: 'The owner profile must be active.' });
  // This repairs only the current administrator's own profile, not an extra operator seat:
  // like restaurant `provisionMyProfile`, the administrator's own profile is provisioning
  // owed at activation, so it deliberately bypasses the operator commercial limit.
  if (!staff)
    staff = await db.restaurantStaffProfile.create({
      data: {
        organizationId: scope.organizationId,
        userId: user.id,
        displayName: user.name,
      },
    });
  const existing = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: staff.id,
      type: 'PIN',
      deviceId: null,
      revokedAt: null,
    },
  });
  if (existing) {
    if (!currentPin) return { blocked: 'Enter the current owner PIN before changing it.' };
    const verified = await verifySmartDiscountOwner(scope, {
      staffProfileId: staff.id,
      pin: currentPin,
    });
    if ('blocked' in verified) return verified;
  }
  // The owner has one org-wide operator PIN (deviceId null); the restaurant POS and this
  // pharmacy approval deliberately share it, so changing it here changes it there too.
  const credential = await (
    existing
      ? rotateOperatorCredential(db, { credentialId: existing.id, secret: pin })
      : issueOperatorCredential(db, { staffProfileId: staff.id, type: 'PIN', secret: pin })
  ).catch(mapCredentialError);
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: existing ? 'UPDATE' : 'CREATE',
      action: 'pharmacyMedicine.setSmartDiscountOwnerPin',
      targetType: 'RestaurantOperatorCredential',
      targetId: credential.id,
      changes: { staffProfileId: staff.id, type: 'PIN' },
    },
  });
  return { staffProfileId: staff.id };
}

export function isSmartDiscountApproval(
  proof: SmartDiscountApproval | undefined,
  scope: LedgerScope
) {
  return (
    !!proof &&
    proofs.has(proof) &&
    proof.organizationId === scope.organizationId &&
    proof.branchId === scope.branchId &&
    proof.actorId === scope.actorId
  );
}

/**
 * Verify an owner PIN in its OWN tenant transaction, committed before this
 * returns. The request-wide transaction is rolled back whenever any sibling in
 * the same HTTP batch fails, so a failed-attempt increment written there could
 * be erased by batching each guess with a deliberately invalid mutation. The
 * lockout counter must survive whatever the request does next.
 */
export function verifySmartDiscountOwner(
  scope: LedgerScope,
  input: { staffProfileId: string; pin: string }
): Promise<{ blocked: string } | { approval: SmartDiscountApproval }> {
  return withTenantDb(
    scope.organizationId,
    (attemptDb) => verifySmartDiscountOwnerAttempt(attemptDb, scope, input),
    { userId: scope.actorId, maxWait: 2_000, timeout: 5_000, skipDrain: true }
  );
}

/**
 * One PIN attempt against `db`. Returns a denial (never throws) so the attempt's
 * counter update commits with `db`. Call through `verifySmartDiscountOwner`
 * unless `db` is already an independent, committed-on-return transaction.
 */
export async function verifySmartDiscountOwnerAttempt(
  db: ScopedDb,
  scope: LedgerScope,
  input: { staffProfileId: string; pin: string }
): Promise<{ blocked: string } | { approval: SmartDiscountApproval }> {
  const blocked = { blocked: 'An active owner must enter a fresh PIN to approve this discount.' };
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials
    WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${input.staffProfileId}
      AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
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
  const owner = credential?.staffProfile.user;
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !owner ||
    owner.organizationId !== scope.organizationId ||
    owner.status !== 'ACTIVE' ||
    owner.role !== 'ADMIN' ||
    isLockedOut(credential, now)
  )
    return blocked;
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return blocked;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  const approval = Object.freeze({
    ...scope,
    ownerId: owner.id,
    signatureRef: `pin:${randomUUID()}`,
  });
  proofs.add(approval);
  return { approval };
}
