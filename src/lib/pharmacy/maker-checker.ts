import { z } from 'zod';
import { can } from '@/lib/abac';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { assertBranchAssignment, isPharmacyOwner } from './branch-assignment';

export const approvalPinSchema = z
  .object({ staffProfileId: z.string().min(1).optional(), pin: z.string().regex(/^\d{4,8}$/) })
  .strict();
export const SOLO_OWNER_POLICY = 'PHARMACY:SOLO_OWNER_PIN';

/** Business approvals only. Clinical witness requirements remain independent. Run in the posting transaction. */
export async function authorizeMakerChecker(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorId: string;
    makerIds: Array<string | null>;
    targetType: string;
    targetId: string;
    pin?: z.infer<typeof approvalPinSchema>;
    requirePin?: boolean;
    requestedById?: string;
    branchId?: string;
  }
): Promise<{ policy: string } | { blocked: string; pinRejected?: true }> {
  const selfApproval = input.makerIds.includes(input.actorId);
  const policy = selfApproval ? SOLO_OWNER_POLICY : 'PUR-02:SEGREGATION_OF_DUTIES';
  if (!selfApproval && !input.requirePin) return { policy };
  const blocked = { blocked: 'SELF_APPROVAL' };
  // The tenant row is also locked by seat-changing staff lifecycle operations.
  await db.$queryRaw`SELECT id FROM organizations WHERE id=${input.organizationId} FOR UPDATE`;
  const member = await db.user.findUnique({
    where: { id: input.actorId },
    select: {
      id: true,
      role: true,
      status: true,
      organizationId: true,
      organizationRole: { select: { key: true } },
    },
  });
  if (
    !member ||
    member.organizationId !== input.organizationId ||
    !ACTIVE_STATUSES.has(member.status) ||
    (selfApproval && !isPharmacyOwner(member))
  )
    return blocked;
  if (input.branchId)
    await assertBranchAssignment(db, {
      organizationId: input.organizationId,
      actorId: member.id,
      branchId: input.branchId,
    });
  const count = await db.user.count({
    where: { organizationId: input.organizationId, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
  });
  if (
    (selfApproval && count !== 1) ||
    !input.pin ||
    !(await can(member, 'pharmacy:procurement', undefined, { db }))
  )
    return blocked;
  const staffProfileId =
    input.pin.staffProfileId ??
    (
      await db.restaurantStaffProfile.findFirst({
        where: { organizationId: input.organizationId, userId: member.id, status: 'ACTIVE' },
        select: { id: true },
      })
    )?.id;
  if (!staffProfileId) return blocked;
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${input.organizationId} AND "staffProfileId"=${staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: input.organizationId,
      staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: { staffProfile: true },
  });
  const now = new Date();
  if (
    !credential ||
    credential.staffProfile.organizationId !== input.organizationId ||
    credential.staffProfile.userId !== member.id ||
    credential.staffProfile.status !== 'ACTIVE' ||
    isLockedOut(credential, now)
  )
    return blocked;
  if (!(await verifyOperatorCredential('PIN', input.pin.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return { ...blocked, pinRejected: true }; // Must reach the outer request as a result to commit lockout.
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: member.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: selfApproval ? 'pharmacy.soloOwnerApproval' : 'pharmacy.pinApproval',
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: {
        policy,
        requestedById: input.requestedById ?? input.actorId,
        activeStaff: count,
        credentialId: credential.id,
        reauthenticatedAt: now.toISOString(),
      },
    },
  });
  return { policy };
}
