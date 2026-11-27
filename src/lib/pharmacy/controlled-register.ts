import { PharmacySupplierReturnError } from './supplier-returns';
import { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { can } from '@/lib/abac';
import { lockControlledRegister } from './stock-lock-order';

/** Running balance after applying a signed delta. Null when the result is not a safe non-negative integer. */
export function registerBalanceAfter(previous: number, delta: number): number | null {
  if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(delta)) return null;
  const next = previous + delta;
  if (!Number.isSafeInteger(next) || next < 0) return null;
  return next;
}

/** Conservative legacy policy, not a statement of provincial law. */
export const DEFAULT_EMERGENCY_SUPPLY_POLICY = {
  maxUnits: 10,
  repeatWindowHours: 72,
  source: 'DEFAULT_POLICY' as const,
};

const emergencySupplyFlagsSchema = z.object({
  values: z.object({
    emergencySupply: z.object({
      maxUnits: z.number().int().positive().refine(Number.isSafeInteger),
      // Keep the resulting lookback within JavaScript's representable date range.
      repeatWindowHours: z.number().int().positive().max(2_400_000_000),
      source: z.enum(['DEFAULT_POLICY', 'JURISDICTION_RULE_SET']).optional(),
    }),
  }),
});

export function resolveEmergencySupplyPolicy(
  ruleSet: { id: string; controlledRegisterFlags: unknown } | null
) {
  const parsed = emergencySupplyFlagsSchema.safeParse(ruleSet?.controlledRegisterFlags);
  const policy = parsed.success
    ? {
        ...parsed.data.values.emergencySupply,
        source: parsed.data.values.emergencySupply.source ?? 'JURISDICTION_RULE_SET',
      }
    : DEFAULT_EMERGENCY_SUPPLY_POLICY;
  return {
    ...policy,
    ruleSetId: ruleSet?.id ?? null,
    repeatWindowMs: policy.repeatWindowHours * 60 * 60 * 1000,
  };
}

/** Null when the supply is allowed. Otherwise the sentence the counter shows. */
export function emergencyNoRxDecision(input: {
  units: number;
  recentSupplies: number;
  openFollowUp: boolean;
  policy: ReturnType<typeof resolveEmergencySupplyPolicy>;
}): string | null {
  if (
    !Number.isSafeInteger(input.units) ||
    input.units < 1 ||
    input.units > input.policy.maxUnits
  ) {
    return `An emergency supply without a prescription is limited to ${input.policy.maxUnits} units. File the prescription before dispensing more.`;
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

/** The branch register lock; see the global stock lock order in stock-lock-order.ts. */
export async function lockRegister(db: ScopedDb, organizationId: string, branchId: string) {
  await lockControlledRegister(db, organizationId, branchId);
}

/** Reconciliation retains the old balance for unwitnessed historical dispatches.
 * The stock projection moves units between two non-quarantine buckets. Each
 * witnessed outgoing entry removes its units exactly once from this total.
 */
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
  const outgoing = await db.pharmacyControlledRegisterEntry.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: scope.inventoryLotId,
      entryKind: 'RETURN_TO_SUPPLIER',
    },
    _sum: { quantityCanonicalUnits: true },
  });
  return (balance._sum.onHandUnits ?? 0) - (outgoing._sum.quantityCanonicalUnits ?? 0);
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
  /** Null only on an entry written while the owner had the pharmacist check off (DEV-911). */
  patientId: string | null;
  patientAddress: string | null;
  medicineId: string;
  manufacturer: string | null;
  prescriberId: string | null;
  prescriberName: string | null;
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
      // DEV-853: NULL when the lot's batch was never recorded (never a label);
      // the register trigger matches it against the lot's own NULL batch.
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

/** Append a movement-backed reversal independently of any manual correction. */
export async function appendControlledPurchaseReversals(
  db: ScopedDb,
  input: {
    organizationId: string;
    branchId: string;
    recordedByUserId: string;
    reason: string;
    reversedMovementIds: readonly string[];
    witness?: import('./controlled-restoration-authorization').ControlledRestorationWitness;
  }
) {
  if (input.reversedMovementIds.length === 0) return;
  const purchases = await db.pharmacyControlledRegisterEntry.findMany({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      entryKind: 'PURCHASE',
      stockMovementId: { in: [...input.reversedMovementIds] },
    },
    orderBy: { serial: 'asc' },
  });
  if (purchases.length === 0) return;
  if (!input.witness) throw new Error('Fresh controlled reversal witness is required');
  await lockRegister(db, input.organizationId, input.branchId);
  for (const purchase of purchases) {
    if (!purchase.medicineId) throw new Error('STOCK');
    const movement = await db.pharmacyStockMovement.findFirst({
      where: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        inventoryLotId: purchase.inventoryLotId,
        kind: 'ADJUSTMENT',
        reversesMovementId: purchase.stockMovementId,
      },
    });
    if (!movement || movement.quantityUnits !== -purchase.quantityCanonicalUnits) {
      throw new Error('STOCK');
    }
    const balanceDelta = movement.quantityUnits;
    const runningBalance = await runningFromLot(
      db,
      {
        organizationId: input.organizationId,
        branchId: input.branchId,
        medicineId: purchase.medicineId,
        inventoryLotId: purchase.inventoryLotId,
      },
      balanceDelta
    );
    const sellable = await sellableOnHand(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      inventoryLotId: purchase.inventoryLotId,
    });
    if (runningBalance !== sellable) throw new Error('STOCK');
    await createRegisterRow(db, {
      organizationId: input.organizationId,
      branchId: input.branchId,
      serial: await nextSerial(db, input.organizationId, input.branchId),
      entryKind: 'CORRECTION',
      medicineId: purchase.medicineId,
      manufacturer: purchase.manufacturer,
      inventoryLotId: purchase.inventoryLotId,
      batchNumber: purchase.batchNumber,
      counterpartyName: purchase.counterpartyName,
      correctsEntryId: purchase.id,
      restorationMovementId: movement.id,
      quantityCanonicalUnits: 0,
      balanceDelta,
      runningBalance,
      recordedByUserId: input.recordedByUserId,
      witnessedByUserId: input.witness.witnessedByUserId,
      signatureRef: input.witness.signatureRef,
      correctionReason: input.reason,
    });
  }
}

// Depending on the adapter path, PostgreSQL's check_violation is structured
// or embedded in Prisma's database-error diagnostic.
function isRegisterCheckViolation(error: unknown): boolean {
  const driver = error as {
    code?: string;
    cause?: { originalCode?: string };
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
  } | null;
  return (
    driver?.code === '23514' ||
    driver?.cause?.originalCode === '23514' ||
    driver?.meta?.code === '23514' ||
    driver?.meta?.driverAdapterError?.cause?.originalCode === '23514' ||
    (error instanceof Error && /Database error\. Code: `23514`/.test(error.message))
  );
}

/** The return document and its stock movement are written in the caller's transaction. */
export async function appendControlledSupplierReturn(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  input: {
    supplierId: string;
    supplierName: string;
    lineId: string;
    inventoryLotId: string;
    movementId: string;
    lateDispatchAt?: Date;
    approvalReason?: string;
    quantity: number;
    witness: import('./controlled-restoration-authorization').ControlledRestorationWitness;
  }
) {
  const { organizationId, branchId } = scope;
  // A lot can contain several lines of the same invoice. Never guess which
  // original register entry a physical return belongs to.
  const sources = await db.$queryRaw<
    { id: string; medicineId: string; manufacturer: string | null; batchNumber: string | null }[]
  >`
    SELECT p.id, p."medicineId", p.manufacturer, p."batchNumber"
    FROM pharmacy_controlled_register_entries p
    JOIN pharmacy_stock_movements m ON m."organizationId" = p."organizationId" AND m.id = p."stockMovementId"
    JOIN pharmacy_goods_receipt_lines l ON l."organizationId" = p."organizationId"
      AND l."inventoryLotId" = p."inventoryLotId" AND m."idempotencyKey" = 'pharmacy-receipt:' || l.id || ':accepted'
    JOIN pharmacy_goods_receipts r ON r."organizationId" = l."organizationId" AND r.id = l."goodsReceiptId"
    WHERE p."organizationId" = ${organizationId} AND p."branchId" = ${branchId}
      AND (${input.lateDispatchAt ?? null}::timestamp IS NULL OR m."occurredAt" <= ${input.lateDispatchAt ?? null}::timestamp)
      AND p."inventoryLotId" = ${input.inventoryLotId} AND p."entryKind" = 'PURCHASE'
      AND r.status = 'POSTED' AND r."supplierId" = ${input.supplierId}
      AND p."quantityCanonicalUnits" - COALESCE((SELECT sum(sent."quantityCanonicalUnits")
        FROM pharmacy_controlled_register_entries sent WHERE sent."organizationId" = p."organizationId"
        AND sent."sourcePurchaseEntryId" = p.id), 0) >= ${input.quantity}
    LIMIT 2`;
  if (sources.length !== 1) {
    throw new PharmacySupplierReturnError('PURCHASE_UNCLEAR');
  }
  const purchase = sources[0]!;
  const lot = {
    organizationId,
    branchId,
    medicineId: purchase.medicineId,
    inventoryLotId: input.inventoryLotId,
  };
  const balanceDelta = -input.quantity;
  const runningBalance = await runningFromLot(db, lot, balanceDelta);
  if (runningBalance !== (await sellableOnHand(db, lot)) - input.quantity) {
    throw new PharmacySupplierReturnError('REGISTER_DISAGREES');
  }
  try {
    await createRegisterRow(db, {
      ...lot,
      serial: await nextSerial(db, organizationId, branchId),
      entryKind: 'RETURN_TO_SUPPLIER',
      sourcePurchaseEntryId: purchase.id,
      supplierReturnLineId: input.lineId,
      lateDispatchAt: input.lateDispatchAt,
      stockMovementId: input.movementId,
      manufacturer: purchase.manufacturer,
      batchNumber: purchase.batchNumber,
      counterpartyName: input.supplierName,
      quantityCanonicalUnits: input.quantity,
      balanceDelta,
      runningBalance,
      recordedByUserId: scope.actorId,
      witnessedByUserId: input.lateDispatchAt ? null : input.witness.witnessedByUserId,
      supplierReturnReason: input.approvalReason?.trim(),
      signatureRef: input.witness.signatureRef,
    });
  } catch (error) {
    if (
      isRegisterCheckViolation(error) ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2003', 'P2004', 'P2010'].includes(error.code))
    )
      throw new PharmacySupplierReturnError('REGISTER_REFUSED');
    if (error instanceof Error && error.message === 'CONFLICT')
      throw new PharmacySupplierReturnError('REGISTER_REFUSED');
    throw error;
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
  if (
    (original.entryKind !== 'PURCHASE' && original.entryKind !== 'SALE') ||
    !original.medicineId
  ) {
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
  actorId: string,
  qualifiedPersonUserId?: string
) {
  const staff = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId,
      user: { organizationId, status: 'ACTIVE' },
      status: 'ACTIVE',
      userId: qualifiedPersonUserId ?? { not: actorId },
      credentials: {
        some: {
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          // A named qualified person whose PIN is locked out cannot witness yet;
          // offering them only leads to a rejection the picker could have avoided (#283).
          ...(qualifiedPersonUserId
            ? { OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] }
            : {}),
        },
      },
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
