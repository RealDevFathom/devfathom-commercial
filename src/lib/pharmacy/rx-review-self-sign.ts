import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { otherBranchApproversWithPin } from './card-terminal/review-approvers';
import { counterBranchAssignmentDenial } from './counter-capability';

/**
 * DEV-950 — a pharmacist working alone signs the RX-03 review of a prescription line they rang
 * up themselves (the solo rule, owner decision on DEV-622, 15 Nov 2026: "Controls that need a
 * second person keep the solo rule: self-approval with a fresh PIN and an audit record").
 *
 * The review asks for a second person: `addLine` queues it with the seller as requester, and the
 * database refuses a decision by the requester (`pharmacy_review_no_self_approval`). A different
 * pharmacist still signs it from the pharmacist queue (`decideReview`), as before. The requester
 * may sign it only when all of this holds, checked again inside the write's transaction:
 *   - they hold `pharmacy:dispense` and may act at the line's branch;
 *   - nobody else could sign it there: no other active member with a working own PIN, assigned
 *     to that branch (or a session ADMIN), holds `pharmacy:dispense`. This is the solo rule as
 *     `otherCardTerminalReviewers` defines it, with the pharmacist's right and the branch
 *     assignment in place of the manager's right and the counter gate, because a pharmacist signs
 *     reviews without the counter grant;
 *   - the medicine is not controlled: a controlled line's review is signed by the independent
 *     pharmacist who witnesses the controlled register, and that rule is unchanged;
 *   - they re-entered their own PIN for this signature (checked by the caller, shared lockout);
 *   - the review is not signed yet.
 * The audit entry (who, when, which sale and line, marked self-approved) is written first, in the
 * same transaction, and the signature names it. The database admits a requester's signature only
 * with that entry (migration 20261118124300), so the entry cannot be skipped.
 */

export const RX_SELF_SIGN_AUDIT_ACTION = 'pharmacyDispensing.selfSignReview';
export const RX_SELF_SIGN_POLICY = 'PHARMACY_RX_REVIEW_SOLO_SELF_SIGN_PIN';

export type RxSelfSignScope = { organizationId: string; branchId: string; actorId: string };

/** The other people who could sign a prescription review at this branch; empty means solo. */
export function otherRxReviewSigners(db: ScopedDb, scope: RxSelfSignScope, now = new Date()) {
  return otherBranchApproversWithPin(db, scope, async (other) => {
    if (await counterBranchAssignmentDenial(db, other, scope.organizationId, scope.branchId))
      return false;
    return can(subjectFromSession(other), 'pharmacy:dispense', undefined, {
      db,
      now,
      source: 'TRPC',
    });
  });
}

const MESSAGES = {
  NOT_FOUND: 'This prescription review was not found.',
  NOT_REQUESTER:
    'You did not ring up this line. Sign it from the pharmacist queue with your own decision.',
  NOT_ALLOWED:
    'Only a pharmacist with the dispensing permission at this branch can sign this line.',
  CONTROLLED:
    'A controlled medicine needs an independent pharmacist’s signature. It cannot be self-signed.',
  ALREADY_SIGNED: 'This prescription line is already signed.',
  SECOND_PHARMACIST: 'Another pharmacist at this branch must sign a line you rang up.',
} as const;

export type RxSelfSignRefusal = keyof typeof MESSAGES;

export class RxSelfSignError extends Error {
  constructor(
    readonly reason: RxSelfSignRefusal,
    /** For SECOND_PHARMACIST: someone who can sign it here. */
    readonly askName: string | null = null
  ) {
    super(
      reason === 'SECOND_PHARMACIST'
        ? `${MESSAGES.SECOND_PHARMACIST} Ask ${askName ?? 'another pharmacist'} to sign it in the pharmacist queue.`
        : MESSAGES[reason]
    );
    this.name = 'RxSelfSignError';
  }
}

type Actor = {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
};

export type RxSelfSignContext = {
  reviewItemId: string;
  saleId: string;
  saleLineId: string;
  branchId: string;
};

/**
 * Every rule except the PIN, for one review item. Throws `RxSelfSignError`; returns the review's
 * sale, line and branch. `lock` takes the review row's lock first, so two signatures of one
 * review cannot both pass the "not signed yet" check.
 */
export async function assertRxSelfSignAllowed(
  db: ScopedDb,
  input: { organizationId: string; actor: Actor; reviewItemId: string; lock?: boolean },
  now = new Date()
): Promise<RxSelfSignContext> {
  const { organizationId, actor, reviewItemId } = input;
  if (input.lock)
    await db.$queryRaw`SELECT id FROM pharmacy_pharmacist_review_items WHERE "organizationId"=${organizationId} AND id=${reviewItemId} FOR UPDATE`;
  const item = await db.pharmacyPharmacistReviewItem.findFirst({
    where: { id: reviewItemId, organizationId },
    select: { id: true, saleLineId: true, requestedByUserId: true },
  });
  if (!item) throw new RxSelfSignError('NOT_FOUND');
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: item.saleLineId, organizationId },
    select: { id: true, saleId: true, branchId: true, medicine: { select: { controlled: true } } },
  });
  if (!line) throw new RxSelfSignError('NOT_FOUND');
  if (item.requestedByUserId !== actor.id) throw new RxSelfSignError('NOT_REQUESTER');
  if (
    !(await can(subjectFromSession(actor), 'pharmacy:dispense', undefined, {
      db,
      now,
      source: 'TRPC',
    })) ||
    (await counterBranchAssignmentDenial(db, actor, organizationId, line.branchId))
  )
    throw new RxSelfSignError('NOT_ALLOWED');
  if (line.medicine.controlled) throw new RxSelfSignError('CONTROLLED');
  const signed = await db.pharmacyPharmacistReviewDecision.findFirst({
    where: { organizationId, reviewItemId, kind: 'SIGN', signedAt: { not: null } },
    select: { id: true },
  });
  if (signed) throw new RxSelfSignError('ALREADY_SIGNED');
  const [other] = await otherRxReviewSigners(
    db,
    { organizationId, branchId: line.branchId, actorId: actor.id },
    now
  );
  if (other) throw new RxSelfSignError('SECOND_PHARMACIST', other.name);
  return { reviewItemId, saleId: line.saleId, saleLineId: line.id, branchId: line.branchId };
}

/**
 * Write the self-signature: the rules again under the review's lock, then the audit entry, then
 * the SIGN decision that names it. Run inside the request's transaction, after the caller verified
 * the person's own PIN in its own transaction (so a wrong PIN keeps its lockout strike).
 */
export async function selfSignRxReview(
  db: ScopedDb,
  input: { organizationId: string; actor: Actor; reviewItemId: string },
  now = new Date()
) {
  const context = await assertRxSelfSignAllowed(db, { ...input, lock: true }, now);
  const audit = await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actor.id,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'EXECUTE',
      action: RX_SELF_SIGN_AUDIT_ACTION,
      outcome: 'SUCCESS',
      description: 'Prescription line self-signed by a sole pharmacist with a fresh PIN',
      targetType: 'PharmacyPharmacistReviewItem',
      targetId: context.reviewItemId,
      metadata: {
        policy: RX_SELF_SIGN_POLICY,
        selfApproved: true,
        pinVerified: true,
        soloRule: true,
        approverId: input.actor.id,
        initiatedById: input.actor.id,
        approvedAt: now.toISOString(),
        reviewItemId: context.reviewItemId,
        saleId: context.saleId,
        saleLineId: context.saleLineId,
        branchId: context.branchId,
      },
    },
    select: { id: true },
  });
  const decision = await db.pharmacyPharmacistReviewDecision.create({
    data: {
      organizationId: input.organizationId,
      reviewItemId: context.reviewItemId,
      kind: 'SIGN',
      actorUserId: input.actor.id,
      signedAt: now,
      selfApprovalAuditId: audit.id,
    },
  });
  return { decision, auditId: audit.id, ...context };
}
