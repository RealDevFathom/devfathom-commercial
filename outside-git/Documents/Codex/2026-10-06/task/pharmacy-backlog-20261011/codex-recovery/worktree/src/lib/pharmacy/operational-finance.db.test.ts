/** Run only against a NEW disposable wha1364_* database, never an existing tenant. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { addSaleLine, createSale, returnSaleLine } from './sales';
import { receiveLot } from './stock-ledger';
import {
  applyPharmacyTender,
  refundPharmacyTender,
  openPharmacyDrawer,
  closePharmacyDrawer,
} from './settlement';
import { recordDeliveryCommand } from './customer-delivery';
import { executeSandboxPayment } from './payment-sandbox';
import { linkCustomerToSale, readLoyaltyHistory } from './customer-loyalty';
import { writePatientConsent } from './consent-writer';
import { readCounterReceipt } from './counter';
import { afterAll } from 'vitest';

const url = process.env.WHA1364_RECEIPT_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/wha1364_')) {
  throw new Error(
    'New isolated WHA1364_RECEIPT_TEST_DATABASE_URL required; no skipped DB acceptance'
  );
}
const client = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : null;
const describeDatabase = url ? describe : describe.skip;
const org = `org_${randomUUID()}`;
const branch = `branch_${randomUUID()}`;
const scope = { organizationId: org, branchId: branch, actorId: 'receipt-test-actor' };
const businessDate = new Date('2026-09-05T13:14:00.000Z');
function transaction<T>(work: (db: ScopedDb) => Promise<T>, organizationId = org) {
  if (!client) throw new Error('Isolated receipt database required');
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
        organizationId
      );
      return work(tx as ScopedDb);
    },
    { timeout: 30000 }
  );
}
beforeAll(async () => {
  if (!client) return;
  const [role] = await client.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await transaction((db) =>
    db.pharmacyBranch.create({
      data: {
        id: branch,
        organizationId: org,
        code: branch,
        name: 'Receipt test',
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    })
  );
});
afterAll(() => client?.$disconnect());

async function fixture(rounding = false) {
  return transaction(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: org,
        productName: 'Issued medicine',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId: org, presentation: 'Issued tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const ingredient = await db.ingredient.create({
      data: { organizationId: org, name: `Ingredient ${randomUUID()}` },
    });
    await db.medicineStrengthComponent.create({
      data: {
        organizationId: org,
        medicineId: medicine.id,
        ingredientId: ingredient.id,
        value: 500,
        unit: 'mg',
      },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId: org,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: rounding ? 3 : 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId: org,
        branchId: branch,
        code: randomUUID(),
        name: 'Test stock',
        kind: 'STORE',
      },
    });
    const batches = [];
    for (const [index, quantity] of (rounding ? [1, 2] : [3, 7]).entries()) {
      const expiresAt = new Date(`203${index + 1}-01-01T00:00:00.000Z`);
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: `ISSUED-${index}`,
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: rounding ? 3 : 10,
        supplierName: 'Test',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: index + 1,
        printedMrpMinor: rounding ? 102 : 1000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: quantity,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-01'),
      });
      batches.push(batch);
    }
    const sale = await createSale(db, scope);
    const { line } = await addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: rounding ? 'STRIP' : 'UNIT',
      quantity: rounding ? 1 : 10,
      canonicalUnitsPerSaleUnit: rounding ? 3 : 1,
      discountMinor: rounding ? 2 : 50,
      discountKind: 'DISCOUNT',
      approvedByUserId: scope.actorId,
      approvalPolicy: 'test',
      idempotencyKey: randomUUID(),
    });
    return {
      location,
      line,
      sale,
      medicine,
      presentation,
      batches,
      input: {
        saleId: sale.id,
        deviceId: randomUUID(),
        businessDate,
        type: 'BANK_TRANSFER' as const,
        amountMinor: rounding ? 100 : 950,
        idempotencyKey: randomUUID(),
      },
    };
  });
}
const read = (saleId: string) =>
  transaction((db) => readCounterReceipt(db, scope, saleId, { name: 'Test', currency: 'PKR' }));

const journal = (lineId: string) =>
  transaction((db) =>
    db.financeJournalLine.findMany({
      where: { sourceLineId: lineId },
    })
  );
// Include every ordinary posting, especially tender/refund rows without sourceLineId.
const saleJournal = (saleId: string) =>
  transaction(async (db) => {
    const [lines, returns, tenders, refunds] = await Promise.all([
      db.pharmacySaleLine.findMany({ where: { saleId } }),
      db.pharmacySaleReturnLine.findMany({ where: { saleLine: { saleId } } }),
      db.pharmacyTender.findMany({ where: { saleId } }),
      db.pharmacyRefund.findMany({ where: { saleId } }),
    ]);
    return db.financeJournalLine.findMany({
      where: {
        entry: {
          sourceId: { in: [...lines, ...returns, ...tenders, ...refunds].map((row) => row.id) },
        },
      },
      orderBy: { id: 'asc' },
    });
  });
const net = (rows: Awaited<ReturnType<typeof journal>>, accountCode: string) =>
  rows
    .filter((row) => row.accountCode === accountCode)
    .reduce((sum, row) => sum + (row.side === 'DEBIT' ? row.amountMinor : -row.amountMinor), 0);
const returnInput = (saleLineId: string, canonicalUnits: number) => ({
  saleLineId,
  canonicalUnits,
  disposition: 'RESTOCK' as const,
  reason: 'Synthetic returned goods',
  integrityDecision: 'Sealed and checked',
  idempotencyKey: randomUUID(),
});
async function cashBill(rounding = false) {
  const f = await fixture(rounding);
  const drawer = await transaction((db) =>
    openPharmacyDrawer(db, scope, {
      deviceId: f.input.deviceId,
      businessDate,
      openingFloatMinor: 1000,
    })
  );
  const input = { ...f.input, type: 'CASH' as const, cashReceivedMinor: f.input.amountMinor };
  const tender = await transaction((db) => applyPharmacyTender(db, scope, input));
  const persisted = await transaction((db) =>
    db.pharmacyTender.findFirstOrThrow({ where: { saleId: f.sale.id } })
  );
  return { ...f, input, tender, tenderId: persisted.id, drawer };
}

describeDatabase('ordinary operational Finance on restricted PostgreSQL', () => {
  it('reverses unspent earned points only for actual refunds, cumulatively, with replay and rollback', async () => {
    const f = await fixture();
    const customer = await transaction(async (db) => {
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: 'Synthetic loyalty refund' },
      });
      await writePatientConsent(db, org, scope.actorId, {
        patientId: patient.id,
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        granted: true,
      });
      return linkCustomerToSale(db, scope, {
        saleId: f.sale.id,
        patientId: patient.id,
        displayName: 'Synthetic loyalty refund',
      });
    });
    await transaction((db) =>
      openPharmacyDrawer(db, scope, {
        deviceId: f.input.deviceId,
        businessDate,
        openingFloatMinor: 1000,
      })
    );
    await transaction((db) =>
      applyPharmacyTender(db, scope, { ...f.input, type: 'CASH', cashReceivedMinor: 950 })
    );
    const tender = await transaction((db) =>
      db.pharmacyTender.findFirstOrThrow({ where: { saleId: f.sale.id } })
    );
    const entries = () =>
      transaction((db) =>
        db.pharmacyLoyaltyPointsEntry.findMany({
          where: { saleId: f.sale.id },
          orderBy: { occurredAt: 'asc' },
        })
      );
    const original = await entries();
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({ kind: 'EARN', points: 9, netPaidMinor: 950 });
    await transaction((db) => returnSaleLine(db, scope, returnInput(f.line.id, 5)));
    expect(await entries()).toEqual(original);
    const refund = {
      originalTenderId: tender.id,
      deviceId: f.input.deviceId,
      businessDate,
      amountMinor: 475,
      reason: 'Synthetic earned refund',
      idempotencyKey: randomUUID(),
      requireReturnedValue: true,
    };
    await expect(
      transaction(async (db) => {
        await refundPharmacyTender(db, scope, refund);
        throw new Error('LATE_EARN_ROLLBACK');
      })
    ).rejects.toThrow('LATE_EARN_ROLLBACK');
    expect(await entries()).toEqual(original);
    expect(
      await transaction((db) => db.pharmacyRefund.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
    const first = await Promise.all(
      [0, 1].map(() => transaction((db) => refundPharmacyTender(db, scope, refund)))
    );
    expect(first.map((row) => row.replayed).sort()).toEqual([false, true]);
    const partial = await entries();
    expect(partial).toHaveLength(2);
    expect(partial.find((row) => row.kind === 'EARN_REVERSAL')).toMatchObject({
      points: -5,
      netPaidMinor: 475,
      customerId: customer.id,
      branchId: branch,
      actorId: scope.actorId,
      refundId: (
        await transaction((db) =>
          db.pharmacyRefund.findFirstOrThrow({ where: { saleId: f.sale.id } })
        )
      ).id,
    });
    expect(partial.reduce((sum, row) => sum + row.points, 0)).toBe(4);
    expect(
      await transaction(
        (db) => db.pharmacyLoyaltyPointsEntry.findMany({ where: { saleId: f.sale.id } }),
        `foreign_${randomUUID()}`
      )
    ).toEqual([]);
    await expect(
      transaction(
        (db) =>
          refundPharmacyTender(
            db,
            { ...scope, organizationId: 'foreign' },
            { ...refund, idempotencyKey: randomUUID() }
          ),
        'foreign'
      )
    ).rejects.toThrow();
    await transaction((db) => returnSaleLine(db, scope, returnInput(f.line.id, 5)));
    const remaining = { ...refund, idempotencyKey: randomUUID() };
    await transaction((db) => refundPharmacyTender(db, scope, remaining));
    const completed = await entries();
    expect(completed).toHaveLength(3);
    expect(
      completed
        .filter((row) => row.kind === 'EARN_REVERSAL')
        .map((row) => row.points)
        .sort((a, b) => a - b)
    ).toEqual([-5, -4]);
    expect(completed.reduce((sum, row) => sum + row.points, 0)).toBe(0);
    await transaction((db) => refundPharmacyTender(db, scope, remaining));
    expect(await entries()).toEqual(completed);
    expect(completed.find((row) => row.kind === 'EARN')).toEqual(original[0]);
    const history = await transaction((db) => readLoyaltyHistory(db, scope, customer.id));
    expect(history.pointsBalance).toBe(0);
    expect(net(await saleJournal(f.sale.id), 'SALES_CLEARING')).toBe(0);
  });

  it('persists local token failure, retry, unknown reconciliation, conflicts and ordinary refund', async () => {
    const f = await fixture();
    const input = {
      branchId: branch,
      saleId: f.sale.id,
      action: 'SALE' as const,
      type: 'CARD' as const,
      deviceId: f.input.deviceId,
      businessDate,
      amountMinor: 950,
      operationKey: randomUUID(),
      outcome: 'FAILED' as const,
      mode: 'EXECUTE' as const,
      reason: 'Synthetic terminal response',
    };
    const failed = await transaction((db) => executeSandboxPayment(db, scope, input));
    expect(failed).toMatchObject({ status: 'FAILED', simulated: true, replayed: false });
    expect(
      await transaction((db) => db.pharmacyTender.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
    const unknownInput = { ...input, mode: 'RETRY' as const, outcome: 'UNKNOWN' as const };
    const unknown = await transaction((db) => executeSandboxPayment(db, scope, unknownInput));
    expect(unknown.token).toBe(failed.token);
    await expect(
      transaction((db) => executeSandboxPayment(db, scope, unknownInput))
    ).rejects.toThrow('RECONCILIATION_REQUIRED');
    const beforeBarrier = await saleJournal(f.sale.id);
    for (const mode of ['EXECUTE', 'RETRY'] as const) {
      await expect(
        transaction((db) =>
          executeSandboxPayment(db, scope, {
            ...input,
            operationKey: randomUUID(),
            amountMinor: 100,
            type: 'WALLET',
            outcome: 'APPROVED',
            mode,
          })
        )
      ).rejects.toThrow('RECONCILIATION_REQUIRED');
    }
    expect(await saleJournal(f.sale.id)).toEqual(beforeBarrier);
    expect(
      await transaction((db) => db.pharmacyTender.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
    const reconciledInput = { ...input, mode: 'RECONCILE' as const, outcome: 'APPROVED' as const };
    for (const conflict of [{ amountMinor: 949 }, { deviceId: randomUUID() }]) {
      await expect(
        transaction((db) => executeSandboxPayment(db, scope, { ...reconciledInput, ...conflict }))
      ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    }
    await expect(
      transaction(
        (db) => executeSandboxPayment(db, { ...scope, organizationId: 'foreign' }, reconciledInput),
        'foreign'
      )
    ).rejects.toThrow('SALE_NOT_FOUND');
    await expect(
      transaction(async (db) => {
        await executeSandboxPayment(db, scope, reconciledInput);
        throw new Error('LATE_SANDBOX_ROLLBACK');
      })
    ).rejects.toThrow('LATE_SANDBOX_ROLLBACK');
    expect(
      await transaction((db) => db.pharmacyTender.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
    const approvals = await Promise.all(
      [0, 1].map(() => transaction((db) => executeSandboxPayment(db, scope, reconciledInput)))
    );
    expect(approvals.map((row) => row.replayed).sort()).toEqual([false, true]);
    const tenders = await transaction((db) =>
      db.pharmacyTender.findMany({ where: { saleId: f.sale.id } })
    );
    expect(tenders).toHaveLength(1);
    expect(tenders[0]).toMatchObject({
      amountMinor: 950,
      provider: 'LOCAL_TOKEN_SANDBOX',
      providerRef: failed.token,
    });
    await transaction((db) => returnSaleLine(db, scope, returnInput(f.line.id, 10)));
    const refund = {
      ...input,
      action: 'REFUND' as const,
      originalTenderId: tenders[0].id,
      operationKey: randomUUID(),
      outcome: 'APPROVED' as const,
    };
    expect(await transaction((db) => executeSandboxPayment(db, scope, refund))).toMatchObject({
      status: 'APPROVED',
      simulated: true,
      replayed: false,
    });
    expect(await transaction((db) => executeSandboxPayment(db, scope, refund))).toMatchObject({
      replayed: true,
    });
    expect(
      await transaction((db) => db.pharmacyRefund.count({ where: { saleId: f.sale.id } }))
    ).toBe(1);
    expect(net(await saleJournal(f.sale.id), 'SALES_CLEARING')).toBe(0);
  });

  it('preserves a restricted branch before any delivery scope mutation or writes', async () => {
    await transaction(async (db) => {
      await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch);
      await expect(
        recordDeliveryCommand(
          db,
          { ...scope, branchId: 'foreign-branch' },
          {
            branchId: 'foreign-branch',
            orderId: 'foreign-order',
            action: 'REFUSED',
            reference: 'Synthetic refusal',
            requestKey: randomUUID(),
          }
        )
      ).rejects.toThrow('ORDER_NOT_FOUND');
      const current = await db.$queryRawUnsafe<Array<{ branch: string }>>(
        "SELECT current_setting('app.current_branch_id') AS branch"
      );
      expect(current[0].branch).toBe(branch);
      expect(await db.pharmacyOrderDeliveryEvidence.count({ where: { organizationId: org } })).toBe(
        0
      );
    });
  });

  it('records two equal resolved card payments and refunds separately while unknown blocks fresh refund keys', async () => {
    const f = await fixture();
    const customer = await transaction(async (db) => {
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: 'Synthetic card loyalty' },
      });
      await writePatientConsent(db, org, scope.actorId, {
        patientId: patient.id,
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        granted: true,
      });
      return linkCustomerToSale(db, scope, {
        saleId: f.sale.id,
        patientId: patient.id,
        displayName: 'Synthetic card loyalty',
      });
    });
    const input = {
      branchId: branch,
      saleId: f.sale.id,
      action: 'SALE' as const,
      type: 'CARD' as const,
      deviceId: f.input.deviceId,
      businessDate,
      amountMinor: 475,
      operationKey: randomUUID(),
      outcome: 'APPROVED' as const,
      mode: 'EXECUTE' as const,
      reason: 'Synthetic split card',
    };
    await transaction((db) => executeSandboxPayment(db, scope, input));
    await transaction((db) =>
      executeSandboxPayment(db, scope, { ...input, operationKey: randomUUID() })
    );
    const tenders = await transaction((db) =>
      db.pharmacyTender.findMany({ where: { saleId: f.sale.id } })
    );
    expect(tenders.map((row) => row.amountMinor)).toEqual([475, 475]);
    expect(
      (await transaction((db) => readLoyaltyHistory(db, scope, customer.id))).pointsBalance
    ).toBe(9);
    await transaction((db) => returnSaleLine(db, scope, returnInput(f.line.id, 10)));
    const refund = {
      ...input,
      action: 'REFUND' as const,
      originalTenderId: tenders[0].id,
      amountMinor: 100,
      operationKey: randomUUID(),
      outcome: 'UNKNOWN' as const,
    };
    await transaction((db) => executeSandboxPayment(db, scope, refund));
    await expect(
      transaction((db) =>
        executeSandboxPayment(db, scope, {
          ...refund,
          operationKey: randomUUID(),
          amountMinor: 100,
          outcome: 'APPROVED',
        })
      )
    ).rejects.toThrow('RECONCILIATION_REQUIRED');
    expect(
      await transaction((db) => db.pharmacyRefund.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
    const reconciled = { ...refund, mode: 'RECONCILE' as const, outcome: 'APPROVED' as const };
    const outcomes = await Promise.all(
      [0, 1].map(() => transaction((db) => executeSandboxPayment(db, scope, reconciled)))
    );
    expect(outcomes.map((row) => row.replayed).sort()).toEqual([false, true]);
    const distinctRefunds = [randomUUID(), randomUUID()].map((operationKey) => ({
      ...refund,
      operationKey,
      amountMinor: 150,
      outcome: 'APPROVED' as const,
    }));
    await Promise.all(
      distinctRefunds.map((command) =>
        transaction((db) => executeSandboxPayment(db, scope, command))
      )
    );
    await transaction((db) => executeSandboxPayment(db, scope, distinctRefunds[0]));
    const refunds = await transaction((db) =>
      db.pharmacyRefund.findMany({ where: { saleId: f.sale.id } })
    );
    expect(refunds.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([100, 150, 150]);
    expect(
      (await transaction((db) => readLoyaltyHistory(db, scope, customer.id))).pointsBalance
    ).toBe(5);
    // 950 returned value, 400 refunded: the remaining customer credit is explicit.
    expect(net(await saleJournal(f.sale.id), 'SALES_CLEARING')).toBe(-550);
  });

  it('accepts strict CLOSED demand without weakening OPEN or genuine RECOVERED shapes', async () => {
    const f = await cashBill();
    const demand = {
      organizationId: org,
      branchId: branch,
      requestedMedicineId: f.medicine.id,
      saleId: f.sale.id,
      saleUnit: 'UNIT' as const,
      quantity: 1,
      reason: 'SERVICE_FAILURE' as const,
      inventoryRuleSnapshot: { source: 'SYNTHETIC_CONSTRAINT_PROOF' },
      capturedByUserId: scope.actorId,
    };
    const opened = await transaction((db) => db.unfulfilledDemandEvent.create({ data: demand }));
    const closedAt = new Date();
    const closed = await transaction((db) =>
      db.unfulfilledDemandEvent.update({
        where: { id: opened.id },
        data: { status: 'CLOSED', closedAt },
      })
    );
    expect(closed).toMatchObject({
      status: 'CLOSED',
      closedAt,
      recoveredSaleLineId: null,
      recoveredAt: null,
    });
    const recovered = await transaction((db) =>
      db.unfulfilledDemandEvent.create({
        data: {
          ...demand,
          status: 'RECOVERED',
          recoveredSaleLineId: f.line.id,
          recoveredAt: closedAt,
        },
      })
    );
    expect(recovered.recoveredSaleLineId).toBe(f.line.id);
    for (const malformed of [
      { status: 'CLOSED' as const, closedAt: null },
      { status: 'CLOSED' as const, closedAt, recoveredSaleLineId: f.line.id },
      { status: 'CLOSED' as const, closedAt, recoveredAt: closedAt },
      { status: 'OPEN' as const, recoveredAt: closedAt },
      { status: 'RECOVERED' as const, recoveredSaleLineId: f.line.id },
    ]) {
      await expect(
        transaction((db) => db.unfulfilledDemandEvent.create({ data: { ...demand, ...malformed } }))
      ).rejects.toThrow('pharmacy_demand_recovery_check');
    }
    expect(
      await transaction((db) => db.unfulfilledDemandEvent.findUnique({ where: { id: opened.id } }))
    ).toEqual(closed);
  });

  it('reproduces the legacy advisory-lock void decoding failure on this disposable lane', async () => {
    await expect(
      transaction((db) =>
        db.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended('synthetic-legacy-return-lock', 0))"
        )
      )
    ).rejects.toThrow(/Failed to deserialize column of type 'void'/);
  });
  it('posts a completed cash receipt once, exact lot costs, and immutable reprint identity', async () => {
    const f = await cashBill();
    expect(f.tender).toMatchObject({ settled: true, replayed: false });
    const receipt = await read(f.sale.id);
    expect(await transaction((db) => applyPharmacyTender(db, scope, f.input))).toMatchObject({
      replayed: true,
    });
    expect(await read(f.sale.id)).toEqual(receipt);
    const rows = await journal(f.line.id);
    expect(net(rows, 'SALES_REVENUE')).toBe(-1000);
    expect(net(rows, 'SALES_DISCOUNT')).toBe(50);
    expect(net(rows, 'COST_OF_GOODS_SOLD')).toBe(17);
    expect(net(rows, 'INVENTORY')).toBe(-17);
    const entries = await transaction((db) =>
      db.financeJournalEntry.findMany({
        where: { sourceId: { in: [f.line.id, f.tenderId] } },
        include: { lines: true },
      })
    );
    expect(entries).toHaveLength(2);
    expect(entries.find((row) => row.sourceKind === 'PHARMACY_TENDER')?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'CASH', side: 'DEBIT', amountMinor: 950 }),
      ])
    );
    const stock = await transaction((db) =>
      db.pharmacyStockMovement.findMany({
        where: { inventoryLotId: { in: rows.map((row) => row.lotId!).filter(Boolean) } },
      })
    );
    expect(
      stock.filter((row) => row.kind === 'SALE').reduce((sum, row) => sum + row.quantityUnits, 0)
    ).toBe(-10);
  });

  it('split 1+2 discounted returns reverse all 102 gross/2 discount/5 cost with no residual; caps refunds', async () => {
    const f = await cashBill(true);
    const receipt = await read(f.sale.id);
    const first = returnInput(f.line.id, 1);
    await transaction((db) => returnSaleLine(db, scope, first));
    expect(await transaction((db) => returnSaleLine(db, scope, first))).toMatchObject({
      replayed: true,
    });
    const refundInput = {
      originalTenderId: f.tenderId,
      deviceId: f.input.deviceId,
      businessDate,
      amountMinor: 33,
      reason: 'Partial return',
      requireReturnedValue: true,
      idempotencyKey: randomUUID(),
    };
    await transaction((db) => refundPharmacyTender(db, scope, refundInput));
    expect(net(await saleJournal(f.sale.id), 'SALES_CLEARING')).toBe(0);
    expect(net(await journal(f.line.id), 'SALES_REVENUE')).toBe(-69);
    expect(net(await journal(f.line.id), 'SALES_DISCOUNT')).toBe(2);
    await expect(
      transaction((db) =>
        refundPharmacyTender(db, scope, {
          ...refundInput,
          amountMinor: 1,
          idempotencyKey: randomUUID(),
        })
      )
    ).rejects.toThrow('REFUND_EXCEEDS_TENDER');
    const quarantine = await transaction((db) =>
      db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: branch,
          code: randomUUID(),
          name: 'Return quarantine',
          kind: 'QUARANTINE',
        },
      })
    );
    await transaction((db) =>
      returnSaleLine(db, scope, {
        ...returnInput(f.line.id, 2),
        disposition: 'QUARANTINE',
        quarantineLocationId: quarantine.id,
      })
    );
    const remaining = { ...refundInput, amountMinor: 67, idempotencyKey: randomUUID() };
    const refunds = await Promise.all(
      [0, 1].map(() => transaction((db) => refundPharmacyTender(db, scope, remaining)))
    );
    expect(refunds.map((row) => row.replayed).sort()).toEqual([false, true]);
    const rows = await journal(f.line.id);
    for (const account of [
      'SALES_REVENUE',
      'SALES_DISCOUNT',
      'COST_OF_GOODS_SOLD',
      'INVENTORY',
      'SALES_CLEARING',
    ])
      expect(net(rows, account)).toBe(0);
    const returns = await transaction((db) =>
      db.pharmacySaleReturnLine.findMany({
        where: { saleLineId: f.line.id },
      })
    );
    expect(returns.reduce((sum, row) => sum + row.canonicalUnits, 0)).toBe(3);
    const movements = await transaction((db) =>
      db.pharmacyStockMovement.findMany({
        where: {
          id: {
            in: returns
              .filter((row) => row.stockLocationId === quarantine.id)
              .map((row) => row.stockMovementId),
          },
        },
      })
    );
    expect(movements.every((row) => row.disposition === 'QUARANTINE')).toBe(true);
    const closed = await transaction((db) =>
      closePharmacyDrawer(db, scope, { drawerSessionId: f.drawer.id, countedCashMinor: 1000 })
    );
    expect(closed).toMatchObject({ expectedCashMinor: 1000, varianceMinor: 0 });
    // Receipt snapshot stays the original issued sale; refunds are separate events.
    expect((await read(f.sale.id))?.receiptNumber).toBe(receipt?.receiptNumber);
  });

  it.each([
    [1, 2, 33, 67],
    [2, 1, 66, 34],
  ])(
    'reconciles split %i+%i immediately and preserves return/refund replay',
    async (firstUnits, lastUnits, firstRefund, lastRefund) => {
      const f = await cashBill(true);
      for (const [units, amountMinor] of [
        [firstUnits, firstRefund],
        [lastUnits, lastRefund],
      ]) {
        const returned = returnInput(f.line.id, units!);
        await transaction((db) => returnSaleLine(db, scope, returned));
        const refunded = {
          originalTenderId: f.tenderId,
          deviceId: f.input.deviceId,
          businessDate,
          amountMinor: amountMinor!,
          reason: 'Split net regression',
          requireReturnedValue: true,
          idempotencyKey: randomUUID(),
        };
        await transaction((db) => refundPharmacyTender(db, scope, refunded));
        const before = await saleJournal(f.sale.id);
        expect(net(before, 'SALES_CLEARING')).toBe(0);
        const stock = () =>
          transaction((db) =>
            db.pharmacyStockMovement.findMany({
              where: { inventoryLotId: { in: before.map((row) => row.lotId!).filter(Boolean) } },
              orderBy: { id: 'asc' },
            })
          );
        const stockBefore = await stock();
        expect(await transaction((db) => returnSaleLine(db, scope, returned))).toMatchObject({
          replayed: true,
        });
        expect(await transaction((db) => refundPharmacyTender(db, scope, refunded))).toMatchObject({
          replayed: true,
        });
        expect(await saleJournal(f.sale.id)).toEqual(before);
        expect(await stock()).toEqual(stockBefore);
      }
      const rows = await saleJournal(f.sale.id);
      for (const account of [
        'SALES_REVENUE',
        'SALES_DISCOUNT',
        'COST_OF_GOODS_SOLD',
        'INVENTORY',
        'SALES_CLEARING',
        'CASH',
      ]) {
        expect(net(rows, account)).toBe(0);
      }
      const returns = await transaction((db) =>
        db.pharmacySaleReturnLine.findMany({ where: { saleLineId: f.line.id } })
      );
      expect(returns.reduce((total, row) => total + row.canonicalUnits, 0)).toBe(3);
    }
  );

  it('serializes concurrent last-unit returns and denies foreign-tenant return/refund without posting', async () => {
    const f = await cashBill(true);
    const results = await Promise.allSettled(
      [0, 1].map(() => transaction((db) => returnSaleLine(db, scope, returnInput(f.line.id, 3))))
    );
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const before = await journal(f.line.id);
    const foreign = `foreign_${randomUUID()}`;
    await expect(
      transaction(
        (db) =>
          returnSaleLine(db, { ...scope, organizationId: foreign }, returnInput(f.line.id, 1)),
        foreign
      )
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      transaction(
        (db) =>
          refundPharmacyTender(
            db,
            { ...scope, organizationId: foreign },
            {
              originalTenderId: f.tenderId,
              deviceId: f.input.deviceId,
              businessDate,
              amountMinor: 1,
              reason: 'Foreign denial',
              idempotencyKey: randomUUID(),
            }
          ),
        foreign
      )
    ).rejects.toThrow('REFUND_EXCEEDS_TENDER');
    expect(await journal(f.line.id)).toEqual(before);
  });

  it.each(['CARD', 'WALLET'] as const)(
    'accounts persisted %s cash fallback against Cash, and replays once',
    async (type) => {
      const f = await fixture(true);
      const drawer = await transaction((db) =>
        openPharmacyDrawer(db, scope, {
          deviceId: f.input.deviceId,
          businessDate,
          openingFloatMinor: 1000,
        })
      );
      // Accounting double only: no PSP/terminal certification or network access.
      await transaction((db) =>
        applyPharmacyTender(db, scope, {
          ...f.input,
          type,
          adapter: {
            name: 'SYNTHETIC_ACCOUNTING',
            certified: true,
            execute: async () => ({ approved: true, providerRef: 'synthetic-only' }),
          },
        })
      );
      const tender = await transaction((db) =>
        db.pharmacyTender.findFirstOrThrow({ where: { saleId: f.sale.id } })
      );
      await transaction((db) => returnSaleLine(db, scope, returnInput(f.line.id, 3)));
      const input = {
        originalTenderId: tender.id,
        deviceId: f.input.deviceId,
        businessDate,
        amountMinor: 100,
        reason: 'Manual cash fallback',
        manualCashFallback: true,
        requireReturnedValue: true,
        idempotencyKey: randomUUID(),
      };
      expect(await transaction((db) => refundPharmacyTender(db, scope, input))).toMatchObject({
        manualReversalRequired: true,
      });
      expect(await transaction((db) => refundPharmacyTender(db, scope, input))).toMatchObject({
        replayed: true,
      });
      const refund = await transaction((db) =>
        db.pharmacyRefund.findFirstOrThrow({ where: { saleId: f.sale.id } })
      );
      expect(refund.drawerSessionId).toBe(drawer.id);
      const entries = await transaction((db) =>
        db.financeJournalEntry.findMany({
          where: { sourceId: refund.id },
          include: { lines: true },
        })
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.lines.filter((row) => row.side === 'CREDIT')).toEqual([
        expect.objectContaining({ accountCode: 'CASH', amountMinor: 100 }),
      ]);
      expect(
        await transaction((db) =>
          closePharmacyDrawer(db, scope, { drawerSessionId: drawer.id, countedCashMinor: 900 })
        )
      ).toMatchObject({ expectedCashMinor: 900, varianceMinor: 0 });
    }
  );

  it('rolls back operational stock, tender and automatic journal writes on a late transaction failure', async () => {
    const f = await fixture();
    await expect(
      transaction(async (db) => {
        await applyPharmacyTender(db, scope, f.input);
        throw new Error('SYNTHETIC_LATE_FAILURE');
      })
    ).rejects.toThrow('SYNTHETIC_LATE_FAILURE');
    expect(await journal(f.line.id)).toEqual([]);
    expect(
      await transaction((db) => db.pharmacyTender.count({ where: { saleId: f.sale.id } }))
    ).toBe(0);
    expect(
      await transaction((db) => db.pharmacySale.findFirstOrThrow({ where: { id: f.sale.id } }))
    ).toMatchObject({ status: 'OPEN' });
    await transaction((db) => applyPharmacyTender(db, scope, f.input));
    const before = await journal(f.line.id);
    await expect(
      transaction(async (db) => {
        await returnSaleLine(db, scope, returnInput(f.line.id, 10));
        throw new Error('SYNTHETIC_LATE_FAILURE');
      })
    ).rejects.toThrow('SYNTHETIC_LATE_FAILURE');
    expect(await journal(f.line.id)).toEqual(before);
    expect(
      await transaction((db) =>
        db.pharmacySaleReturnLine.count({ where: { saleLineId: f.line.id } })
      )
    ).toBe(0);
  });
});
