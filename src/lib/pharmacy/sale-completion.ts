import 'server-only';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { postSaleLineEntry } from './finance-postings';
import { assertSaleBatchesSellable } from './sale-batch-safety';
import { PharmacyReceiptIdentityError, validateReceiptIdentity } from './receipt-identity';
import { assertRxSaleAllowed } from './rx-sale-gate';
import { readPharmacyReceiptTaxIdentity } from './receipt-print';
import { sindhCashMemoSelected } from './counter-receipt';
import {
  assertRxLinesPrescribed,
  recordCompletedPrescriptionReference,
} from './rx-prescription-reference';

export const completionSaleInclude = {
  lines: {
    include: {
      medicine: { include: { strengths: { orderBy: { id: 'asc' } } } },
      presentation: true,
      allocations: { orderBy: { id: 'asc' }, include: { lot: { include: { batch: true } } } },
    },
  },
  tenders: true,
  // #708: the sale's customer names the buyer on a cash memo when none is typed.
  customer: { select: { displayName: true } },
} satisfies Prisma.PharmacySaleInclude;

// Characters receipt text rejects (controls, bidi overrides and isolates, lone surrogates).
const UNPRINTABLE_RECEIPT_TEXT = /\s*[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩\p{Cs}]+\s*/gu;

/**
 * Trimmed, length-clamped snapshot text; blank values are omitted, never stored empty.
 * Stored names can carry characters a receipt refuses to print, which would make an
 * issued memo unprintable forever, so each such run becomes one space. Clamping comes
 * first so a character split at the limit is removed rather than left half-written.
 */
function snapshotText(value: string | null | undefined, max: number): string | undefined {
  const text = value?.trim().slice(0, max).replace(UNPRINTABLE_RECEIPT_TEXT, ' ').trim();
  return text || undefined;
}

// Internal: callers hold the sale lock and have verified exact paid coverage in this transaction.
export async function completePaidPharmacySale(
  db: ScopedDb,
  scope: LedgerScope,
  sale: Prisma.PharmacySaleGetPayload<{ include: typeof completionSaleInclude }>,
  input: { deviceId: string; businessDate: Date; buyerName?: string },
  /** F2: a leased offline receipt number the caller already consumed in this transaction. */
  leasedReceiptNumber: number | null = null,
  /** Provider-backed settlement keeps the instant checked before charging. */
  issuedAt: Date = new Date()
) {
  // #518: every completion path re-checks who may sell Rx/restricted non-controlled lines.
  await assertRxSaleAllowed(
    db,
    scope,
    sale.lines.map((line) => line.medicine)
  );
  // DEV-629: and that every such line carries a pharmacist-attached, pharmacist-signed prescription.
  await assertRxLinesPrescribed(db, sale.lines);
  // #659: re-check every batch under lock before a receipt number is drawn. The receipt
  // snapshot below records these checked facts, not the ones loaded with the sale.
  const checkedBatches = await assertSaleBatchesSellable(db, scope, sale.id);
  let receiptNumber = leasedReceiptNumber;
  if (receiptNumber === null) {
    // Reserved (leased) numbers never return to this online sequence.
    const rows = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
      INSERT INTO pharmacy_receipt_number_sequences (id, "organizationId", "branchId", "deviceId", "nextNumber", "updatedAt")
      VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.deviceId}, 2, now())
      ON CONFLICT ("organizationId", "branchId", "deviceId")
      DO UPDATE SET "nextNumber" = pharmacy_receipt_number_sequences."nextNumber" + 1, "updatedAt" = now()
      RETURNING "nextNumber" - 1 AS receipt_number`);
    receiptNumber = rows[0]!.receipt_number;
  }
  await db.pharmacySale.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
    data: {
      status: 'COMPLETED',
      completedAt: issuedAt,
      receiptNumber,
      receiptDeviceId: input.deviceId,
      businessDate: input.businessDate,
    },
  });
  for (const line of sale.lines) {
    if (line.prescriptionLineId) {
      await recordCompletedPrescriptionReference(
        db,
        scope,
        {
          id: line.id,
          organizationId: line.organizationId,
          branchId: line.branchId,
          medicineId: line.medicineId,
          presentationId: line.presentationId,
          canonicalUnits: line.canonicalUnits,
          prescriptionLineId: line.prescriptionLineId,
          prescriptionPatientId: line.prescriptionPatientId ?? null,
          saleId: sale.id,
        },
        issuedAt
      );
    }
  }
  for (const line of sale.lines) {
    if (
      line.organizationId !== scope.organizationId ||
      line.branchId !== scope.branchId ||
      line.medicine.organizationId !== scope.organizationId ||
      line.presentation.organizationId !== scope.organizationId ||
      line.presentation.medicineId !== line.medicineId ||
      line.allocations.some(
        (allocation) =>
          allocation.organizationId !== scope.organizationId ||
          allocation.branchId !== scope.branchId ||
          allocation.lot.organizationId !== scope.organizationId ||
          allocation.lot.branchId !== scope.branchId ||
          allocation.lot.batch.organizationId !== scope.organizationId ||
          allocation.lot.batch.medicineId !== line.medicineId
      )
    )
      throw new PharmacyReceiptIdentityError();
  }
  // #708: typed at tender first, else the sale's customer; an unnamed walk-in stays blank.
  const buyerName =
    snapshotText(input.buyerName, 200) ?? snapshotText(sale.customer?.displayName, 200);
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const regulatoryIdentity = await readPharmacyReceiptTaxIdentity(
    db,
    scope,
    issuedAt,
    organization?.timezone
  );
  // #708 hold: the receipt mode is chosen here, and stays ordinary until counsel confirms
  // the cash memo, even for a Sindh profile. The choice is frozen into the snapshot.
  const cashMemoIdentity = sindhCashMemoSelected(regulatoryIdentity.provinceCode)
    ? regulatoryIdentity
    : null;
  const snapshot = validateReceiptIdentity(
    {
      receiptIdentitySnapshotVersion: 1,
      cashMemoIdentity,
      saleId: sale.id,
      receiptNumber,
      deviceId: input.deviceId,
      businessDate: input.businessDate.toISOString().slice(0, 10),
      issuedAt: issuedAt.toISOString(),
      // Only a cash memo names its buyer; an ordinary receipt records no buyer name.
      ...(cashMemoIdentity && buyerName ? { buyerName } : {}),
      lines: sale.lines.map((line) => ({
        saleLineId: line.id,
        medicineId: line.medicineId,
        presentationId: line.presentationId,
        medicineName: line.medicine.productName,
        strength: line.medicine.strengths.length
          ? line.medicine.strengths
              .map((component) => {
                const raw = String(component.value);
                const value = raw.includes('.')
                  ? raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
                  : raw;
                return `${value} ${component.unit}`;
              })
              .join(' + ')
          : null,
        presentation: line.presentation.presentation,
        ...(snapshotText(line.medicine.manufacturer, 300)
          ? { manufacturer: snapshotText(line.medicine.manufacturer, 300) }
          : {}),
        allocations: line.allocations.map((allocation) => {
          const batch = checkedBatches.get(allocation.inventoryLotId) ?? allocation.lot.batch;
          return {
            allocationId: allocation.id,
            inventoryLotId: allocation.inventoryLotId,
            batchNumber: batch.batchNumber,
            expiresAt: batch.expiresAt.toISOString(),
            canonicalUnits: allocation.canonicalUnits,
          };
        }),
      })),
    },
    {
      ...sale,
      receiptNumber,
      receiptDeviceId: input.deviceId,
      businessDate: input.businessDate,
      completedAt: issuedAt,
    }
  );
  await db.pharmacySaleEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: sale.id,
      kind: 'COMPLETED',
      actorId: scope.actorId,
      occurredAt: issuedAt,
      payload: snapshot,
    },
  });
  for (const line of sale.lines) {
    await postSaleLineEntry(db, scope, { saleLineId: line.id, at: issuedAt });
  }

  return receiptNumber;
}
