import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Running balance after a correction. Null when the result is not a safe non-negative integer. */
export function registerBalanceAfter(previous: number, delta: number): number | null {
  if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(delta)) return null;
  const next = previous + delta;
  if (!Number.isSafeInteger(next) || next < 0) return null;
  return next;
}

type SaleRegisterInput = {
  organizationId: string;
  branchId: string;
  movementIds: readonly string[];
  patientId: string;
  patientAddress: string;
  medicineId: string;
  manufacturer: string | null;
  prescriberId: string | null;
  prescriberName: string;
  prescriberRegNo: string | null;
  prescriptionId: string | null;
  prescriptionLineId: string | null;
  emergency: boolean;
  rxSerialWritten: boolean;
  refEntryId: string | null;
  recordedByUserId: string;
  witnessedByUserId: string;
  signatureRef: string;
};

/** Append one SALE row per stock movement. The caller is already inside the sale transaction. */
export async function appendControlledSaleEntries(db: ScopedDb, input: SaleRegisterInput) {
  const latest = await db.pharmacyControlledRegisterEntry.aggregate({
    where: { organizationId: input.organizationId, branchId: input.branchId },
    _max: { serial: true },
  });
  let serial = latest._max.serial ?? 0;
  for (const movementId of input.movementIds) {
    const movement = await db.pharmacyStockMovement.findFirstOrThrow({
      where: {
        id: movementId,
        organizationId: input.organizationId,
        branchId: input.branchId,
      },
    });
    const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
      where: { id: movement.inventoryLotId, organizationId: input.organizationId },
      include: { batch: true },
    });
    const balance = await db.pharmacyStockBalance.aggregate({
      where: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        inventoryLotId: lot.id,
      },
      _sum: { onHandUnits: true },
    });
    await db.pharmacyControlledRegisterEntry.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        serial: ++serial,
        entryKind: 'SALE',
        prescriptionId: input.prescriptionId,
        prescriptionLineId: input.prescriptionLineId,
        patientId: input.patientId,
        prescriberId: input.prescriberId,
        prescriberName: input.prescriberName,
        prescriberRegNo: input.prescriberRegNo,
        patientAddress: input.patientAddress,
        medicineId: input.medicineId,
        manufacturer: input.manufacturer,
        inventoryLotId: lot.id,
        stockMovementId: movement.id,
        batchNumber: lot.batch.batchNumber,
        quantityCanonicalUnits: -movement.quantityUnits,
        balanceDelta: 0,
        runningBalance: balance._sum.onHandUnits ?? 0,
        recordedByUserId: input.recordedByUserId,
        witnessedByUserId: input.witnessedByUserId,
        signatureRef: input.signatureRef,
        rxSerialWritten: input.rxSerialWritten,
        emergency: input.emergency,
        refEntryId: input.refEntryId,
      },
    });
  }
}

export async function earlierRegisterEntry(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  serial: number | undefined
) {
  if (!serial) return null;
  return db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      serial,
    },
    select: { id: true },
  });
}

type CorrectionInput = {
  organizationId: string;
  branchId: string;
  correctsEntryId: string;
  correctionReason: string;
  quantityCanonicalUnits: number;
  balanceDelta: number;
  recordedByUserId: string;
  witnessedByUserId: string;
  signatureRef: string;
};

export async function appendControlledCorrection(db: ScopedDb, input: CorrectionInput) {
  const original = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      id: input.correctsEntryId,
      organizationId: input.organizationId,
      branchId: input.branchId,
    },
  });
  if (!original) throw new Error('NOT_FOUND');
  const latest = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      inventoryLotId: original.inventoryLotId,
    },
    orderBy: { serial: 'desc' },
  });
  const runningBalance = registerBalanceAfter(
    latest?.runningBalance ?? original.runningBalance,
    input.balanceDelta
  );
  if (runningBalance === null) throw new Error('BALANCE');
  const aggregate = await db.pharmacyControlledRegisterEntry.aggregate({
    where: { organizationId: input.organizationId, branchId: input.branchId },
    _max: { serial: true },
  });
  const serial = (aggregate._max.serial ?? 0) + 1;
  await db.pharmacyControlledRegisterEntry.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      serial,
      entryKind: 'CORRECTION',
      prescriptionId: original.prescriptionId,
      prescriptionLineId: original.prescriptionLineId,
      patientId: original.patientId,
      prescriberId: original.prescriberId,
      prescriberName: original.prescriberName,
      prescriberRegNo: original.prescriberRegNo,
      patientAddress: original.patientAddress,
      medicineId: original.medicineId,
      manufacturer: original.manufacturer,
      inventoryLotId: original.inventoryLotId,
      stockMovementId: null,
      batchNumber: original.batchNumber,
      quantityCanonicalUnits: input.quantityCanonicalUnits,
      balanceDelta: input.balanceDelta,
      runningBalance,
      recordedByUserId: input.recordedByUserId,
      witnessedByUserId: input.witnessedByUserId,
      signatureRef: input.signatureRef,
      rxSerialWritten: original.rxSerialWritten,
      emergency: original.emergency,
      counterpartyName: original.counterpartyName,
      correctionReason: input.correctionReason,
      correctsEntryId: original.id,
      refEntryId: original.refEntryId,
    },
  });
  return { serial, runningBalance };
}
