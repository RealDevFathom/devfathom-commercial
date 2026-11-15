import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { CounterReceipt } from './counter-receipt';
import type { DispensingLabelSource } from './dispensing-label';
import { regulatoryProfileInForceWhere } from './regulatory-start';

/** Read-only label provenance. Never translate directions or substitute a licence. */
export async function readDispensingLabelSources(
  db: ScopedDb,
  { organizationId, branchId }: { organizationId: string; branchId: string },
  receipt: CounterReceipt,
  timeZone?: string | null
): Promise<DispensingLabelSource[]> {
  const scope = { organizationId, branchId };
  if (receipt.receiptNumber === null || !receipt.completedAt) return [];
  const at = new Date(receipt.completedAt);
  const [profile, lines] = await Promise.all([
    db.branchRegulatoryProfile.findFirst({
      where: {
        ...scope,
        // DEV-298: a sale on a profile's start day uses it from local midnight.
        ...regulatoryProfileInForceWhere(at, timeZone),
      },
      orderBy: { version: 'desc' },
      select: { licenceNumber: true, qualifiedPersonRegistration: true },
    }),
    db.pharmacySaleLine.findMany({
      where: {
        ...scope,
        saleId: receipt.saleId,
        sale: { status: 'COMPLETED' },
        medicine: { rx: true },
        id: {
          in: receipt.lines
            .filter((line) => line.identityStatus === 'ISSUED')
            .map((line) => line.saleLineId),
        },
      },
      select: { id: true, medicineId: true, presentationId: true },
    }),
  ]);
  if (!profile?.licenceNumber.trim() || !profile.qualifiedPersonRegistration.trim()) return [];
  const sources: DispensingLabelSource[] = [];
  for (const line of lines) {
    const captures = await db.pharmacyRefillReminderCapture.findMany({
      where: {
        ...scope,
        pharmacistDecision: {
          organizationId: scope.organizationId,
          kind: 'SIGN',
          signedAt: { not: null },
          reviewItem: {
            organizationId: scope.organizationId,
            saleLineId: line.id,
            line: { medicineId: line.medicineId, presentationId: line.presentationId },
          },
        },
      },
      select: {
        directionsEnglish: true,
        directionsUrdu: true,
        fill: { select: { prescriptionLineId: true } },
        pharmacistDecision: {
          select: { actorUserId: true, reviewItem: { select: { prescriptionLineId: true } } },
        },
      },
      take: 2,
    });
    // Ambiguous captures and mismatched fill/review links fail closed.
    if (captures.length !== 1) continue;
    const capture = captures[0]!;
    if (
      !capture.pharmacistDecision ||
      capture.fill.prescriptionLineId !==
        capture.pharmacistDecision.reviewItem.prescriptionLineId ||
      !capture.directionsEnglish.trim() ||
      !capture.directionsUrdu.trim()
    )
      continue;
    const actor = await db.user.findFirst({
      where: { organizationId: scope.organizationId, id: capture.pharmacistDecision.actorUserId },
      select: { name: true },
    });
    sources.push({
      saleId: receipt.saleId,
      saleLineId: line.id,
      rx: true,
      licenceNumber: profile.licenceNumber,
      pharmacistRegistration: profile.qualifiedPersonRegistration,
      ...(actor?.name.trim() ? { pharmacistName: actor.name } : {}),
      directionsEnglish: capture.directionsEnglish,
      directionsUrdu: capture.directionsUrdu,
    });
  }
  return sources;
}
