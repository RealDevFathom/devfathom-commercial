import 'server-only';
import { assertSaleLinesCleared } from './rx-gate';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { postSaleLineEntry } from './finance-postings';
import { PharmacyReceiptIdentityError, validateReceiptIdentity } from './receipt-identity';

export const completionSaleInclude = {
  lines: {
    include: {
      medicine: { include: { strengths: { orderBy: { id: 'asc' } } } },
      presentation: true,
      allocations: { orderBy: { id: 'asc' }, include: { lot: { include: { batch: true } } } },
    },
  },
  tenders: true,
} satisfies Prisma.PharmacySaleInclude;

// Internal: callers hold the sale lock and have verified exact paid coverage in this transaction.
export async function completePaidPharmacySale(
  db: ScopedDb,
  scope: LedgerScope,
  sale: Prisma.PharmacySaleGetPayload<{ include: typeof completionSaleInclude }>,
  input: { deviceId: string; businessDate: Date },
  /** F2: a leased offline receipt number the caller already consumed in this transaction. */
  leasedReceiptNumber: number | null = null
) {
  await assertSaleLinesCleared(db, scope, sale.id);
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
  const issuedAt = new Date();
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
  const snapshot = validateReceiptIdentity(
    {
      receiptIdentitySnapshotVersion: 1,
      saleId: sale.id,
      receiptNumber,
      deviceId: input.deviceId,
      businessDate: input.businessDate.toISOString().slice(0, 10),
      issuedAt: issuedAt.toISOString(),
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
        allocations: line.allocations.map((allocation) => ({
          allocationId: allocation.id,
          inventoryLotId: allocation.inventoryLotId,
          batchNumber: allocation.lot.batch.batchNumber,
          expiresAt: allocation.lot.batch.expiresAt.toISOString(),
          canonicalUnits: allocation.canonicalUnits,
        })),
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
