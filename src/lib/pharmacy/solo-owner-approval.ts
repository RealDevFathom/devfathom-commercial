import 'server-only';

import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { PharmacyPurchasingError } from './purchasing';
import { isPharmacyOwner } from './procurement-authorization';

type ApprovalScope = { organizationId: string; branchId: string | null; actorId: string };

/** Display eligibility is advisory; approval rechecks it against live rows. */
export async function soloOwnerApprovalEligible(db: ScopedDb, scope: ApprovalScope) {
  const actor = await db.user.findUnique({
    where: { id: scope.actorId },
    include: { organizationRole: true },
  });
  if (
    !actor ||
    actor.organizationId !== scope.organizationId ||
    actor.status !== 'ACTIVE' ||
    !isPharmacyOwner(actor)
  )
    return false;
  const active = { organizationId: scope.organizationId, status: 'ACTIVE' as const };
  const staff = await db.user.findMany({
    where: active,
    select: {
      id: true,
      role: true,
      organizationRole: { select: { key: true, isSystem: true } },
      pharmacyBranchAssignments: { where: { active: true }, select: { branchId: true } },
    },
  });
  const relevant = scope.branchId
    ? staff.filter(
        (member) =>
          member.id === scope.actorId ||
          isPharmacyOwner(member) ||
          member.pharmacyBranchAssignments.length === 0 ||
          member.pharmacyBranchAssignments.some(
            (assignment) => assignment.branchId === scope.branchId
          )
      )
    : staff;
  return relevant.length === 1 && relevant[0].id === scope.actorId;
}

/** Only a sole active owner in the tenant or the order's branch may use this exception. */
export async function authorizeSoloOwnerApproval(
  db: ScopedDb,
  scope: ApprovalScope & { purchaseOrderId: string },
  pin?: string
) {
  if (!pin || !(await soloOwnerApprovalEligible(db, scope)))
    throw new PharmacyPurchasingError('SELF_APPROVAL');
  // Independent shared buckets survive a failed approval transaction's rollback.
  const limit = await rateLimit(
    `pharmacy:solo-owner-pin:${scope.organizationId}:${scope.actorId}`,
    5,
    15 * 60 * 1000
  );
  if (!limit.ok) throw new PharmacyPurchasingError('SELF_APPROVAL');
  const profile = await db.restaurantStaffProfile.findFirst({
    where: { organizationId: scope.organizationId, userId: scope.actorId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!profile) throw new PharmacyPurchasingError('SELF_APPROVAL');
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${profile.id} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: profile.id,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
  });
  const now = new Date();
  if (!credential || isLockedOut(credential, now))
    throw new PharmacyPurchasingError('SELF_APPROVAL');
  if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    throw new PharmacyPurchasingError('SELF_APPROVAL');
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  await clearRateLimit(`pharmacy:solo-owner-pin:${scope.organizationId}:${scope.actorId}`);
  const [transaction] = await db.$queryRaw<
    Array<{ id: string }>
  >`SELECT txid_current()::text AS id`;
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      action: 'pharmacyPurchasing.soloOwnerApproval',
      targetType: 'PharmacyPurchaseOrder',
      targetId: scope.purchaseOrderId,
      metadata: {
        transactionId: transaction.id,
        branchId: scope.branchId,
        policy: 'PUR-02:SOLO_OWNER_PIN',
        credentialId: credential.id,
        activeStaffCount: 1,
      },
    },
  });
  return 'PUR-02:SOLO_OWNER_PIN';
}
