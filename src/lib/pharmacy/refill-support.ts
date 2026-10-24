import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { assertClinicalDetailPurpose } from './patient-prescriptions';

const DAY_MS = 86_400_000;
const REMINDER_LEAD_DAYS = 3;

export type RefillScope = { organizationId: string; branchId: string; actorId: string };
export type RefillCaptureDb = Pick<
  ScopedDb,
  | 'pharmacyBranch'
  | 'prescriptionFill'
  | 'patientConsent'
  | 'pharmacyPharmacistReviewDecision'
  | 'pharmacySaleLine'
  | 'pharmacyRefillReminderCapture'
>;

export type ReminderChannel = 'PHONE' | 'SMS' | 'WHATSAPP' | 'EMAIL';

export class RefillSupportError extends Error {
  constructor(
    readonly reason:
      | 'AMBIGUOUS_DIRECTIONS'
      | 'FILL_NOT_FOUND'
      | 'BRANCH_NOT_FOUND'
      | 'REMINDER_CONSENT_REQUIRED'
      | 'PHARMACIST_APPROVAL_REQUIRED'
  ) {
    super(reason);
    this.name = 'RefillSupportError';
  }
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
};

function numberFrom(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = NUMBER_WORDS[value] ?? Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * RX-07 deliberately recognizes a small, deterministic direction grammar.
 * Anything conditional or outside that grammar returns null for pharmacist
 * review instead of guessing a clinically meaningful cadence.
 */
export function dosesPerDayFromDirections(directions: string): number | null {
  const normalized = directions.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(as needed|when required|prn|if needed)\b/.test(normalized)) return null;

  const everyHours = normalized.match(/\bevery\s+(\d+(?:\.\d+)?)\s*hours?\b/);
  const frequencyMatch = normalized.match(
    /\b(once|twice|three times|four times|1 time|2 times|3 times|4 times)\s+(?:a\s+day|daily)\b/
  );
  const plainDaily = /\b(?:daily|a day|per day)\b/.test(normalized);
  if (!everyHours && !frequencyMatch && !plainDaily) return null;

  const unitAmountMatch = normalized.match(
    /\b(one|two|three|four|\d+(?:\.\d+)?)\s*(?:tablets?|capsules?|units?|doses?|ml)\b/
  );
  const unitsPerDose = numberFrom(unitAmountMatch?.[1]) ?? 1;

  let administrationsPerDay: number;
  if (everyHours) {
    const hours = Number(everyHours[1]);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 || 24 % hours !== 0) return null;
    administrationsPerDay = 24 / hours;
  } else if (frequencyMatch) {
    const frequency = frequencyMatch[1];
    administrationsPerDay =
      frequency === 'once' || frequency === '1 time'
        ? 1
        : frequency === 'twice' || frequency === '2 times'
          ? 2
          : frequency === 'three times' || frequency === '3 times'
            ? 3
            : 4;
  } else {
    administrationsPerDay = 1;
  }

  const result = unitsPerDose * administrationsPerDay;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function deriveRefillSchedule(input: {
  dispensedAt: Date;
  quantityDispensed: number;
  directions: string;
}) {
  if (!Number.isSafeInteger(input.quantityDispensed) || input.quantityDispensed <= 0)
    throw new RefillSupportError('AMBIGUOUS_DIRECTIONS');
  const dosesPerDay = dosesPerDayFromDirections(input.directions);
  if (!dosesPerDay) throw new RefillSupportError('AMBIGUOUS_DIRECTIONS');

  const supplyDays = input.quantityDispensed / dosesPerDay;
  const expectedExhaustionAt = new Date(input.dispensedAt.getTime() + supplyDays * DAY_MS);
  const reminderAt = new Date(
    Math.max(
      input.dispensedAt.getTime(),
      expectedExhaustionAt.getTime() - REMINDER_LEAD_DAYS * DAY_MS
    )
  );
  return { dosesPerDay, supplyDays, expectedExhaustionAt, reminderAt };
}

function strengthLabel(
  strengths: readonly { value: { toString(): string }; unit: string }[]
): string {
  if (strengths.length === 0) return 'Not recorded';
  return strengths.map((item) => `${item.value.toString()} ${item.unit}`).join(' + ');
}

/**
 * Creates a capture-only reminder draft. It never invokes a delivery adapter.
 * Consent and pharmacist evidence are resolved before clinical data is copied
 * into the patient-context capture row (RX-01, RX-03, invariant 21).
 */
export async function captureRefillReminder(
  db: RefillCaptureDb,
  scope: RefillScope,
  input: {
    fillId: string;
    channel: ReminderChannel;
    directionsUrdu: string;
    idempotencyKey: string;
  }
) {
  assertClinicalDetailPurpose('REMINDERS', 'MEDICINE');

  const [branch, fill] = await Promise.all([
    db.pharmacyBranch.findFirst({
      where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
      select: { id: true },
    }),
    db.prescriptionFill.findFirst({
      where: { id: input.fillId, organizationId: scope.organizationId },
      include: {
        line: {
          include: {
            medicine: { include: { strengths: true } },
            presentation: true,
            prescription: { select: { patientId: true } },
          },
        },
      },
    }),
  ]);
  if (!branch) throw new RefillSupportError('BRANCH_NOT_FOUND');
  if (!fill) throw new RefillSupportError('FILL_NOT_FOUND');

  const consent = await db.patientConsent.findFirst({
    where: {
      organizationId: scope.organizationId,
      patientId: fill.line.prescription.patientId,
      purpose: 'REMINDERS',
      channel: input.channel,
    },
    orderBy: { version: 'desc' },
  });
  if (!consent?.granted || consent.revokedAt || consent.recordedAt > new Date())
    throw new RefillSupportError('REMINDER_CONSENT_REQUIRED');

  const pharmacistDecision = fill.line.medicine.rx
    ? await db.pharmacyPharmacistReviewDecision.findFirst({
        where: {
          organizationId: scope.organizationId,
          kind: 'SIGN',
          signedAt: { not: null },
          reviewItem: { prescriptionLineId: fill.prescriptionLineId },
        },
        orderBy: { createdAt: 'desc' },
        include: { reviewItem: { select: { saleLineId: true } } },
      })
    : null;
  const reviewedSaleLine = pharmacistDecision
    ? await db.pharmacySaleLine.findFirst({
        where: {
          id: pharmacistDecision.reviewItem.saleLineId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
        select: { id: true },
      })
    : null;
  if (fill.line.medicine.rx && (!pharmacistDecision || !reviewedSaleLine))
    throw new RefillSupportError('PHARMACIST_APPROVAL_REQUIRED');

  const schedule = deriveRefillSchedule({
    dispensedAt: fill.dispensedAt,
    quantityDispensed: fill.quantityCanonicalUnits,
    directions: fill.line.directions,
  });

  return db.pharmacyRefillReminderCapture.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      prescriptionFillId: fill.id,
      patientId: fill.line.prescription.patientId,
      channel: input.channel,
      consentEventId: consent.id,
      pharmacistDecisionId: pharmacistDecision?.id,
      medicineName: fill.line.medicine.productName,
      strength: strengthLabel(fill.line.medicine.strengths),
      dosageForm: fill.line.presentation.dosageForm ?? fill.line.presentation.presentation,
      directionsEnglish: fill.line.directions,
      directionsUrdu: input.directionsUrdu.trim(),
      quantityDispensed: fill.quantityCanonicalUnits,
      dosesPerDay: schedule.dosesPerDay,
      expectedExhaustionAt: schedule.expectedExhaustionAt,
      reminderAt: schedule.reminderAt,
      capturedByUserId: scope.actorId,
      idempotencyKey: input.idempotencyKey,
    },
  });
}
