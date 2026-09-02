import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { deriveLooseUnitPrice } from './medicine';
import { allocateForSale } from './stock-ledger';
import type { LedgerScope } from './stock-ledger';

export class PharmacySaleError extends Error {
  constructor(
    readonly reason:
      | 'NOT_FOUND'
      | 'INVALID_STATE'
      | 'INVALID_QUANTITY'
      | 'PRICE_ABOVE_MRP'
      | 'MARGIN_GUARDRAIL'
      | 'APPROVAL_REQUIRED'
      | 'REGULATED_DISCOUNT_REFUSED'
      | 'RETURN_EXCEEDS_SOLD'
      | 'CONSENT_REQUIRED'
      | 'CROSS_BRANCH_REFERENCE'
  ) {
    super(reason);
  }
}

export function priceFromLot(input: {
  printedMrpMinor: number;
  canonicalUnitsInPack: number;
  canonicalUnitsPerSaleUnit: number;
  roundingIncrementMinor?: number;
}) {
  const loose = deriveLooseUnitPrice({
    printedMrpMinor: input.printedMrpMinor,
    canonicalUnitsInPack: input.canonicalUnitsInPack,
    roundingIncrementMinor: input.roundingIncrementMinor ?? 1,
  });
  return {
    unitPriceMinor: loose.unitPriceMinor * input.canonicalUnitsPerSaleUnit,
    proRataCeilingMinor: loose.proRataCeilingMinor * input.canonicalUnitsPerSaleUnit,
  };
}

export function validateDiscount(input: {
  regulated: boolean;
  discountMinor: number;
  grossMinor: number;
  costMinor: number;
  approvedByUserId?: string;
  approvalPolicy?: string;
}) {
  if (input.discountMinor < 0 || input.discountMinor > input.grossMinor)
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
  if (input.regulated && input.discountMinor > 0)
    throw new PharmacySaleError('REGULATED_DISCOUNT_REFUSED');
  if (input.discountMinor > 0 && (!input.approvedByUserId || !input.approvalPolicy))
    throw new PharmacySaleError('APPROVAL_REQUIRED');
  if (input.grossMinor - input.discountMinor < input.costMinor)
    throw new PharmacySaleError('MARGIN_GUARDRAIL');
}

async function saleInScope(db: ScopedDb, scope: LedgerScope, saleId: string) {
  const sale = await db.pharmacySale.findFirst({
    where: { id: saleId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!sale) throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  return sale;
}

async function event(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  kind: Parameters<typeof db.pharmacySaleEvent.create>[0]['data']['kind'],
  reason?: string,
  payload?: Prisma.InputJsonValue
) {
  return db.pharmacySaleEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId,
      kind,
      actorId: scope.actorId,
      reason,
      payload,
    },
  });
}

export async function createSale(db: ScopedDb, scope: LedgerScope, quotation = false) {
  const sale = await db.pharmacySale.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdByUserId: scope.actorId,
      status: quotation ? 'QUOTATION' : 'OPEN',
    },
  });
  await event(db, scope, sale.id, quotation ? 'QUOTATION_CREATED' : 'CREATED');
  return sale;
}

export async function addSaleLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId: string;
    medicineId: string;
    presentationId: string;
    packLevelId: string;
    saleUnit: 'PACK' | 'STRIP' | 'UNIT';
    quantity: number;
    canonicalUnitsPerSaleUnit: number;
    discountKind?: 'DISCOUNT' | 'PROMOTION' | 'COMPLIMENTARY';
    discountMinor?: number;
    approvedByUserId?: string;
    approvalPolicy?: string;
    override?: { inventoryLotId: string; reason: string; approvalPolicy: string };
    idempotencyKey: string;
  }
) {
  const sale = await saleInScope(db, scope, input.saleId);
  if (sale.status !== 'OPEN') throw new PharmacySaleError('INVALID_STATE');
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity <= 0 ||
    !Number.isSafeInteger(input.canonicalUnitsPerSaleUnit) ||
    input.canonicalUnitsPerSaleUnit <= 0
  )
    throw new PharmacySaleError('INVALID_QUANTITY');
  const canonicalUnits = input.quantity * input.canonicalUnitsPerSaleUnit;
  if (!Number.isSafeInteger(canonicalUnits)) throw new PharmacySaleError('INVALID_QUANTITY');

  const medicine = await db.medicine.findFirst({
    where: { id: input.medicineId, organizationId: scope.organizationId },
  });
  if (!medicine) throw new PharmacySaleError('NOT_FOUND');
  const allocation = await allocateForSale(db, scope, {
    medicineId: input.medicineId,
    requiredUnits: canonicalUnits,
    at: new Date(),
    idempotencyKeyPrefix: `sale:${input.idempotencyKey}`,
    override: input.override,
  });
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      id: { in: allocation.allocations.map((a) => a.inventoryLotId) },
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  let unitPriceMinor = 0,
    ceiling = 0,
    costMinor = 0;
  for (const part of allocation.allocations) {
    const lot = lotById.get(part.inventoryLotId);
    if (!lot) throw new PharmacySaleError('NOT_FOUND');
    const price = priceFromLot({
      printedMrpMinor: lot.printedMrpMinor,
      canonicalUnitsInPack: lot.unitsPerPack,
      canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
    });
    unitPriceMinor = Math.max(unitPriceMinor, price.unitPriceMinor);
    ceiling = Math.max(ceiling, price.proRataCeilingMinor);
    costMinor += lot.unitCostMinor * part.units;
  }
  const grossMinor = unitPriceMinor * input.quantity;
  const discountMinor = input.discountMinor ?? 0;
  validateDiscount({
    regulated: medicine.rx || medicine.restricted || medicine.controlled,
    discountMinor,
    grossMinor,
    costMinor,
    approvedByUserId: input.approvedByUserId,
    approvalPolicy: input.approvalPolicy,
  });
  const line = await db.pharmacySaleLine.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      medicineId: input.medicineId,
      presentationId: input.presentationId,
      packLevelId: input.packLevelId,
      saleUnit: input.saleUnit,
      quantity: input.quantity,
      canonicalUnitsPerSaleUnit: input.canonicalUnitsPerSaleUnit,
      canonicalUnits,
      unitPriceMinor,
      proRataCeilingMinor: ceiling,
      unitCostMinor: Math.ceil(costMinor / input.quantity),
      discountKind: input.discountKind,
      discountMinor,
      approvalPolicy: input.approvalPolicy,
      approvedByUserId: input.approvedByUserId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  await Promise.all(
    allocation.allocations.map((part, index) =>
      db.pharmacySaleLineAllocation.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          saleLineId: line.id,
          inventoryLotId: part.inventoryLotId,
          stockLocationId: part.stockLocationId,
          canonicalUnits: part.units,
          stockMovementId: allocation.movementIds[index]!,
        },
      })
    )
  );
  await event(db, scope, sale.id, 'LINE_ADDED', undefined, { saleLineId: line.id });
  return { line, allocation };
}

export async function changeSaleStatus(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  action: 'hold' | 'resume' | 'convertQuotation' | 'complete' | 'void',
  reason?: string
) {
  const sale = await saleInScope(db, scope, saleId);
  const transitions = {
    hold: ['OPEN', 'HELD', 'HELD'],
    resume: ['HELD', 'OPEN', 'RESUMED'],
    convertQuotation: ['QUOTATION', 'OPEN', 'QUOTATION_CONVERTED'],
    complete: ['OPEN', 'COMPLETED', 'COMPLETED'],
    void: ['OPEN', 'VOID', 'VOIDED'],
  } as const;
  const [from, to, kind] = transitions[action];
  if (sale.status !== from) throw new PharmacySaleError('INVALID_STATE');
  const updated = await db.pharmacySale.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: saleId } },
    data: { status: to, completedAt: action === 'complete' ? new Date() : undefined },
  });
  await event(db, scope, saleId, kind, reason);
  return updated;
}

export async function returnSaleLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleLineId: string;
    canonicalUnits: number;
    quarantineLocationId: string;
    reason: string;
    integrityDecision: string;
    idempotencyKey: string;
  }
) {
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: input.saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { sale: true, allocations: true, returnLines: true },
  });
  if (!line || line.sale.status !== 'COMPLETED') throw new PharmacySaleError('NOT_FOUND');
  const returned = line.returnLines.reduce((sum, item) => sum + item.canonicalUnits, 0);
  if (input.canonicalUnits <= 0 || returned + input.canonicalUnits > line.canonicalUnits)
    throw new PharmacySaleError('RETURN_EXCEEDS_SOLD');
  const allocation = line.allocations.find((item) => item.canonicalUnits >= input.canonicalUnits);
  if (!allocation) throw new PharmacySaleError('INVALID_QUANTITY');
  const saleReturn = await db.pharmacySaleReturn.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      originalSaleId: line.saleId,
      actorId: scope.actorId,
      reason: input.reason,
    },
  });
  const movement = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: allocation.inventoryLotId,
      stockLocationId: input.quarantineLocationId,
      kind: 'RETURN',
      disposition: 'QUARANTINE',
      quantityUnits: input.canonicalUnits,
      looseUnitDelta: input.canonicalUnits,
      actorId: scope.actorId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const returnLine = await db.pharmacySaleReturnLine.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      returnId: saleReturn.id,
      saleLineId: line.id,
      inventoryLotId: allocation.inventoryLotId,
      stockLocationId: input.quarantineLocationId,
      canonicalUnits: input.canonicalUnits,
      integrityDecision: input.integrityDecision,
      stockMovementId: movement.id,
    },
  });
  await event(db, scope, line.saleId, 'RETURNED', input.reason, { returnId: saleReturn.id });
  return { saleReturn, returnLine, movement };
}

export async function captureDemand(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId?: string;
    requestedMedicineId?: string;
    requestedText?: string;
    strength?: string;
    form?: string;
    presentation?: string;
    saleUnit: 'PACK' | 'STRIP' | 'UNIT';
    quantity: number;
    reason: Parameters<typeof db.unfulfilledDemandEvent.create>[0]['data']['reason'];
    inventoryRuleSnapshot: unknown;
    estimatedValueMinor?: number;
    estimatedMarginMinor?: number;
    customerId?: string;
    consentRecorded?: boolean;
  }
) {
  if (!input.requestedMedicineId && !input.requestedText?.trim())
    throw new PharmacySaleError('INVALID_QUANTITY');
  if (input.customerId && !input.consentRecorded) throw new PharmacySaleError('CONSENT_REQUIRED');
  return db.unfulfilledDemandEvent.create({
    data: {
      ...input,
      inventoryRuleSnapshot: input.inventoryRuleSnapshot as Prisma.InputJsonValue,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      capturedByUserId: scope.actorId,
    },
  });
}

export async function recoverDemandWithAlternate(
  db: ScopedDb,
  scope: LedgerScope,
  demandId: string,
  saleLineId: string
) {
  const demand = await db.unfulfilledDemandEvent.findFirst({
    where: {
      id: demandId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  const line = await db.pharmacySaleLine.findFirst({
    where: { id: saleLineId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!demand || !line || !demand.saleId || demand.saleId !== line.saleId)
    throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  return db.unfulfilledDemandEvent.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: demandId } },
    data: { status: 'RECOVERED', recoveredSaleLineId: saleLineId, recoveredAt: new Date() },
  });
}

export async function demandAggregate(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  from: Date,
  to: Date
) {
  const rows = await db.unfulfilledDemandEvent.groupBy({
    by: ['requestedMedicineId', 'requestedText', 'reason'],
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdAt: { gte: from, lt: to },
    },
    _count: { _all: true },
    _sum: { quantity: true, estimatedValueMinor: true, estimatedMarginMinor: true },
    orderBy: { _count: { requestedMedicineId: 'desc' } },
  });
  return {
    label: 'Estimate',
    method: 'Explicit POS-10 events grouped by requested item and cause',
    window: { from, to },
    exclusions: ['searches without an explicit event', 'abandoned carts'],
    confidence: 'observed-events-only',
    rows,
  };
}
