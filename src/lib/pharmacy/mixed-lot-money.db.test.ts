// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { growthReceiptMoney } from '@/lib/pharmacy/growth-evidence';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenantDb, withPlatformDb } from '@/lib/tenancy/scoped-db';
import { createSale, addSaleLine, readReturnHistory, returnSaleLine } from '@/lib/pharmacy/sales';
import { receiveLot } from '@/lib/pharmacy/stock-ledger';
import {
  applyPharmacyTender,
  readPharmacyTenderOutcome,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';
import { readCounterReceipt, readCounterCart } from '@/lib/pharmacy/counter';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';
import type { PharmacyInventoryLot } from '@/generated/prisma/client';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const test = it.skipIf(!TEST_DATABASE_URL);
const org = 'pr919_' + randomUUID().slice(0, 8);
const scope = { organizationId: org, branchId: org + '_branch', actorId: 'reviewer' };
const day = new Date('2026-10-31');
const tenant = <T>(fn: (db: ScopedDb) => Promise<T>) => withTenantDb(org, fn, { timeout: 30000 });
let locationId: string;
const ruleSetIds: string[] = [];
beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: org,
        slug: org,
        legalName: org,
        displayName: org,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    })
  );
  locationId = await tenant(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId: org,
        code: org,
        name: 'QA',
        addressLine: 'QA',
        city: 'QA',
        provinceCode: 'PB',
      },
    });
    return (
      await db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: scope.branchId,
          code: randomUUID(),
          name: 'Stock',
          kind: 'STORE',
        },
      })
    ).id;
  });
  ruleSetIds.push(await seedPharmacyRegulatoryProfile(withPlatformDb, tenant, scope.branchId));
});
afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
});
async function cart(prices = [100, 200], quantities = [1, 1], costs = prices.map(() => 1)) {
  return tenant(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: org,
        productName: randomUUID(),
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        otc: true,
        presentations: { create: { organizationId: org, presentation: 'Unit' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId: org,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2020-01-01'),
      },
    });
    const lots: PharmacyInventoryLot[] = [];
    for (let i = 0; i < prices.length; i++) {
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt: new Date('2031-01-0' + (i + 1)),
          expiryPrecision: 'DAY',
        },
      });
      const { lot } = await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: locationId,
        unitsPerPack: 1,
        supplierName: 'QA',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: costs[i]!,
        printedMrpMinor: prices[i]!,
        receivedExpiresAt: batch.expiresAt as Date,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: quantities[i]!,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2020-01-01'),
      });
      lots.push(lot);
    }
    const sale = await createSale(db, scope);
    const { line } = await addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity: quantities.reduce((a, b) => a + b, 0),
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
    return { sale, line, lots };
  });
}
test('charges the weighted amount, completes once, freezes receipt identity, and rolls back failed tender', async () => {
  const f = await cart([100, 101], [2, 1]);
  expect(f.line).toMatchObject({ grossMinor: 301, unitPriceMinor: 100 });
  const input = {
    saleId: f.sale.id,
    deviceId: randomUUID(),
    businessDate: day,
    type: 'BANK_TRANSFER' as const,
    providerRef: 'BANK-001',
    amountMinor: 301,
    idempotencyKey: randomUUID(),
  };
  await expect(
    tenant(async (db) => {
      await applyPharmacyTender(db, scope, input);
      throw Error('abort QA');
    })
  ).rejects.toThrow('abort QA');
  await tenant(async (db) => {
    expect(await db.pharmacyTender.count({ where: { saleId: f.sale.id } })).toBe(0);
    expect((await db.pharmacySale.findFirstOrThrow({ where: { id: f.sale.id } })).status).toBe(
      'OPEN'
    );
  });
  const results = await Promise.all([
    tenant((db) => applyPharmacyTender(db, scope, input)),
    tenant((db) => applyPharmacyTender(db, scope, input)),
  ]);
  expect(results.every((r) => 'settled' in r && r.settled === true)).toBe(true);
  await tenant(async (db) => {
    const c = await readCounterCart(db, scope, f.sale.id);
    expect(c.totals.netMinor).toBe(301);
    const r = await readCounterReceipt(db, scope, f.sale.id, { name: 'QA', currency: 'PKR' });
    expect(r.totals.netMinor).toBe(301);
    expect(r.lines[0]!.identityStatus).toBe('ISSUED');
    const growth = await db.$queryRaw<Array<{ complete: boolean; sales: bigint }>>(
      Prisma.sql`SELECT m.* FROM pharmacy_sales s CROSS JOIN LATERAL (${growthReceiptMoney(new Date('2035-01-01'))}) m WHERE s.id=${f.sale.id}`
    );
    expect(growth[0]!.complete).toBe(true);
    expect(Number(growth[0]!.sales)).toBe(301);
    expect(await db.pharmacyTender.count({ where: { saleId: f.sale.id } })).toBe(1);
    expect(
      await db.pharmacySaleEvent.count({ where: { saleId: f.sale.id, kind: 'COMPLETED' } })
    ).toBe(1);
  });
});
test('records exact revenue against each mixed-MRP lot', async () => {
  const f = await cart();
  await tenant((db) =>
    applyPharmacyTender(db, scope, {
      saleId: f.sale.id,
      deviceId: randomUUID(),
      businessDate: day,
      type: 'BANK_TRANSFER',
      providerRef: 'BANK-001',
      amountMinor: 300,
      idempotencyKey: randomUUID(),
    })
  );
  const shares = await tenant((db) =>
    db.financeJournalLine.findMany({
      where: { sourceLineId: f.line.id, accountCode: 'SALES_REVENUE' },
      select: { lotId: true, amountMinor: true },
    })
  );
  expect(shares.find((s) => s.lotId === f.lots[0]!.id)!.amountMinor).toBe(100);
  expect(shares.find((s) => s.lotId === f.lots[1]!.id)!.amountMinor).toBe(200);
});
test.each([0, 1])(
  'refunds the identified lot at its own billed value (lot %i)',
  async (lotIndex) => {
    const f = await cart();
    const input = {
      saleId: f.sale.id,
      deviceId: randomUUID(),
      businessDate: day,
      type: 'BANK_TRANSFER' as const,
      providerRef: 'BANK-001',
      amountMinor: 300,
      idempotencyKey: randomUUID(),
    };
    await tenant((db) => applyPharmacyTender(db, scope, input));
    await tenant((db) =>
      returnSaleLine(db, scope, {
        saleLineId: f.line.id,
        lotId: f.lots[lotIndex]!.id,
        canonicalUnits: 1,
        disposition: 'RESTOCK',
        reason: 'Return identified lot',
        integrityDecision: 'Sealed',
        idempotencyKey: randomUUID(),
      })
    );
    const history = await tenant((db) => readReturnHistory(db, scope, f.sale.id));
    const billed = f.lots[lotIndex]!.printedMrpMinor;
    expect(history.refundableMinor).toBe(billed);
    const tender = await tenant((db) =>
      db.pharmacyTender.findFirstOrThrow({ where: { saleId: f.sale.id } })
    );
    await expect(
      tenant((db) =>
        refundPharmacyTender(db, scope, {
          originalTenderId: tender.id,
          deviceId: input.deviceId,
          businessDate: day,
          amountMinor: billed + 1,
          reason: 'QA excess refund',
          idempotencyKey: randomUUID(),
        })
      )
    ).rejects.toThrow('REFUND_EXCEEDS_TENDER');
    await tenant((db) =>
      refundPharmacyTender(db, scope, {
        originalTenderId: tender.id,
        deviceId: input.deviceId,
        businessDate: day,
        amountMinor: billed,
        reason: 'Refund identified lot',
        idempotencyKey: randomUUID(),
      })
    );
    const reverse = await tenant((db) =>
      db.financeJournalLine.findMany({
        where: { sourceLineId: f.line.id, accountCode: 'SALES_REVENUE', side: 'DEBIT' },
        select: { lotId: true, amountMinor: true },
      })
    );
    expect(reverse).toEqual([{ lotId: f.lots[lotIndex]!.id, amountMinor: billed }]);
    expect((await tenant((db) => readReturnHistory(db, scope, f.sale.id))).refundableMinor).toBe(0);
    await tenant((db) =>
      returnSaleLine(db, scope, {
        saleLineId: f.line.id,
        lotId: f.lots[1 - lotIndex]!.id,
        canonicalUnits: 1,
        disposition: 'RESTOCK',
        reason: 'Return other lot',
        integrityDecision: 'Sealed',
        idempotencyKey: randomUUID(),
      })
    );
    expect((await tenant((db) => readReturnHistory(db, scope, f.sale.id))).refundableMinor).toBe(
      300 - billed
    );
  }
);
test('restores a free zero-cost allocation and posts one balanced marker across retries', async () => {
  const f = await cart([0, 200], [1, 1], [0, 1]);
  await tenant((db) =>
    applyPharmacyTender(db, scope, {
      saleId: f.sale.id,
      deviceId: randomUUID(),
      businessDate: day,
      type: 'BANK_TRANSFER',
      providerRef: 'BANK-001',
      amountMinor: 200,
      idempotencyKey: randomUUID(),
    })
  );
  const input = {
    saleLineId: f.line.id,
    lotId: f.lots[0]!.id,
    canonicalUnits: 1,
    disposition: 'RESTOCK' as const,
    reason: 'Return free allocation',
    integrityDecision: 'Sealed',
    idempotencyKey: randomUUID(),
  };
  const returned = await tenant((db) => returnSaleLine(db, scope, input));
  expect(returned.returnLine).toMatchObject({ grossMinor: 0, discountMinor: 0 });
  const replay = await tenant((db) => returnSaleLine(db, scope, input));
  expect(replay).toMatchObject({ returnId: returned.returnId, replayed: true });
  await tenant(async (db) => {
    const stock = await db.pharmacyStockBalance.findFirstOrThrow({
      where: {
        inventoryLotId: input.lotId,
        stockLocationId: locationId,
        disposition: 'AVAILABLE',
      },
    });
    expect(stock.onHandUnits).toBe(1);
    const entries = await db.financeJournalEntry.findMany({
      where: {
        sourceKind: 'PHARMACY_SALE_RETURN_LINE',
        sourceId: returned.returnLine!.id,
      },
      include: { lines: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lines).toHaveLength(2);
    expect(entries[0]!.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountCode: 'SALES_CLEARING',
          side: 'DEBIT',
          amountMinor: 1,
          lotId: input.lotId,
          sourceLineId: f.line.id,
        }),
        expect.objectContaining({
          accountCode: 'SALES_CLEARING',
          side: 'CREDIT',
          amountMinor: 1,
          lotId: input.lotId,
          sourceLineId: f.line.id,
        }),
      ])
    );
    expect((await readReturnHistory(db, scope, f.sale.id)).refundableMinor).toBe(0);
  });
});
test('enforces an upper MRP bound on the new billed gross in PostgreSQL', async () => {
  const f = await cart([100], [1]);
  await expect(
    tenant((db) =>
      db.$executeRawUnsafe(
        'UPDATE pharmacy_sale_lines SET "grossMinor"=1000000 WHERE id=$1',
        f.line.id
      )
    )
  ).rejects.toThrow();
});

test.each([
  ['CARD', 'No slip details'],
  ['BANK_TRANSFER', 'No transfer details'],
] as const)(
  'DEV-1045 settles a %s with no details and labels its recorded payment',
  async (type, label) => {
    const f = await cart();
    const input = {
      saleId: f.sale.id,
      deviceId: randomUUID(),
      businessDate: day,
      type,
      amountMinor: 300,
      idempotencyKey: randomUUID(),
    };
    const result = await tenant((db) => applyPharmacyTender(db, scope, input));
    expect(result).toMatchObject({ settled: true, remainingMinor: 0 });
    const history = await tenant((db) => readReturnHistory(db, scope, f.sale.id));
    expect(history.tenders[0]).toMatchObject({ type, amountMinor: 300, paymentDetails: label });
    const receipt = await tenant((db) =>
      readCounterReceipt(db, scope, f.sale.id, { name: 'QA', currency: 'PKR' })
    );
    expect(receipt?.tenders[0]).toMatchObject({ type, amountMinor: 300, paymentDetails: label });
  }
);

test('DEV-1045 honours the wallet skip policy and recovers an explicitly skipped reference', async () => {
  await tenant((db) =>
    db.pharmacyBranch.update({
      where: { id: scope.branchId },
      data: {
        requirePaymentDetails: false,
        manualPaymentSettings: {
          RAAST: { destination: 'Synthetic test till', allowReferenceSkip: false },
        },
      },
    })
  );
  const sale = await cart();
  const input = {
    saleId: sale.sale.id,
    deviceId: randomUUID(),
    businessDate: day,
    type: 'RAAST' as const,
    amountMinor: 300,
    payerName: 'Synthetic payer',
    idempotencyKey: randomUUID(),
  };
  await expect(tenant((db) => applyPharmacyTender(db, scope, input))).rejects.toMatchObject({
    reason: 'INVALID_MANUAL_CAPTURE',
  });
  const skipped = { ...input, referenceSkipped: true };
  await expect(tenant((db) => applyPharmacyTender(db, scope, skipped))).rejects.toMatchObject({
    reason: 'INVALID_MANUAL_CAPTURE',
  });
  await tenant((db) =>
    db.pharmacyBranch.update({
      where: { id: scope.branchId },
      data: {
        manualPaymentSettings: {
          RAAST: { destination: 'Synthetic test till', allowReferenceSkip: true },
        },
      },
    })
  );
  const result = await tenant((db) => applyPharmacyTender(db, scope, skipped));
  expect(result).toMatchObject({ settled: true, replayed: false });
  if (!('tenderId' in result)) throw new Error('Expected a new wallet tender');
  expect(await tenant((db) => readPharmacyTenderOutcome(db, scope, skipped))).toEqual({
    status: 'ACCEPTED',
    replayUnsafe: true,
    result: {
      tenderId: result.tenderId,
      remainingMinor: 0,
      settled: true,
      receiptNumber: result.receiptNumber,
    },
  });
  expect(
    await tenant((db) =>
      readPharmacyTenderOutcome(db, scope, { ...skipped, payerName: 'Different payer' })
    )
  ).toMatchObject({ status: 'UNKNOWN', replayUnsafe: true });
});

test.each([undefined, '   '])(
  'DEV-875 rolls back a transfer without a reference (%j) and records valid evidence',
  async (providerRef) => {
    await tenant((db) =>
      db.pharmacyBranch.update({
        where: { id: scope.branchId },
        data: { requirePaymentDetails: true },
      })
    );
    const f = await cart();
    const input = {
      saleId: f.sale.id,
      deviceId: randomUUID(),
      businessDate: day,
      type: 'BANK_TRANSFER' as const,
      amountMinor: 300,
      providerRef,
      idempotencyKey: randomUUID(),
    };
    await expect(tenant((db) => applyPharmacyTender(db, scope, input))).rejects.toMatchObject({
      reason: 'INVALID_MANUAL_CAPTURE',
    });
    expect(await tenant((db) => db.pharmacyTender.count({ where: { saleId: f.sale.id } }))).toBe(0);
    expect(
      await tenant((db) =>
        db.pharmacyMoneyIdempotencyKey.count({ where: { key: input.idempotencyKey } })
      )
    ).toBe(0);
    const result = await tenant((db) =>
      applyPharmacyTender(db, scope, { ...input, providerRef: ' BANK/2026-001 ' })
    );
    if (!('settled' in result)) throw new Error('Expected a newly created bank transfer');
    expect(result.settled).toBe(true);
    expect(
      await tenant((db) => db.pharmacyTender.findFirst({ where: { id: result.tenderId } }))
    ).toMatchObject({
      providerRef: 'BANK/2026-001',
      confirmedById: scope.actorId,
      type: 'BANK_TRANSFER',
      amountMinor: 300,
    });
  }
);

test.each([false, true])(
  'database manual card and transfer policy, requirePaymentDetails=%s',
  async (required) => {
    const f = await cart();
    await tenant((db) =>
      db.pharmacyBranch.update({
        where: { id: scope.branchId },
        data: { requirePaymentDetails: required },
      })
    );
    const base = {
      ...scope,
      saleId: f.sale.id,
      deviceId: randomUUID(),
      businessDate: day,
      amountMinor: 1,
      confirmedById: scope.actorId,
    };
    const card = (evidence: { providerRef?: string; approvalCode?: string }) =>
      tenant((db) =>
        db.pharmacyTender.create({
          data: { ...base, type: 'CARD', provider: 'MANUAL_TERMINAL', ...evidence },
        })
      );
    const transfer = (providerRef?: string) =>
      tenant((db) =>
        db.pharmacyTender.create({ data: { ...base, type: 'BANK_TRANSFER', providerRef } })
      );
    for (const optional of [
      () => card({}),
      () => card({ providerRef: '1234' }),
      () => card({ approvalCode: 'OK12' }),
      () => transfer(),
    ]) {
      if (required) await expect(optional()).rejects.toThrow(/requires payment details/);
      else await expect(optional()).resolves.toMatchObject({ confirmedById: scope.actorId });
    }
    await expect(card({ providerRef: '1234', approvalCode: 'OK12' })).resolves.toMatchObject({
      providerRef: '1234',
      approvalCode: 'OK12',
    });
    await expect(card({ providerRef: '1234567890123456', approvalCode: 'OK12' })).rejects.toThrow(
      /pharmacy_manual_card_tender_capture_check/
    );
    await expect(card({ providerRef: '1234', approvalCode: '!' })).rejects.toThrow(
      /pharmacy_manual_card_tender_capture_check/
    );
    await expect(transfer('QA-TRANSFER-100')).resolves.toMatchObject({
      providerRef: 'QA-TRANSFER-100',
    });
    // The provider lane carries its own external approval. No standalone slip is required.
    await expect(
      tenant((db) =>
        db.pharmacyTender.create({
          data: {
            ...base,
            type: 'CARD',
            provider: 'FAKE_TERMINAL',
            providerRef: randomUUID(),
          },
        })
      )
    ).resolves.toMatchObject({ provider: 'FAKE_TERMINAL', approvalCode: null });
  }
);
