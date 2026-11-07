import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { can, subjectFromSession } from '@/lib/abac';
import { isAdmin } from '@/lib/authz';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { CustomerPortalError, portalEvent } from './customer-portal';

export async function assertPortalStaffBranch(
  db: ScopedDb,
  organizationId: string,
  user: { id: string; role?: string | null },
  branchId: string
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  const assignment = isAdmin(user.role)
    ? true
    : await db.pharmacyBranchAssignment.findFirst({
        where: { organizationId, branchId, userId: user.id, active: true },
        select: { id: true },
      });
  if (!branch || !assignment)
    throw new CustomerPortalError(403, 'This pharmacy branch is not assigned to you.');
  await db.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`);
}

/** Current actor's PIN, including the opted-in solo owner. Denial is returned so lockouts commit. */
export async function reauthenticatePortalStaff(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  pin: string
) {
  const profile = await db.restaurantStaffProfile.findFirst({
    where: { organizationId: scope.organizationId, userId: scope.actorId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!profile) return false;
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${profile.id} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`
  );
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
  if (!credential || isLockedOut(credential, now)) return false;
  const valid = await verifyOperatorCredential('PIN', pin, credential.credentialHash);
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: valid ? clearLockout() : registerFailedAttempt(credential, now),
  });
  await portalEvent(db, scope, valid ? 'STAFF_PIN_VERIFIED' : 'STAFF_PIN_FAILED', scope.actorId);
  return valid;
}

/** Extend the existing Rx capture boundary only for a request bound to this patient/branch. */
export async function readableCustomerRequestPhoto(
  db: ScopedDb,
  organizationId: string,
  user: { id: string; role?: string | null },
  file: { patientId: string; uploadedByUserId: string },
  sourceFileRef: string,
  readOnly = false
) {
  if (!file.uploadedByUserId.startsWith('customer:')) return false;
  if (!(await can(subjectFromSession(user), 'pharmacy:dispense', undefined, { db }))) return false;
  const rows = await db.$queryRaw<{ branchId: string }[]>(Prisma.sql`
    SELECT r."branchId" FROM pharmacy_customer_requests r JOIN pharmacy_customers c
    ON c."organizationId"=r."organizationId" AND c.id=r."customerId"
    WHERE r."organizationId"=${organizationId} AND r."sourceFileRef"=${sourceFileRef}
      AND c."patientId"=${file.patientId} AND ('customer:' || c.id)=${file.uploadedByUserId}
      AND r.kind='RX_PHOTO' AND (${readOnly} OR r.status IN ('AWAITING_PHARMACIST', 'APPROVED'))`);
  if (!rows[0]) return false;
  try {
    await assertPortalStaffBranch(db, organizationId, user, rows[0].branchId);
  } catch {
    return false;
  }
  return true;
}
