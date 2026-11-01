import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockPatientConsent } from './consent-writer';
import { captureRefillReminder, type RefillCaptureDb, type RefillScope } from './refill-support';
import { canMessageCustomer } from './whatsapp/messages';

type ReviewDb = RefillCaptureDb & Pick<ScopedDb, '$queryRaw' | '$executeRaw' | 'pharmacyCustomer'>;
export type RefillReviewStatus = 'DRAFT' | 'APPROVED' | 'SKIPPED';
export type RefillReview = {
  captureId: string;
  patientId: string;
  medicineName: string;
  reminderAt: Date;
  expectedExhaustionAt: Date;
  status: RefillReviewStatus;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  dispatchStatus: string | null;
  dispatchError: string | null;
};

export class RefillReminderReviewError extends Error {
  constructor(
    readonly reason:
      | 'REFILL_REVIEW_NOT_FOUND'
      | 'REFILL_CAPTURE_CONFLICT'
      | 'REFILL_REVIEW_ALREADY_DECIDED'
      | 'REFILL_REVIEW_CONSENT_REQUIRED'
      | 'REFILL_REVIEW_EXPIRED'
      | 'REFILL_REVIEW_BRANCH_NOT_FOUND'
      | 'REFILL_REVIEW_FILL_NOT_FOUND'
  ) {
    super(reason);
    this.name = 'RefillReminderReviewError';
  }
}

async function requireBranch(
  db: ReviewDb,
  scope: Pick<RefillScope, 'organizationId' | 'branchId'>
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { id: true },
  });
  if (!branch) throw new RefillReminderReviewError('REFILL_REVIEW_BRANCH_NOT_FOUND');
  await db.$queryRaw(
    Prisma.sql`SELECT set_config('app.current_branch_id', ${scope.branchId}, true)`
  );
}

/**
 * Transaction-only orchestration of the shipped clinical capture. Both rows
 * commit together, so the legacy scheduler cannot see an unreviewed capture
 * between capture and review. Ordinary RX-07 capture callers are unchanged.
 */
export async function captureRefillReminderForReview(
  db: ReviewDb,
  scope: RefillScope,
  input: { fillId: string; directionsUrdu: string; idempotencyKey: string }
) {
  await requireBranch(db, scope);
  // Serialize full-flow capture retries, not outbox/dispatcher send claims.
  await db.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`refill-review:${scope.organizationId}`}, 0))
  `);
  const previous = await db.pharmacyRefillReminderCapture.findFirst({
    where: {
      organizationId: scope.organizationId,
      OR: [{ idempotencyKey: input.idempotencyKey }, { prescriptionFillId: input.fillId }],
    },
  });
  if (previous) {
    const reviews = await db.$queryRaw<Array<{ captureId: string }>>(Prisma.sql`
      SELECT "captureId" FROM "pharmacy_refill_reminder_reviews"
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND "captureId" = ${previous.id}
    `);
    if (
      previous.branchId !== scope.branchId ||
      previous.prescriptionFillId !== input.fillId ||
      previous.idempotencyKey !== input.idempotencyKey ||
      previous.directionsUrdu !== input.directionsUrdu.trim() ||
      previous.channel !== 'WHATSAPP' ||
      reviews.length !== 1
    )
      throw new RefillReminderReviewError('REFILL_CAPTURE_CONFLICT');
    return previous;
  }
  // This base's clinical fills are tenant-wide (no branch column). Enroll in
  // the explicitly selected active branch; the shipped capture additionally
  // requires that branch's pharmacist sale evidence for prescription medicines.
  const fill = await db.prescriptionFill.findFirst({
    where: {
      id: input.fillId,
      organizationId: scope.organizationId,
    },
    select: { line: { select: { prescription: { select: { patientId: true } } } } },
  });
  if (!fill) throw new RefillReminderReviewError('REFILL_REVIEW_FILL_NOT_FOUND');
  await lockPatientConsent(db, scope.organizationId, fill.line.prescription.patientId);
  let capture;
  try {
    capture = await captureRefillReminder(db, scope, { ...input, channel: 'WHATSAPP' });
  } catch (error) {
    // RLS deliberately hides another branch's capture. A fill/key collision
    // (including a concurrent legacy capture) is a conflict, never re-enrollment.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new RefillReminderReviewError('REFILL_CAPTURE_CONFLICT');
    throw error;
  }
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "pharmacy_refill_reminder_reviews" ("organizationId", "branchId", "captureId")
    VALUES (${scope.organizationId}, ${scope.branchId}, ${capture.id})
  `);
  return capture;
}

export async function listRefillReminderReviews(
  db: ReviewDb,
  scope: Pick<RefillScope, 'organizationId' | 'branchId'>
) {
  await requireBranch(db, scope);
  return db.$queryRaw<RefillReview[]>(Prisma.sql`
    SELECT review."captureId", capture."patientId", capture."medicineName",
           capture."reminderAt", capture."expectedExhaustionAt", review."status",
           review."decidedByUserId", review."decidedAt",
           log."status" AS "dispatchStatus", log."error" AS "dispatchError"
    FROM "pharmacy_refill_reminder_reviews" review
    JOIN "pharmacy_refill_reminder_captures" capture
      ON capture."organizationId" = review."organizationId"
      AND capture."branchId" = review."branchId" AND capture."id" = review."captureId"
    LEFT JOIN LATERAL (
      SELECT "status", "error" FROM "pharmacy_message_logs"
      WHERE "organizationId" = review."organizationId" AND "branchId" = review."branchId"
        AND "refillCaptureId" = review."captureId" AND "direction" = 'OUTBOUND'
        AND "kind" = 'REFILL_REMINDER'
      ORDER BY "createdAt" DESC, "id" LIMIT 1
    ) log ON true
    WHERE review."organizationId" = ${scope.organizationId} AND review."branchId" = ${scope.branchId}
    ORDER BY (review."status" = 'DRAFT') DESC, capture."reminderAt", capture."id"
    LIMIT 100
  `);
}

/**
 * Reuses the candidate's expected-status approval contract, but never its
 * send callback or parallel cadence/AI store. The capture stays immutable.
 * Caller supplies one tenant transaction; patient first, then review row.
 */
export async function reviewRefillReminder(
  db: ReviewDb,
  scope: RefillScope,
  input: { captureId: string; decision: 'APPROVED' | 'SKIPPED' },
  now = new Date()
) {
  await requireBranch(db, scope);
  const [capture] = await db.$queryRaw<Array<{ patientId: string; expectedExhaustionAt: Date }>>(
    Prisma.sql`
      SELECT "patientId", "expectedExhaustionAt" FROM "pharmacy_refill_reminder_captures"
      WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
        AND "id" = ${input.captureId} AND "channel" = 'WHATSAPP'
    `
  );
  if (!capture) throw new RefillReminderReviewError('REFILL_REVIEW_NOT_FOUND');
  await lockPatientConsent(db, scope.organizationId, capture.patientId);
  const [review] = await db.$queryRaw<
    Array<{ status: RefillReviewStatus; decidedByUserId: string | null; decidedAt: Date | null }>
  >(Prisma.sql`
    SELECT "status", "decidedByUserId", "decidedAt" FROM "pharmacy_refill_reminder_reviews"
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "captureId" = ${input.captureId} FOR UPDATE
  `);
  if (!review) throw new RefillReminderReviewError('REFILL_REVIEW_NOT_FOUND');
  // A lost response may be retried, but never overwrite the first reviewer.
  if (review.status === input.decision) return review;
  if (review.status !== 'DRAFT')
    throw new RefillReminderReviewError('REFILL_REVIEW_ALREADY_DECIDED');
  if (input.decision === 'APPROVED') {
    if (capture.expectedExhaustionAt <= now)
      throw new RefillReminderReviewError('REFILL_REVIEW_EXPIRED');
    const customer = await db.pharmacyCustomer.findFirst({
      where: { organizationId: scope.organizationId, patientId: capture.patientId },
      select: { active: true, whatsappOptIn: true },
    });
    const consent = await db.patientConsent.findFirst({
      where: {
        organizationId: scope.organizationId,
        patientId: capture.patientId,
        purpose: 'REMINDERS',
        channel: 'WHATSAPP',
      },
      orderBy: { version: 'desc' },
      select: { granted: true, revokedAt: true, recordedAt: true },
    });
    if (
      !canMessageCustomer(customer) ||
      !consent?.granted ||
      consent.revokedAt ||
      consent.recordedAt > now
    )
      throw new RefillReminderReviewError('REFILL_REVIEW_CONSENT_REQUIRED');
  }
  const [next] = await db.$queryRaw<
    Array<{ status: RefillReviewStatus; decidedByUserId: string; decidedAt: Date }>
  >(Prisma.sql`
    UPDATE "pharmacy_refill_reminder_reviews"
    SET "status" = ${input.decision}, "decidedByUserId" = ${scope.actorId}, "decidedAt" = ${now}
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "captureId" = ${input.captureId} AND "status" = 'DRAFT'
    RETURNING "status", "decidedByUserId", "decidedAt"
  `);
  if (!next) throw new RefillReminderReviewError('REFILL_REVIEW_ALREADY_DECIDED');
  return next;
}
