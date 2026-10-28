import 'server-only';

import { authenticateApprovalPin } from './approval-auth';
import { operatorHasCapability } from './checkout-routes';
import { type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  buildCoAuthorizationRecord,
  buildSoloOwnerCoAuthorization,
  CoAuthorizationError,
} from '@/lib/restaurant/co-authorization';

/**
 * M7-L4 / §11.5 — SOP occurrence verification: VERIFY, REJECT, WAIVE.
 *
 * All three decisions are APPEND-ONLY to `restaurant_sop_verifications` (the RLS
 * SELECT+INSERT policy enforces this at the DB level). The occurrence status is
 * derived from the verification record written here:
 *
 *   SUBMITTED/LATE → VERIFIED   (verify — acceptance)
 *   SUBMITTED/LATE → REJECTED   (reject — sends back for rework)
 *   SUBMITTED/LATE/MISSED → WAIVED  (waive — excuses without rework)
 *
 * Gates:
 *   - verify and reject: require the `sop:verify` capability (enforced at the
 *     router layer — this module receives a pre-verified actor id).
 *   - waive: additionally requires a manager co-authorization (M2 pattern,
 *     PIN-verified approver; only a sole active owner may self-approve).
 *
 * After REJECT the occurrence status returns to a state where `startOccurrence`
 * (REJECTED → IN_PROGRESS) can be called again for the rework.
 */

export type SopVerificationErrorReason =
  'NOT_FOUND' | 'INVALID_STATE' | 'CO_AUTH_REQUIRED' | 'INVALID';

export class SopVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: SopVerificationErrorReason
  ) {
    super(message);
    this.name = 'SopVerificationError';
  }
}

function runSopTx<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

/** States that a verifier may act on (SUBMITTED or LATE). */
const VERIFIABLE_STATUSES = ['SUBMITTED', 'LATE'] as const;
/** States that a waiver may act on (SUBMITTED, LATE, or MISSED). */
const WAIVABLE_STATUSES = ['SUBMITTED', 'LATE', 'MISSED'] as const;

// ── Verify ────────────────────────────────────────────────────────────────────

export type VerifyOccurrenceInput = {
  occurrenceId: string;
  actorStaffProfileId?: string | null;
  reason?: string | null;
  approvalPin?: string;
  now?: Date;
};

export type VerificationResult = {
  verificationId: string;
  occurrenceId: string;
  action: 'VERIFY' | 'REJECT' | 'WAIVE';
  createdAt: Date;
};

export async function verifyOccurrence(
  db: ScopedDb,
  input: VerifyOccurrenceInput
): Promise<VerificationResult> {
  const now = input.now ?? new Date();
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: {
        id: true,
        status: true,
        branchId: true,
        organizationId: true,
        assignedStaffProfileId: true,
        claimedByStaffProfileId: true,
        steps: { select: { completedByStaffProfileId: true } },
        evidence: { select: { uploaderStaffProfileId: true } },
      },
    });
    if (!occ) throw new SopVerificationError('Occurrence not found.', 'NOT_FOUND');
    if (!(VERIFIABLE_STATUSES as readonly string[]).includes(occ.status)) {
      throw new SopVerificationError(
        `Cannot verify an occurrence in status ${occ.status}. Expected SUBMITTED or LATE.`,
        'INVALID_STATE'
      );
    }
    const actor = input.actorStaffProfileId;
    const selfApproval =
      actor &&
      (occ.assignedStaffProfileId === actor ||
        occ.claimedByStaffProfileId === actor ||
        occ.steps?.some((step) => step.completedByStaffProfileId === actor) ||
        occ.evidence?.some((proof) => proof.uploaderStaffProfileId === actor));
    let coAuthorizationId: string | undefined;
    if (selfApproval) {
      try {
        const record = await buildSoloOwnerCoAuthorization(
          tx,
          {
            actingStaffProfileId: actor,
            approvingStaffProfileId: actor,
            capability: 'sop:verify',
            reason: input.reason?.trim() || 'Owner verified own SOP execution',
            targetType: 'RestaurantSopOccurrence',
            targetId: input.occurrenceId,
          },
          occ.branchId,
          input.approvalPin
        );
        coAuthorizationId = (
          await tx.restaurantCoAuthorization.create({ data: record, select: { id: true } })
        ).id;
        await tx.auditLog.create({
          data: {
            organizationId: occ.organizationId,
            actorType: 'RESTAURANT_OPERATOR',
            actorStaffProfileId: actor,
            source: 'SYSTEM',
            category: 'RESTAURANT',
            operation: 'EXECUTE',
            action: 'sop.verify.soloOwnerApproval',
            description: 'Sole active owner verified their SOP execution with a verified PIN.',
            targetType: 'RestaurantSopOccurrence',
            targetId: input.occurrenceId,
            metadata: { coAuthorizationId, branchId: occ.branchId },
          },
        });
      } catch (error) {
        if (!(error instanceof CoAuthorizationError)) throw error;
        throw new SopVerificationError(error.message, 'CO_AUTH_REQUIRED');
      }
    }
    const [, verification] = await Promise.all([
      tx.restaurantSopOccurrence.update({
        where: { id: input.occurrenceId },
        data: { status: 'VERIFIED', resolvedAt: now },
      }),
      tx.restaurantSopVerification.create({
        data: {
          occurrenceId: input.occurrenceId,
          action: 'VERIFY',
          ...(coAuthorizationId ? { coAuthorizationId } : {}),
          actorStaffProfileId: input.actorStaffProfileId ?? null,
          reason: input.reason ?? null,
          createdAt: now,
        },
        select: { id: true, createdAt: true },
      }),
    ]);
    return {
      verificationId: verification.id,
      occurrenceId: input.occurrenceId,
      action: 'VERIFY',
      createdAt: verification.createdAt,
    };
  });
}

// ── Reject ────────────────────────────────────────────────────────────────────

export type RejectOccurrenceInput = {
  occurrenceId: string;
  actorStaffProfileId?: string | null;
  reason?: string | null;
  now?: Date;
};

export async function rejectOccurrence(
  db: ScopedDb,
  input: RejectOccurrenceInput
): Promise<VerificationResult> {
  const now = input.now ?? new Date();
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: { id: true, status: true },
    });
    if (!occ) throw new SopVerificationError('Occurrence not found.', 'NOT_FOUND');
    if (!(VERIFIABLE_STATUSES as readonly string[]).includes(occ.status)) {
      throw new SopVerificationError(
        `Cannot reject an occurrence in status ${occ.status}. Expected SUBMITTED or LATE.`,
        'INVALID_STATE'
      );
    }
    const [, verification] = await Promise.all([
      tx.restaurantSopOccurrence.update({
        where: { id: input.occurrenceId },
        // REJECTED — startOccurrence accepts REJECTED → IN_PROGRESS for rework (§4)
        data: { status: 'REJECTED' },
      }),
      tx.restaurantSopVerification.create({
        data: {
          occurrenceId: input.occurrenceId,
          action: 'REJECT',
          actorStaffProfileId: input.actorStaffProfileId ?? null,
          reason: input.reason ?? null,
          createdAt: now,
        },
        select: { id: true, createdAt: true },
      }),
    ]);
    return {
      verificationId: verification.id,
      occurrenceId: input.occurrenceId,
      action: 'REJECT',
      createdAt: verification.createdAt,
    };
  });
}

// ── Waive ─────────────────────────────────────────────────────────────────────

export type WaiveOccurrenceInput = {
  occurrenceId: string;
  /** The manager performing the waiver. */
  actorStaffProfileId: string;
  /** Requires a verified approver; only the sole active owner may approve themselves. */
  approvingStaffProfileId: string;
  approvingPin?: string;
  approvalPin?: string;
  reason: string;
  now?: Date;
};

export async function waiveOccurrence(
  db: ScopedDb,
  input: WaiveOccurrenceInput
): Promise<VerificationResult> {
  const now = input.now ?? new Date();
  // Credential attempts must commit independently of the outer HTTP transaction.
  const current = await db.restaurantSopOccurrence.findUnique({
    where: { id: input.occurrenceId },
    select: { status: true, branchId: true, organizationId: true },
  });
  if (!current) throw new SopVerificationError('Occurrence not found.', 'NOT_FOUND');
  if (!(WAIVABLE_STATUSES as readonly string[]).includes(current.status))
    throw new SopVerificationError('Occurrence is not waivable.', 'INVALID_STATE');
  const approverId = input.approvingStaffProfileId.trim();
  if (
    !(input.approvingPin ?? input.approvalPin) ||
    !(await operatorHasCapability(db, approverId, 'sop:verify', now, current.branchId)) ||
    !(await operatorHasCapability(db, approverId, 'coauth:approve', now, current.branchId))
  )
    throw new SopVerificationError(
      'A capable approver and verified PIN are required.',
      'CO_AUTH_REQUIRED'
    );
  const pin = input.approvingPin ?? input.approvalPin;
  if (input.actorStaffProfileId.trim() !== approverId) {
    const auth = await authenticateApprovalPin(current.organizationId, {
      staffProfileId: approverId,
      type: 'PIN',
      secret: pin!,
      now,
    });
    if (!auth.ok)
      throw new SopVerificationError('Invalid or locked approving credential.', 'CO_AUTH_REQUIRED');
  }
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: { id: true, status: true, branchId: true },
    });
    if (!occ) throw new SopVerificationError('Occurrence not found.', 'NOT_FOUND');
    if (!(WAIVABLE_STATUSES as readonly string[]).includes(occ.status)) {
      throw new SopVerificationError(
        `Cannot waive an occurrence in status ${occ.status}. Expected SUBMITTED, LATE, or MISSED.`,
        'INVALID_STATE'
      );
    }

    if (occ.branchId !== current.branchId)
      throw new SopVerificationError(
        'Occurrence scope changed. Retry approval.',
        'CO_AUTH_REQUIRED'
      );
    const verifiedSoloOwner = input.actorStaffProfileId.trim() === approverId;
    let coAuthData: ReturnType<typeof buildCoAuthorizationRecord>;
    try {
      const request = {
        actingStaffProfileId: input.actorStaffProfileId,
        approvingStaffProfileId: approverId,
        capability: 'sop:verify',
        reason: input.reason,
        targetType: 'RestaurantSopOccurrence',
        targetId: input.occurrenceId,
      };
      coAuthData = verifiedSoloOwner
        ? await buildSoloOwnerCoAuthorization(tx, request, occ.branchId, pin)
        : buildCoAuthorizationRecord(request);
    } catch (err) {
      const msg = err instanceof CoAuthorizationError ? err.message : 'Co-authorization failed.';
      throw new SopVerificationError(msg, 'CO_AUTH_REQUIRED');
    }

    const coAuth = await tx.restaurantCoAuthorization.create({
      data: coAuthData,
      select: { id: true },
    });

    if (verifiedSoloOwner) {
      await tx.auditLog.create({
        data: {
          organizationId: current.organizationId,
          actorType: 'RESTAURANT_OPERATOR',
          actorStaffProfileId: input.actorStaffProfileId,
          source: 'SYSTEM',
          category: 'RESTAURANT',
          operation: 'EXECUTE',
          action: 'sop.waive.soloOwnerApproval',
          description: 'Sole active owner approved an SOP waiver with a verified PIN.',
          targetType: 'RestaurantSopOccurrence',
          targetId: input.occurrenceId,
          metadata: { coAuthorizationId: coAuth.id, branchId: occ.branchId, reason: input.reason },
        },
      });
    }

    const [, verification] = await Promise.all([
      tx.restaurantSopOccurrence.update({
        where: { id: input.occurrenceId },
        data: { status: 'WAIVED', resolvedAt: now },
      }),
      tx.restaurantSopVerification.create({
        data: {
          occurrenceId: input.occurrenceId,
          action: 'WAIVE',
          actorStaffProfileId: input.actorStaffProfileId,
          coAuthorizationId: coAuth.id,
          reason: input.reason,
          createdAt: now,
        },
        select: { id: true, createdAt: true },
      }),
    ]);
    return {
      verificationId: verification.id,
      occurrenceId: input.occurrenceId,
      action: 'WAIVE',
      createdAt: verification.createdAt,
    };
  });
}
