import 'server-only';
import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { confirmControlledApproval } from './controlled-sale-approval';
import { appendControlledSaleEntries } from './controlled-register';
import { RX_REVIEW_SIGNER_MESSAGES, rxReviewSignerDenial } from './rx-review-self-sign';

const action = 'pharmacyDispensing.lateControlledReview';
const statement = 'No witness: recorded late by one pharmacist';

export async function completeLateControlledReview(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorId: string;
    reviewItemId: string;
    reason: string;
    pin: string;
  }
) {
  const { organizationId, actorId, reviewItemId, reason, pin } = input;
  return db.$transaction(async (transaction) => {
    const tx = transaction as ScopedDb;
    // Serialize retries on the original line, and hold its classification through commit.
    const [original] = await tx.$queryRaw<
      { id: string; branchId: string }[]
    >`SELECT l.id,l."branchId"
      FROM pharmacy_pharmacist_review_items i JOIN pharmacy_sale_lines l
        ON l."organizationId"=i."organizationId" AND l.id=i."saleLineId" AND l."prescriptionLineId"=i."prescriptionLineId"
      JOIN pharmacy_medicines m ON m."organizationId"=l."organizationId" AND m.id=l."medicineId"
      WHERE i."organizationId"=${organizationId} AND i.id=${reviewItemId} AND m.controlled
      FOR UPDATE OF i FOR SHARE OF l,m`;
    if (!original)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'This review has no original sale prescription for a reclassified medicine.',
      });
    const { branchId } = original;
    const scope = { organizationId, branchId, actorId };
    const denial = await rxReviewSignerDenial(tx, { organizationId, branchId, userId: actorId });
    if (denial)
      throw new TRPCError({ code: 'FORBIDDEN', message: RX_REVIEW_SIGNER_MESSAGES[denial] });
    const profile = await tx.restaurantOperatorCredential.findFirst({
      where: {
        organizationId,
        type: 'PIN',
        deviceId: null,
        revokedAt: null,
        staffProfile: { userId: actorId, status: 'ACTIVE' },
      },
      select: { staffProfileId: true },
    });
    const approval =
      profile &&
      (await confirmControlledApproval(tx, scope, { ...profile, pin, selfApproval: true }, action));
    if (!approval || (approval.method !== 'PIN' && approval.method !== 'AUTHENTICATOR'))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Enter your own current PIN or authenticator code to record the late entry.',
      });
    const previous = await tx.pharmacyControlledRegisterEntry.findFirst({
      where: { organizationId, branchId, lateSaleLineId: original.id },
      select: { signatureRef: true },
    });
    if (previous?.signatureRef)
      return tx.pharmacyPharmacistReviewDecision.findUniqueOrThrow({
        where: { id: previous.signatureRef },
      });
    const line = await tx.pharmacySaleLine.findUniqueOrThrow({
      where: { id: original.id },
      include: {
        medicine: { select: { manufacturer: true } },
        sale: { select: { completedAt: true } },
        allocations: { orderBy: { id: 'asc' } },
        prescriptionLine: {
          include: {
            prescription: {
              include: {
                patient: { select: { cnic: true, address: true } },
                prescriber: { select: { name: true, registrationNumber: true } },
              },
            },
          },
        },
      },
    });
    const rx = line.prescriptionLine;
    const prescription = rx?.prescription;
    if (
      !rx ||
      !prescription ||
      rx.medicineId !== line.medicineId ||
      rx.presentationId !== line.presentationId ||
      prescription.patientId !== line.prescriptionPatientId ||
      !prescription.patient.address?.trim() ||
      !prescription.patient.cnic?.trim() ||
      !prescription.prescriber.registrationNumber.trim() ||
      !line.allocations.length ||
      line.allocations.reduce((n, a) => n + a.canonicalUnits, 0) !== line.canonicalUnits
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'The original prescription, patient details and stock movements are required for this late entry.',
      });
    const consent = await tx.patientConsent.findFirst({
      where: { organizationId, patientId: prescription.patientId, purpose: 'DISPENSING' },
      orderBy: { version: 'desc' },
    });
    if (!consent?.granted || consent.revokedAt)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Patient dispensing consent is required.',
      });
    const originalSaleAt = line.sale.completedAt ?? line.createdAt;
    const signedAt = new Date();
    const audit = await tx.auditLog.create({
      data: {
        organizationId,
        actorId,
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'EXECUTE',
        action,
        outcome: 'SUCCESS',
        targetType: 'PharmacyPharmacistReviewItem',
        targetId: reviewItemId,
        description: statement,
        metadata: {
          branchId,
          reviewItemId,
          saleLineId: line.id,
          saleId: line.saleId,
          reason,
          selfApproved: true,
          approvalMethod: approval.method,
          pinVerified: approval.method === 'PIN',
          authenticatorVerified: approval.method === 'AUTHENTICATOR',
          originalSaleAt: originalSaleAt.toISOString(),
          approvedAt: signedAt.toISOString(),
        },
      },
    });
    const decision = await tx.pharmacyPharmacistReviewDecision.create({
      data: {
        organizationId,
        reviewItemId,
        kind: 'SIGN',
        actorUserId: actorId,
        reason,
        signedAt,
        selfApprovalAuditId: audit.id,
      },
    });
    await appendControlledSaleEntries(tx, {
      organizationId,
      branchId,
      movementIds: line.allocations.map((a) => a.stockMovementId),
      patientId: prescription.patientId,
      patientAddress: prescription.patient.address,
      medicineId: line.medicineId,
      manufacturer: line.medicine.manufacturer,
      prescriberId: prescription.prescriberId,
      prescriberName: prescription.prescriber.name,
      prescriberRegNo: prescription.prescriber.registrationNumber,
      prescriptionId: prescription.id,
      prescriptionLineId: rx.id,
      emergency: false,
      rxSerialWritten: false,
      refEntryId: null,
      recordedByUserId: actorId,
      witnessedByUserId: null,
      witnessStatement: statement,
      signatureRef: decision.id,
      late: {
        lateSaleLineId: line.id,
        originalSaleAt,
        lateEntryReason: reason,
        createdAt: signedAt,
      },
    });
    return decision;
  });
}
