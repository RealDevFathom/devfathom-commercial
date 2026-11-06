import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
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
 *     credential-proven, capable, distinct approver at the request boundary).
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
  /** Server-verified approving manager: the request boundary must prove their
   * credential and sop:verify capability before calling this internal writer. */
  approvingStaffProfileId: string;
  reason: string;
  now?: Date;
};

export async function waiveOccurrence(
  db: ScopedDb,
  input: WaiveOccurrenceInput
): Promise<VerificationResult> {
  const now = input.now ?? new Date();
  return runSopTx(db, async (tx) => {
    const occ = await tx.restaurantSopOccurrence.findUnique({
      where: { id: input.occurrenceId },
      select: { id: true, status: true },
    });
    if (!occ) throw new SopVerificationError('Occurrence not found.', 'NOT_FOUND');
    if (!(WAIVABLE_STATUSES as readonly string[]).includes(occ.status)) {
      throw new SopVerificationError(
        `Cannot waive an occurrence in status ${occ.status}. Expected SUBMITTED, LATE, or MISSED.`,
        'INVALID_STATE'
      );
    }

    // Build the co-authorization record (validates distinct actors, reason required)
    let coAuthData: ReturnType<typeof buildCoAuthorizationRecord>;
    try {
      coAuthData = buildCoAuthorizationRecord({
        actingStaffProfileId: input.actorStaffProfileId,
        approvingStaffProfileId: input.approvingStaffProfileId,
        capability: 'sop:verify',
        reason: input.reason,
        targetType: 'RestaurantSopOccurrence',
        targetId: input.occurrenceId,
      });
    } catch (err) {
      const msg = err instanceof CoAuthorizationError ? err.message : 'Co-authorization failed.';
      throw new SopVerificationError(msg, 'CO_AUTH_REQUIRED');
    }

    const coAuth = await tx.restaurantCoAuthorization.create({
      data: coAuthData,
      select: { id: true },
    });

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
