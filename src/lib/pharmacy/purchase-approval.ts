import { SEGREGATION_OF_DUTIES_POLICY } from './purchasing';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { actorCanProcure, actorIsPharmacyOwner } from './procurement-access';
import { assignedRegisterBranchIds } from './controlled-register';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

export const SOLO_OWNER_POLICY = 'PHARMACY_SOLO_OWNER_PIN';
export const APPROVAL_BLOCKED = 'An authorized approver must enter a valid PIN.';

/** Count people, not just qualified approvers: an unqualified second staff member
 * does not turn a multi-person operation into a solo-owner exception. */
export async function soloOwnerApprovalAllowed(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  branchId?: string | null
) {
  if (!(await actorIsPharmacyOwner(db, organizationId, userId))) return false;
  const others = await db.user.count({
    where: {
      organizationId,
      status: 'ACTIVE',
      id: { not: userId },
      ...(branchId
        ? {
            OR: [
              { pharmacyBranchAssignments: { some: { branchId, active: true } } },
              { organizationRole: { isSystem: true, key: { in: ['owner', 'owner-operator'] } } },
              {
                role: 'ADMIN',
                organizationRole: { permissions: { some: { capability: '*', effect: 'ALLOW' } } },
              },
              {
                role: 'ADMIN',
                permissionOverrides: {
                  some: {
                    capability: '*',
                    effect: 'ALLOW',
                    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                  },
                },
              },
            ],
          }
        : {}),
    },
  });
  return others === 0;
}

/** Caller commits a blocked result so PIN lockout survives refusal. Never logs PINs. */
async function verifyApprover(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId?: string | null;
    approverId: string;
    pin?: string;
  }
): Promise<{ blocked: string } | { verified: true }> {
  const { organizationId, branchId, approverId, pin } = input;
  if (!pin || !/^\d{4,8}$/.test(pin) || !(await actorCanProcure(db, approverId)))
    return { blocked: APPROVAL_BLOCKED } as const;
  if (
    branchId &&
    !(await assignedRegisterBranchIds(db, organizationId, approverId)).includes(branchId)
  )
    return { blocked: APPROVAL_BLOCKED } as const;
  // Serialize strikes even for simultaneous guesses of the same user's PIN.
  await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" WHERE c."organizationId"=${organizationId} AND s."organizationId"=${organizationId} AND s."userId"=${approverId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL ORDER BY c.id FOR UPDATE OF c`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: {
        organizationId,
        userId: approverId,
        status: 'ACTIVE',
        user: { organizationId, status: 'ACTIVE' },
      },
    },
    orderBy: { id: 'asc' },
  });
  const now = new Date();
  if (!credential || isLockedOut(credential, now)) return { blocked: APPROVAL_BLOCKED } as const;
  if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return { blocked: APPROVAL_BLOCKED } as const;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  await db.$queryRaw`SELECT set_config('app.pharmacy_purchase_pin_verified_user_id', ${approverId}, true)`;
  return { verified: true } as const;
}

const approvalQueues = new WeakMap<object, Map<string, Promise<unknown>>>();
export async function verifyPurchaseApprover(
  db: ScopedDb,
  input: Parameters<typeof verifyApprover>[1]
) {
  let queues = approvalQueues.get(db);
  if (!queues) approvalQueues.set(db, (queues = new Map()));
  const key = `${input.organizationId}:${input.approverId}`;
  const work = (queues.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => verifyApprover(db, input));
  queues.set(key, work);
  try {
    return await work;
  } finally {
    if (queues.get(key) === work) queues.delete(key);
  }
}

/** Durable proof is part of the draft transaction, not a best-effort UI audit. */
export async function recordPurchaseApprovalEvidence(
  db: ScopedDb,
  input: {
    organizationId: string;
    receiptId: string;
    actorId: string;
    approverId: string;
    receiverId?: string;
  }
) {
  return db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actorId,
      actorType: 'USER',
      source: 'TRPC',
      category: 'PHARMACY_PURCHASING',
      operation: 'OTHER',
      action: 'pharmacy.directPurchaseApproval',
      targetType: 'PharmacyGoodsReceipt',
      targetId: input.receiptId,
      metadata: {
        approverId: input.approverId,
        pinVerified: true,
        policy:
          (input.receiverId ?? input.actorId) === input.approverId
            ? SOLO_OWNER_POLICY
            : SEGREGATION_OF_DUTIES_POLICY,
      },
    },
  });
}

export async function hasPurchaseApprovalEvidence(
  db: ScopedDb,
  organizationId: string,
  receiptId: string,
  approverId: string
) {
  return Boolean(
    await db.auditLog.findFirst({
      where: {
        organizationId,
        action: 'pharmacy.directPurchaseApproval',
        targetType: 'PharmacyGoodsReceipt',
        targetId: receiptId,
        AND: [
          { metadata: { path: ['approverId'], equals: approverId } },
          { metadata: { path: ['pinVerified'], equals: true } },
        ],
      },
      select: { id: true },
    })
  );
}
