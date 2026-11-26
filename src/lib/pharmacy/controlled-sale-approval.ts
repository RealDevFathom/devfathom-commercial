import 'server-only';
import { can } from '@/lib/abac';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

export const NO_CONTROLLED_SALE_WITNESS = 'No witness: dispensed by one pharmacist';
export const CONTROLLED_SELF_APPROVAL = 'pharmacySales.controlledSelfApproval';

type Confirmation = { staffProfileId: string; pin: string; selfApproval?: boolean };

export async function branchAllowsControlledSelfApproval(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  const [branch] = await db.$queryRaw<
    { requireSecondPharmacist: boolean }[]
  >`SELECT "requireSecondPharmacist" FROM pharmacy_branches WHERE "organizationId"=${scope.organizationId} AND id=${scope.branchId} AND active FOR SHARE`;
  return branch?.requireSecondPharmacist === false;
}

export function confirmControlledSale(
  db: ScopedDb,
  scope: LedgerScope,
  authorization: Confirmation
) {
  // Own credential attempts commit separately so an outer transaction rollback cannot erase a strike.
  return authorization.selfApproval
    ? withTenantDb(scope.organizationId, (tx) => verifyCredential(tx, scope, authorization), {
        userId: scope.actorId,
        skipDrain: true,
      })
    : verifyCredential(db, scope, authorization);
}

async function verifyCredential(db: ScopedDb, scope: LedgerScope, authorization: Confirmation) {
  // Serialize credential attempts; returning a denial commits durable lockout counters.
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${authorization.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: authorization.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: { include: { user: true } } },
  });
  const pharmacist = credential?.staffProfile.user;
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.status !== 'ACTIVE' ||
    !pharmacist ||
    pharmacist.organizationId !== scope.organizationId ||
    pharmacist.status !== 'ACTIVE' ||
    (pharmacist.id === scope.actorId) !== Boolean(authorization.selfApproval) ||
    isLockedOut(credential, now)
  )
    return null;
  if (!(await can(pharmacist, 'pharmacy:dispense', undefined, { db, now }))) return null;
  const method = await verifyApprovalSecret(db, {
    organizationId: scope.organizationId,
    approverUserId: pharmacist.id,
    credentialHash: credential.credentialHash,
    secret: authorization.pin,
    action: 'pharmacySales.controlledAuthorization',
    approverRight: 'pharmacy:dispense',
    requestedById: scope.actorId,
    now,
  });
  if (!method) {
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

  return { id: pharmacist.id, method };
}

export async function writeControlledReviewApproval(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    reviewItemId: string;
    saleLineId: string;
    saleId: string;
    method: 'PIN' | 'AUTHENTICATOR';
    now: Date;
  }
) {
  return db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'EXECUTE',
      action: CONTROLLED_SELF_APPROVAL,
      outcome: 'SUCCESS',
      targetType: 'PharmacyPharmacistReviewItem',
      targetId: input.reviewItemId,
      description: NO_CONTROLLED_SALE_WITNESS,
      metadata: {
        selfApproved: true,
        approvalMethod: input.method,
        pinVerified: input.method === 'PIN',
        authenticatorVerified: input.method === 'AUTHENTICATOR',
        reviewItemId: input.reviewItemId,
        saleLineId: input.saleLineId,
        saleId: input.saleId,
        branchId: scope.branchId,
        approvedAt: input.now.toISOString(),
      },
    },
    select: { id: true },
  });
}
