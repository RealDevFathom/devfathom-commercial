import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { can } from '@/lib/abac';

/** Running balance after applying a signed delta. Null when the result is not a safe non-negative integer. */
export function registerBalanceAfter(previous: number, delta: number): number | null {
  if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(delta)) return null;
  const next = previous + delta;
  if (!Number.isSafeInteger(next) || next < 0) return null;
  return next;
}

/**
 * Emergency supply with no prescription on file.
 * Ten canonical units, and not again for the same patient and medicine inside 72 hours
 * or while the missing-prescription follow-up is still open.
 */
export const EMERGENCY_NO_RX_MAX_UNITS = 10;
export const EMERGENCY_NO_RX_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Null when the supply is allowed. Otherwise the sentence the counter shows. */
export function emergencyNoRxDecision(input: {
  units: number;
  recentSupplies: number;
  openFollowUp: boolean;
}): string | null {
  if (
    !Number.isSafeInteger(input.units) ||
    input.units < 1 ||
    input.units > EMERGENCY_NO_RX_MAX_UNITS
  ) {
    return `An emergency supply without a prescription is limited to ${EMERGENCY_NO_RX_MAX_UNITS} units. File the prescription before dispensing more.`;
  }
  if (input.recentSupplies > 0 || input.openFollowUp) {
    return 'This patient already has an emergency supply of this medicine. File the missing prescription before another supply.';
  }
  return null;
}

/**
 * Signed balance change for a correction.
 * `correctedQuantity` is the absolute quantity that should have been recorded.
 * A sale that was too high moves the balance up; a purchase that was too high moves it down.
 * The absolute change cannot exceed the original quantity. Null when it would.
 */
export function derivedCorrectionDelta(
  entryKind: 'SALE' | 'PURCHASE' | 'CORRECTION',
  originalQuantity: number,
  correctedQuantity: number
): number | null {
  if (entryKind === 'CORRECTION') return null;
  if (!Number.isSafeInteger(originalQuantity) || originalQuantity <= 0) return null;
  if (!Number.isSafeInteger(correctedQuantity) || correctedQuantity <= 0) return null;
  const delta =
    entryKind === 'SALE'
      ? originalQuantity - correctedQuantity
      : correctedQuantity - originalQuantity;
  if (!Number.isSafeInteger(delta) || Math.abs(delta) > originalQuantity) return null;
  return delta;
}

async function lockRegister(db: ScopedDb, organizationId: string, branchId: string) {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + branchId}, 0))`;
}

/** On-hand units that can still be sold. Quarantine is not part of the register balance. */
export async function sellableOnHand(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; inventoryLotId: string }
) {
  const balance = await db.pharmacyStockBalance.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: scope.inventoryLotId,
      disposition: { not: 'QUARANTINE' },
    },
    _sum: { onHandUnits: true },
  });
  return balance._sum.onHandUnits ?? 0;
}

async function runningFromLot(
  db: ScopedDb,
  scope: {
    organizationId: string;
    branchId: string;
    medicineId: string;
    inventoryLotId: string;
  },
  delta: number
) {
  const previous = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      medicineId: scope.medicineId,
      inventoryLotId: scope.inventoryLotId,
    },
    orderBy: { serial: 'desc' },
    select: { runningBalance: true },
  });
  if (previous) {
    const running = registerBalanceAfter(previous.runningBalance, delta);
    if (running === null) throw new Error('BALANCE');
    return running;
  }
  const sellable = await sellableOnHand(db, scope);
  if (!Number.isSafeInteger(sellable) || sellable < 0) throw new Error('BALANCE');
  return sellable;
}

async function nextSerial(db: ScopedDb, organizationId: string, branchId: string) {
  const latest = await db.pharmacyControlledRegisterEntry.aggregate({
    where: { organizationId, branchId },
    _max: { serial: true },
  });
  return (latest._max.serial ?? 0) + 1;
}

async function createRegisterRow(
  db: ScopedDb,
  data: Parameters<ScopedDb['pharmacyControlledRegisterEntry']['create']>[0]['data']
) {
  try {
    return await db.pharmacyControlledRegisterEntry.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new Error('CONFLICT');
    }
    throw error;
  }
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
  await lockRegister(db, input.organizationId, input.branchId);
  let serial = (await nextSerial(db, input.organizationId, input.branchId)) - 1;
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
    const quantityCanonicalUnits = -movement.quantityUnits;
    const balanceDelta = -quantityCanonicalUnits;
    const runningBalance = await runningFromLot(
      db,
      {
        organizationId: input.organizationId,
        branchId: input.branchId,
        medicineId: input.medicineId,
        inventoryLotId: lot.id,
      },
      balanceDelta
    );
    await createRegisterRow(db, {
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
      quantityCanonicalUnits,
      balanceDelta,
      runningBalance,
      recordedByUserId: input.recordedByUserId,
      witnessedByUserId: input.witnessedByUserId,
      signatureRef: input.signatureRef,
      rxSerialWritten: input.rxSerialWritten,
      emergency: input.emergency,
      refEntryId: input.refEntryId,
    });
  }
}

export async function appendControlledPurchaseEntries(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    recordedByUserId: string;
    witnessedByUserId: string;
    signatureRef: string;
    lines: readonly {
      medicineId: string;
      manufacturer: string | null;
      inventoryLotId: string;
      stockMovementId: string;
      batchNumber: string;
      quantityCanonicalUnits: number;
      counterpartyName: string;
    }[];
  }
) {
  if (input.lines.length === 0) return;
  await lockRegister(db, input.organizationId, input.branchId);
  let serial = (await nextSerial(db, input.organizationId, input.branchId)) - 1;
  for (const line of input.lines) {
    const balanceDelta = line.quantityCanonicalUnits;
    const runningBalance = await runningFromLot(
      db,
      {
        organizationId: input.organizationId,
        branchId: input.branchId,
        medicineId: line.medicineId,
        inventoryLotId: line.inventoryLotId,
      },
      balanceDelta
    );
    await createRegisterRow(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      serial: ++serial,
      entryKind: 'PURCHASE',
      medicineId: line.medicineId,
      manufacturer: line.manufacturer,
      inventoryLotId: line.inventoryLotId,
      stockMovementId: line.stockMovementId,
      batchNumber: line.batchNumber,
      quantityCanonicalUnits: line.quantityCanonicalUnits,
      balanceDelta,
      runningBalance,
      recordedByUserId: input.recordedByUserId,
      witnessedByUserId: input.witnessedByUserId,
      signatureRef: input.signatureRef,
      counterpartyName: line.counterpartyName,
      rxSerialWritten: false,
      emergency: false,
    });
  }
}

/**
 * Append the register half of a goods-receipt reversal. The stock movements
 * have already been reversed by the caller, so each purchase row is cancelled
 * by an immutable correction whose balance must agree with sellable stock.
 */
export async function appendControlledPurchaseReversals(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    movements: readonly { sourceMovementId: string; reversalMovementId: string }[];
    recordedByUserId: string;
    reason: string;
  }
) {
  if (input.movements.length === 0) return;
  if (!input.reason.trim()) throw new Error('REASON');
  const sourceIds = new Set<string>();
  const reversalIds = new Set<string>();
  for (const pair of input.movements) {
    if (
      typeof pair.sourceMovementId !== 'string' ||
      !pair.sourceMovementId.trim() ||
      typeof pair.reversalMovementId !== 'string' ||
      !pair.reversalMovementId.trim() ||
      pair.sourceMovementId === pair.reversalMovementId ||
      sourceIds.has(pair.sourceMovementId) ||
      reversalIds.has(pair.reversalMovementId)
    )
      throw new Error('MOVEMENT');
    sourceIds.add(pair.sourceMovementId);
    reversalIds.add(pair.reversalMovementId);
  }
  // Take the same transaction lock as every register writer BEFORE reading sources.
  await lockRegister(db, input.organizationId, input.branchId);
  const movements = await db.pharmacyStockMovement.findMany({
    where: {
      organizationId: input.organizationId,
      id: { in: [...sourceIds, ...reversalIds] },
    },
  });
  const byId = new Map(movements.map((movement) => [movement.id, movement]));
  for (const pair of input.movements) {
    const source = byId.get(pair.sourceMovementId);
    const reversal = byId.get(pair.reversalMovementId);
    if (!source || !reversal) throw new Error('NOT_FOUND');
    if (
      source.branchId !== input.branchId ||
      reversal.branchId !== input.branchId ||
      source.kind !== 'RECEIPT' ||
      reversal.kind !== 'ADJUSTMENT' ||
      !Number.isSafeInteger(source.quantityUnits) ||
      source.quantityUnits <= 0 ||
      !Number.isSafeInteger(reversal.quantityUnits) ||
      reversal.reversesMovementId !== source.id ||
      reversal.inventoryLotId !== source.inventoryLotId ||
      reversal.stockLocationId !== source.stockLocationId ||
      reversal.disposition !== source.disposition ||
      reversal.quantityUnits !== -source.quantityUnits ||
      reversal.sealedPackDelta !== -source.sealedPackDelta ||
      reversal.looseUnitDelta !== -source.looseUnitDelta
    )
      throw new Error('MOVEMENT');
  }
  const purchases = await db.pharmacyControlledRegisterEntry.findMany({
    where: {
      organizationId: input.organizationId,
      entryKind: 'PURCHASE',
      stockMovementId: { in: input.movements.map((movement) => movement.sourceMovementId) },
    },
    orderBy: { serial: 'asc' },
  });
  // Returned register rows alone cannot establish completeness: legacy receipts
  // may have no PURCHASE row for one or every controlled AVAILABLE movement.
  // Derive that requirement from every actual source lot before appending ANY
  // correction. Quarantine-only and ordinary non-controlled receipts need none.
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      id: { in: [...sourceIds].map((id) => byId.get(id)!.inventoryLotId) },
    },
    include: { batch: { include: { medicine: { select: { controlled: true } } } } },
  });
  const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
  const registeredSources = new Set(purchases.map((entry) => entry.stockMovementId));
  for (const sourceId of sourceIds) {
    const source = byId.get(sourceId)!;
    const lot = lotsById.get(source.inventoryLotId);
    if (!lot || lot.branchId !== input.branchId) throw new Error('MOVEMENT');
    if (
      source.disposition === 'AVAILABLE' &&
      lot.batch.medicine.controlled &&
      !registeredSources.has(sourceId)
    )
      throw new Error('MISSING_PURCHASE_ORIGINAL');
  }
  let serial = (await nextSerial(db, input.organizationId, input.branchId)) - 1;
  for (const original of purchases) {
    if (!original.medicineId) {
      throw new Error(`Purchase register entry ${original.id} has no medicine`);
    }
    const reversalMovementId = input.movements.find(
      (movement) => movement.sourceMovementId === original.stockMovementId
    )?.reversalMovementId;
    if (!reversalMovementId) throw new Error('NOT_FOUND');
    const existing = await db.pharmacyControlledRegisterEntry.findFirst({
      where: { organizationId: input.organizationId, correctsEntryId: original.id },
      select: { id: true },
    });
    if (existing) throw new Error('ALREADY_CORRECTED');
    const source = byId.get(original.stockMovementId ?? '');
    const reversal = byId.get(reversalMovementId);
    const lot = lotsById.get(original.inventoryLotId);
    if (
      !source ||
      !reversal ||
      !lot ||
      original.branchId !== input.branchId ||
      original.inventoryLotId !== source.inventoryLotId ||
      original.quantityCanonicalUnits !== source.quantityUnits ||
      lot.branchId !== input.branchId ||
      lot.batch.medicineId !== original.medicineId ||
      lot.batch.batchNumber !== original.batchNumber
    )
      throw new Error('MOVEMENT');
    // Quantity/disposition come only from the actual, exact compensating movement.
    const quantityCanonicalUnits = Math.abs(reversal.quantityUnits);
    const balanceDelta = reversal.disposition === 'QUARANTINE' ? 0 : reversal.quantityUnits;
    const previous = await db.pharmacyControlledRegisterEntry.findFirst({
      where: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        medicineId: original.medicineId,
        inventoryLotId: original.inventoryLotId,
      },
      orderBy: { serial: 'desc' },
      select: { runningBalance: true },
    });
    const runningBalance = registerBalanceAfter(previous?.runningBalance ?? 0, balanceDelta);
    if (runningBalance === null) throw new Error('BALANCE');
    const sellable = await sellableOnHand(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      inventoryLotId: original.inventoryLotId,
    });
    if (runningBalance !== sellable) throw new Error('STOCK');
    await createRegisterRow(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      serial: ++serial,
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
      quantityCanonicalUnits,
      balanceDelta,
      runningBalance,
      recordedByUserId: input.recordedByUserId,
      witnessedByUserId: original.witnessedByUserId,
      signatureRef: original.signatureRef,
      rxSerialWritten: original.rxSerialWritten,
      emergency: original.emergency,
      counterpartyName: original.counterpartyName,
      correctionReason: input.reason,
      correctsEntryId: original.id,
      restorationMovementId: reversalMovementId,
      refEntryId: original.refEntryId,
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
  /** Absolute quantity that should have been recorded on the original row. */
  quantityCanonicalUnits: number;
  recordedByUserId: string;
  witnessedByUserId: string;
  signatureRef: string;
};

export async function appendControlledCorrection(db: ScopedDb, input: CorrectionInput) {
  await lockRegister(db, input.organizationId, input.branchId);
  const original = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      id: input.correctsEntryId,
      organizationId: input.organizationId,
      branchId: input.branchId,
    },
  });
  if (!original) throw new Error('NOT_FOUND');
  if (original.entryKind === 'CORRECTION' || !original.medicineId) {
    throw new Error('ALREADY_CORRECTED');
  }
  const existing = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      organizationId: input.organizationId,
      correctsEntryId: original.id,
    },
    select: { id: true },
  });
  if (existing) throw new Error('ALREADY_CORRECTED');
  const balanceDelta = derivedCorrectionDelta(
    original.entryKind,
    original.quantityCanonicalUnits,
    input.quantityCanonicalUnits
  );
  if (balanceDelta === null) throw new Error('CAP');
  const previous = await db.pharmacyControlledRegisterEntry.findFirst({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      medicineId: original.medicineId,
      inventoryLotId: original.inventoryLotId,
    },
    orderBy: { serial: 'desc' },
    select: { runningBalance: true },
  });
  const runningBalance = registerBalanceAfter(previous?.runningBalance ?? 0, balanceDelta);
  if (runningBalance === null) throw new Error('BALANCE');
  const sellable = await sellableOnHand(db, {
    organizationId: input.organizationId,
    branchId: input.branchId,
    inventoryLotId: original.inventoryLotId,
  });
  if (runningBalance !== sellable) throw new Error('STOCK');
  const serial = await nextSerial(db, input.organizationId, input.branchId);
  await createRegisterRow(db, {
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
    balanceDelta,
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
  });
  return { serial, runningBalance, incidentOpened: false };
}

/**
 * A void or return puts units back. Append one correction row per original sale
 * movement so the running balance stays equal to sellable stock.
 * Quarantine does not change the sellable balance, so that row's delta is zero.
 */
export async function appendControlledRestorations(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    recordedByUserId: string;
    reason: string;
    witness?: import('./controlled-restoration-authorization').ControlledRestorationWitness;
    lines: readonly {
      sourceMovementId: string;
      restorationMovementId: string;
      quantityCanonicalUnits: number;
      restoreSellable: boolean;
    }[];
  }
) {
  const sourceIds = input.lines.map((line) => line.sourceMovementId).filter(Boolean);
  if (sourceIds.length === 0) return;
  const sources = await db.pharmacyControlledRegisterEntry.findMany({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      entryKind: 'SALE',
      stockMovementId: { in: sourceIds },
    },
  });
  if (sources.length === 0) return;
  if (!input.witness) throw new Error('Fresh controlled restoration witness is required');
  await lockRegister(db, input.organizationId, input.branchId);
  for (const line of input.lines) {
    const source = sources.find((entry) => entry.stockMovementId === line.sourceMovementId);
    if (!source?.medicineId || !Number.isSafeInteger(line.quantityCanonicalUnits)) continue;
    if (line.quantityCanonicalUnits <= 0) throw new Error('BALANCE');
    const balanceDelta = line.restoreSellable ? line.quantityCanonicalUnits : 0;
    const runningBalance = await runningFromLot(
      db,
      {
        organizationId: input.organizationId,
        branchId: input.branchId,
        medicineId: source.medicineId,
        inventoryLotId: source.inventoryLotId,
      },
      balanceDelta
    );
    const sellable = await sellableOnHand(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      inventoryLotId: source.inventoryLotId,
    });
    if (runningBalance !== sellable) throw new Error('BALANCE');
    const serial = await nextSerial(db, input.organizationId, input.branchId);
    await createRegisterRow(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      serial,
      entryKind: 'CORRECTION',
      prescriptionId: source.prescriptionId,
      prescriptionLineId: source.prescriptionLineId,
      patientId: source.patientId,
      prescriberId: source.prescriberId,
      prescriberName: source.prescriberName,
      prescriberRegNo: source.prescriberRegNo,
      patientAddress: source.patientAddress,
      medicineId: source.medicineId,
      manufacturer: source.manufacturer,
      inventoryLotId: source.inventoryLotId,
      stockMovementId: null,
      restorationMovementId: line.restorationMovementId,
      batchNumber: source.batchNumber,
      quantityCanonicalUnits: line.quantityCanonicalUnits,
      balanceDelta,
      runningBalance,
      recordedByUserId: input.recordedByUserId,
      witnessedByUserId: input.witness.witnessedByUserId,
      signatureRef: input.witness.signatureRef,
      rxSerialWritten: source.rxSerialWritten,
      emergency: source.emergency,
      counterpartyName: source.counterpartyName,
      correctionReason: input.reason,
      correctsEntryId: source.id,
      refEntryId: source.refEntryId,
    });
  }
}

/** Active branch ids this person may open inside the tenant. An empty set grants nothing. */
export async function assignedRegisterBranchIds(
  db: ScopedDb,
  organizationId: string,
  userId: string
) {
  const rows = await db.pharmacyBranchAssignment.findMany({
    where: { organizationId, userId, active: true },
    select: { branchId: true },
  });
  return rows.map((row) => row.branchId);
}

/** Pharmacists who can witness a controlled purchase or correction with a PIN. */
export async function listControlledPinWitnesses(
  db: ScopedDb,
  organizationId: string,
  actorId: string
) {
  const staff = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId,
      user: { organizationId, status: 'ACTIVE' },
      status: 'ACTIVE',
      userId: { not: actorId },
      credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
    },
    include: {
      user: {
        include: {
          organizationRole: { include: { permissions: true } },
          permissionOverrides: true,
        },
      },
    },
  });
  const eligible: Array<{ id: string; name: string }> = [];
  for (const profile of staff) {
    if (
      profile.user?.organizationId === organizationId &&
      profile.user.status === 'ACTIVE' &&
      (await can(profile.user, 'pharmacy:dispense', undefined, { db }))
    ) {
      eligible.push({ id: profile.id, name: profile.displayName });
    }
  }
  return eligible;
}
