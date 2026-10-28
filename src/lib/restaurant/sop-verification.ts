import 'server-only';

import { isTenantAdministrator } from '@/lib/abac/tenant-administrator';
import { authenticateOperator } from './terminal-auth';
import { operatorHasCapability } from './checkout-routes';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  buildCoAuthorizationRecord,
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
      select: { id: true, status: true },
    });
    if (!occ) throw new SopVerificationError('Occurrence not found.', 'NOT_FOUND');
    if (!(VERIFIABLE_STATUSES as readonly string[]).includes(occ.status)) {
      throw new SopVerificationError(
        `Cannot verify an occurrence in status ${occ.status}. Expected SUBMITTED or LATE.`,
        'INVALID_STATE'
      );
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
    !input.approvingPin ||
    !(await operatorHasCapability(db, approverId, 'sop:verify', now, current.branchId)) ||
    !(await operatorHasCapability(db, approverId, 'coauth:approve', now, current.branchId))
  )
    throw new SopVerificationError(
      'A capable approver and verified PIN are required.',
      'CO_AUTH_REQUIRED'
    );
  // withTenantDb opens a NEW global-client transaction (unlike db.$transaction,
  // which reuses the HTTP transaction). skipDrain avoids inheriting its outbox scope.
  // Return authentication failures normally so the lockout update commits.
  const auth = await withTenantDb(
    current.organizationId,
    async (credentialDb) => {
      // Serialize attempts against the same credential so concurrent bad PINs cannot
      // overwrite each other's failedAttempts with the same stale count.
      await credentialDb.$queryRawUnsafe(
        `SELECT id FROM restaurant_operator_credentials WHERE "staffProfileId" = $1
       AND type = 'PIN' AND "deviceId" IS NULL AND "revokedAt" IS NULL FOR UPDATE`,
        approverId
      );
      return authenticateOperator(credentialDb, {
        staffProfileId: approverId,
        type: 'PIN',
        secret: input.approvingPin!,
        now,
      });
    },
    { skipDrain: true }
  );
  if (!auth.ok)
    throw new SopVerificationError('Invalid or locked approving credential.', 'CO_AUTH_REQUIRED');
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
    let verifiedSoloOwner = false;
    if (input.actorStaffProfileId.trim() === approverId) {
      const profile = await tx.restaurantStaffProfile.findUnique({
        where: { id: approverId },
        select: {
          status: true,
          user: { select: { role: true, organizationRole: { select: { key: true } } } },
        },
      });
      const owner = isTenantAdministrator(profile?.user);
      verifiedSoloOwner =
        profile?.status === 'ACTIVE' &&
        owner &&
        (await tx.restaurantStaffProfile.count({ where: { status: 'ACTIVE' } })) === 1;
    }
    // The exception is derived here from tenant state and a verified credential, never input.

    let coAuthData: ReturnType<typeof buildCoAuthorizationRecord>;
    try {
      coAuthData = buildCoAuthorizationRecord(
        {
          actingStaffProfileId: input.actorStaffProfileId,
          approvingStaffProfileId: approverId,
          capability: 'sop:verify',
          reason: input.reason,
          targetType: 'RestaurantSopOccurrence',
          targetId: input.occurrenceId,
        },
        { verifiedSoloOwner }
      );
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
