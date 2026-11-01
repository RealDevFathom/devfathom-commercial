/**
 * PH-POS / POS-09 — what the prescription panel beside the cart is allowed to
 * show.
 *
 * The panel exists so a cashier never navigates away from a half-composed bill
 * to check an authorization. It is therefore a READ, and a narrow one: masked
 * identity only, plus the authorization arithmetic a counter actually needs.
 * Full patient detail stays behind `pharmacyPrescriptions.readPatient`, which
 * audits every access (RX-01).
 *
 * VERIFICATION IS A SIGNATURE, NOT A GLANCE. A line counts as verified only
 * when its RX-03 review item carries a `SIGN` decision — the model's own "sole
 * sale-release event". A cashier cannot reach that state from this panel.
 */

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { maskedPatient } from './patient-prescriptions';

export type CounterPrescriptionLine = {
  prescriptionLineId: string;
  lineNumber: number;
  medicineId: string;
  medicineName: string;
  presentationId: string;
  presentation: string;
  directions: string;
  authorizedCanonicalUnits: number;
  filledCanonicalUnits: number;
  /** Never negative: a cumulative over-fill is a defect to surface, not to hide. */
  remainingAuthorizedUnits: number;
  /** True only when a pharmacist has signed the RX-03 review item (RX-03). */
  verified: boolean;
  /** The most recent review outcome, so an unsigned line explains itself. */
  latestDecision: string | null;
};

export type CounterPrescription = {
  prescriptionId: string;
  prescriberName: string;
  sourceKind: string;
  custodyState: string;
  validFrom: string;
  validUntil: string;
  /** False once `validUntil` has passed, computed against the caller's clock. */
  inDate: boolean;
  authorizedRepeats: number;
  lines: CounterPrescriptionLine[];
};

export type CounterPatientPanel = {
  patientId: string;
  /** CNIC and phone are masked here exactly as `readPatient` masks them. */
  displayName: string;
  cnic: string | null;
  phone: string | null;
  /** True when a current DISPENSING consent is on file for this patient. */
  dispensingConsent: boolean;
  address: string | null;
  prescriptions: CounterPrescription[];
};

export class PharmacyCounterPrescriptionError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'INVALID_QUERY') {
    super(reason);
  }
}

/** Patients a counter can attach to the open bill, by name or masked phone tail. */
export async function searchCounterPatients(
  db: ScopedDb,
  organizationId: string,
  query: string,
  limit = 10
): Promise<Array<{ patientId: string; displayName: string; phone: string | null }>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) throw new PharmacyCounterPrescriptionError('INVALID_QUERY');
  const patients = await db.pharmacyPatient.findMany({
    where: {
      organizationId,
      OR: [
        { displayName: { contains: trimmed, mode: 'insensitive' } },
        { phone: { endsWith: trimmed } },
      ],
    },
    select: { id: true, displayName: true, cnic: true, phone: true, dateOfBirth: true },
    orderBy: { displayName: 'asc' },
    take: Math.min(Math.max(limit, 1), 25),
  });
  return patients.map((patient) => {
    const masked = maskedPatient(patient);
    return { patientId: masked.id, displayName: masked.displayName, phone: masked.phone };
  });
}

/**
 * The panel for one patient: masked identity, live prescriptions, and the
 * remaining authorization on every line.
 *
 * `remainingAuthorizedUnits` is what stops a partial fill from quietly
 * exceeding the prescription (RX-02): fills are cumulative immutable events, so
 * the remainder is always authorized minus the sum of every fill recorded.
 */
export async function readCounterPatientPanel(
  db: ScopedDb,
  organizationId: string,
  patientId: string,
  at: Date = new Date()
): Promise<CounterPatientPanel> {
  const patient = await db.pharmacyPatient.findFirst({
    where: { id: patientId, organizationId },
    select: {
      id: true,
      displayName: true,
      cnic: true,
      phone: true,
      address: true,
      dateOfBirth: true,
      consents: {
        where: { purpose: 'DISPENSING' },
        orderBy: { version: 'desc' },
        select: { granted: true, revokedAt: true },
        take: 1,
      },
      prescriptions: {
        orderBy: { capturedAt: 'desc' },
        take: 10,
        select: {
          id: true,
          sourceKind: true,
          custodyState: true,
          validFrom: true,
          validUntil: true,
          authorizedRepeats: true,
          prescriber: { select: { name: true } },
          lines: {
            orderBy: { lineNumber: 'asc' },
            select: {
              id: true,
              lineNumber: true,
              medicineId: true,
              presentationId: true,
              directions: true,
              authorizedCanonicalUnits: true,
              medicine: { select: { productName: true } },
              presentation: { select: { presentation: true } },
              fills: { select: { quantityCanonicalUnits: true } },
              pharmacistReviewItems: {
                select: {
                  decisions: {
                    orderBy: { createdAt: 'desc' },
                    select: { kind: true, signedAt: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!patient) throw new PharmacyCounterPrescriptionError('NOT_FOUND');

  const masked = maskedPatient(patient);
  const consent = patient.consents[0];

  return {
    patientId: masked.id,
    displayName: masked.displayName,
    cnic: masked.cnic,
    phone: masked.phone,
    address: patient.address,
    dispensingConsent: Boolean(consent?.granted) && consent?.revokedAt === null,
    prescriptions: patient.prescriptions.map((prescription) => ({
      prescriptionId: prescription.id,
      prescriberName: prescription.prescriber.name,
      sourceKind: prescription.sourceKind,
      custodyState: prescription.custodyState,
      validFrom: prescription.validFrom.toISOString(),
      validUntil: prescription.validUntil.toISOString(),
      inDate:
        prescription.validFrom.getTime() <= at.getTime() &&
        prescription.validUntil.getTime() > at.getTime(),
      authorizedRepeats: prescription.authorizedRepeats,
      lines: prescription.lines.map((line) => {
        const filledCanonicalUnits = line.fills.reduce(
          (total, fill) => total + fill.quantityCanonicalUnits,
          0
        );
        const decisions = line.pharmacistReviewItems.flatMap((item) => item.decisions);
        return {
          prescriptionLineId: line.id,
          lineNumber: line.lineNumber,
          medicineId: line.medicineId,
          medicineName: line.medicine.productName,
          presentationId: line.presentationId,
          presentation: line.presentation.presentation,
          directions: line.directions,
          authorizedCanonicalUnits: line.authorizedCanonicalUnits,
          filledCanonicalUnits,
          remainingAuthorizedUnits: Math.max(
            0,
            line.authorizedCanonicalUnits - filledCanonicalUnits
          ),
          verified: decisions.some(
            (decision) => decision.kind === 'SIGN' && decision.signedAt !== null
          ),
          latestDecision: decisions[0]?.kind ?? null,
        };
      }),
    })),
  };
}
