import { SEGREGATION_OF_DUTIES_POLICY } from './purchasing';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  actorCanApprovePurchase,
  actorCanProcure,
  actorIsPharmacyOwner,
  procurementBranchIds,
} from './procurement-access';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import {
  clearApproverPinGuessesTypedByAnother,
  spendApproverPinGuessTypedByAnother,
} from '@/lib/approver-pin-guess-budget';

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

/** Runs in an independent tenant transaction so request rollback cannot undo strikes. */
async function verifyApprover(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId?: string | null;
    approverId: string;
    /** The signed-in requester. Omitted only when the approver is the requester. */
    actorId?: string;
    pin?: string;
  }
): Promise<{ blocked: string } | { verified: true }> {
  const { organizationId, branchId, approverId, pin } = input;
  const crossPerson = input.actorId !== undefined && input.actorId !== approverId;
  if (
    !pin ||
    !/^\d{4,8}$/.test(pin) ||
    !(await actorCanProcure(db, approverId)) ||
    !(await actorCanApprovePurchase(db, approverId))
  )
    return { blocked: APPROVAL_BLOCKED } as const;
  if (branchId && !(await procurementBranchIds(db, organizationId, approverId)).includes(branchId))
    return { blocked: APPROVAL_BLOCKED } as const;
  // The approval PIN is the approver's shared operator credential. Guesses typed
  // by somebody else must not lock that person out of their other workflows, so
  // they spend the approver's one budget for such guesses (the same five attempts
  // per lockout window, shared with every approval that works this way) instead of
  // the credential's strike counter.
  if (crossPerson && !(await spendApproverPinGuessTypedByAnother(organizationId, approverId)).ok)
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
  if (
    !(await verifyApprovalSecret(db, {
      organizationId,
      approverUserId: approverId,
      credentialHash: credential.credentialHash,
      approvalPinMustChange: credential.approvalPinMustChange,
      deviceBound: credential.deviceId != null,
      secret: pin,
      action: 'pharmacy.purchaseApproval',
      approverRight: 'pharmacy:procurement-approve',
      requestedById: input.actorId ?? approverId,
      now,
    }))
  ) {
    if (!crossPerson) {
      await db.restaurantOperatorCredential.update({
        where: { id: credential.id },
        data: registerFailedAttempt(credential, now),
      });
    }
    return { blocked: APPROVAL_BLOCKED } as const;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  if (crossPerson) await clearApproverPinGuessesTypedByAnother(organizationId, approverId);
  return { verified: true } as const;
}

export async function verifyPurchaseApprover(
  db: ScopedDb,
  input: Parameters<typeof verifyApprover>[1]
) {
  // The request's $transaction reuses its outer transaction. Only a fresh
  // withTenantDb commits the credential counter before any business work.
  const result = await withTenantDb(
    input.organizationId,
    (credentialDb) => verifyApprover(credentialDb, input),
    { skipDrain: true }
  );
  if ('verified' in result) {
    await db.$queryRaw`SELECT set_config('app.pharmacy_purchase_pin_verified_user_id', ${input.approverId}, true)`;
  }
  return result;
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
