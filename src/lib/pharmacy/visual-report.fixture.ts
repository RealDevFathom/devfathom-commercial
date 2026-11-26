import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// Synthetic transaction evidence, shared by every chart parity check.
export async function seedVisualReport(
  db: ScopedDb,
  branch: string,
  prefix: string,
  day: string,
  options: { cost?: number; receiptNumber?: number | null; at?: Date; cashMinor?: number } = {}
) {
  const id = (suffix: string) => prefix + '_' + suffix;
  const {
    cost = 50,
    receiptNumber = null,
    at = new Date(day + 'T12:00:00Z'),
    cashMinor = 0,
  } = options;
  const businessDate = new Date(day + 'T00:00:00Z');
  const medicine = await db.medicine.create({
    data: { id: id('medicine'), productName: 'Sample tablets', productFamily: 'PHARMACEUTICAL' },
  });
  const presentation = await db.presentation.create({
    data: { id: id('presentation'), medicineId: medicine.id, presentation: 'Sample box' },
  });
  const pack = await db.packLevel.create({
    data: {
      id: id('pack'),
      presentationId: presentation.id,
      versionGroupId: id('pack'),
      version: 1,
      level: 'UNIT',
      unitsPerParent: 1,
      effectiveFrom: new Date('2020-01-01'),
    },
  });
  const batch = await db.pharmacyManufacturingBatch.create({
    data: {
      id: id('batch'),
      medicineId: medicine.id,
      batchNumber: prefix,
      expiresAt: new Date('2030-01-01'),
    },
  });
  const lot = await db.pharmacyInventoryLot.create({
    data: {
      id: id('lot'),
      branchId: branch,
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      unitsPerPack: 1,
      supplierName: 'Sample supplier',
      supplierInvoiceRef: prefix,
      unitCostMinor: cost,
      printedMrpMinor: 100,
    },
  });
  const sale = await db.pharmacySale.create({
    data: {
      id: id('sale'),
      branchId: branch,
      status: 'COMPLETED',
      receiptNumber,
      createdByUserId: 'sample-cashier',
      completedAt: at,
      businessDate,
    },
  });
  const line = await db.pharmacySaleLine.create({
    data: {
      id: id('line'),
      branchId: branch,
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'PACK',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      canonicalUnits: 10,
      unitPriceMinor: 100,
      grossMinor: 1000,
      discountMinor: 100,
      discountKind: 'DISCOUNT',
      approvalPolicy: 'Synthetic approval',
      approvedByUserId: 'sample-cashier',
      proRataCeilingMinor: 100,
      unitCostMinor: cost,
      idempotencyKey: id('line'),
    },
  });
  await db.pharmacySaleLineAllocation.create({
    data: {
      branchId: branch,
      saleLineId: line.id,
      inventoryLotId: lot.id,
      stockLocationId: id('location'),
      canonicalUnits: 10,
      stockMovementId: id('movement'),
    },
  });
  const tender = await db.pharmacyTender.create({
    data: {
      branchId: branch,
      saleId: sale.id,
      type: 'CARD',
      amountMinor: 900 - cashMinor,
      businessDate,
      actorId: 'sample-cashier',
      deviceId: prefix,
      createdAt: at,
    },
  });
  if (cashMinor) {
    await db.pharmacyTender.create({
      data: {
        branchId: branch,
        saleId: sale.id,
        type: 'CASH',
        amountMinor: cashMinor,
        businessDate,
        actorId: 'sample-cashier',
        deviceId: prefix,
        createdAt: at,
      },
    });
  }
  await db.pharmacyRefund.create({
    data: {
      branchId: branch,
      saleId: sale.id,
      originalTenderId: tender.id,
      amountMinor: 90,
      businessDate,
      actorId: 'sample-cashier',
      reason: 'Wrong pack',
      createdAt: at,
    },
  });
  const returned = await db.pharmacySaleReturn.create({
    data: {
      branchId: branch,
      originalSaleId: sale.id,
      actorId: 'sample-cashier',
      reason: 'Wrong pack',
      createdAt: at,
    },
  });
  const returnedLine = await db.pharmacySaleReturnLine.create({
    data: {
      branchId: branch,
      returnId: returned.id,
      saleLineId: line.id,
      inventoryLotId: lot.id,
      stockLocationId: id('location'),
      canonicalUnits: 1,
      integrityDecision: 'RESTOCK',
      stockMovementId: id('return-movement'),
      createdAt: at,
    },
  });
  for (const reversal of [false, true]) {
    const factor = reversal ? 1 : 10;
    const legs = [
      ['SALES_REVENUE', 'CREDIT', 100],
      ['SALES_DISCOUNT', 'DEBIT', 10],
      ['COST_OF_GOODS_SOLD', 'DEBIT', cost],
      ['CASH', 'DEBIT', 90],
      ['INVENTORY', 'CREDIT', cost],
    ] as const;
    await db.financeJournalEntry.create({
      data: {
        branchId: branch,
        sourceKind: reversal ? 'PHARMACY_SALE_RETURN_LINE' : 'PHARMACY_SALE_LINE',
        sourceId: reversal ? returnedLine.id : line.id,
        description: reversal ? 'Sample return' : 'Sample sale',
        actorId: 'sample-cashier',
        occurredAt: at,
        idempotencyKey: id('journal-' + reversal),
        lines: {
          create: legs
            .filter(([, , money]) => money > 0)
            .map(([accountCode, side, money]) => ({
              accountCode,
              side: reversal ? (side === 'DEBIT' ? 'CREDIT' : 'DEBIT') : side,
              amountMinor: money * factor,
              branchId: branch,
              productId: medicine.id,
              lotId: lot.id,
              sourceLineId: line.id,
            })),
        },
      },
    });
  }
  // A second completed line has no cost posting. Its stored unit price cannot prove cost.
  await db.pharmacySaleLine.create({
    data: {
      id: id('unposted'),
      branchId: branch,
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'PACK',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      canonicalUnits: 1,
      unitPriceMinor: 100,
      grossMinor: 100,
      proRataCeilingMinor: 100,
      unitCostMinor: 0,
      idempotencyKey: id('unposted'),
    },
  });
  return { medicine: medicine.id, sale: sale.id };
}
