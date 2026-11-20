// @vitest-environment node
/**
 * DEV-956: the whole-bill discount on real PostgreSQL, as the restricted runtime role.
 *
 * Needs a fully migrated, disposable database in TEST_DATABASE_URL (see
 * scripts/run-pharmacy-db-tests.sh). Without it the suite is skipped.
 */
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import type { PharmacyInventoryLot } from '@/generated/prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';
import { applyBillDiscount } from './bill-discount-service';
import { readCounterCart, readCounterReceipt } from './counter';
import { COUNTER_ERROR_MESSAGES, counterSaleErrorMessage } from './counter-messages';
import { receiptTierLines } from './counter-receipt';
import { recordDeliveryCommand } from './customer-delivery';
import { movePrepaid, publishPrepaidSettings } from './prepaid-tiers';
import {
  addSaleLine,
  changeSaleStatus,
  PharmacySaleError,
  createSale,
  readReturnHistory,
  returnSaleLine,
} from './sales';
import { applyPharmacyTender } from './settlement';
import { receiveLot } from './stock-ledger';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const org = 'dev956_' + randomUUID().slice(0, 8);
const scope = { organizationId: org, branchId: org + '_branch', actorId: org + '_cashier' };
const approval = {
  approvedByUserId: org + '_manager',
  approvalPolicy: 'MANAGER_PIN',
  selfApproved: false,
};
const day = new Date('2026-11-19');
const tenant = <T>(fn: (db: ScopedDb) => Promise<T>) => withTenantDb(org, fn, { timeout: 30000 });
let locationId: string;
const ruleSetIds: string[] = [];

/** A saleable OTC item received as one lot per price, at the given unit costs. */
async function item(db: ScopedDb, prices: number[], costs: number[]) {
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
        expiresAt: new Date(`2031-01-0${i + 1}`),
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
      quantityUnits: 1,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2020-01-01'),
    });
    lots.push(lot);
  }
  return { medicine, presentation, pack, lots };
}

/**
 * A bill of: line A (two lots, Rs 1.00 and Rs 2.00, cost 0.50 each), line B (one lot, Rs 3.33,
 * cost 1.00) and line C (Rs 5.00 with its own item discount of 0.10).
 */
async function bill() {
  return tenant(async (db) => {
    const sale = await createSale(db, scope);
    const add = async (
      found: Awaited<ReturnType<typeof item>>,
      extra: Partial<Parameters<typeof addSaleLine>[2]> = {}
    ) =>
      (
        await addSaleLine(db, scope, {
          saleId: sale.id,
          medicineId: found.medicine.id,
          presentationId: found.presentation.id,
          packLevelId: found.pack.id,
          saleUnit: 'UNIT',
          quantity: found.lots.length,
          canonicalUnitsPerSaleUnit: 1,
          idempotencyKey: randomUUID(),
          ...extra,
        })
      ).line;
    const a = await item(db, [100, 200], [50, 50]);
    const b = await item(db, [333], [100]);
    const c = await item(db, [500], [100]);
    const lineA = await add(a);
    const lineB = await add(b);
    const lineC = await add(c, {
      discountKind: 'DISCOUNT',
      discountMinor: 10,
      approvedByUserId: approval.approvedByUserId,
      approvalPolicy: 'MANAGER_PIN',
    });
    return { sale, lineA, lineB, lineC, lots: { a: a.lots, b: b.lots, c: c.lots } };
  });
}

const setEnabled = (enabled: boolean) =>
  withPlatformDb((db) =>
    db.organization.update({ where: { id: org }, data: { pharmacyBillDiscountEnabled: enabled } })
  );
const setMaximum = (bps: number) =>
  withPlatformDb((db) =>
    db.organization.update({ where: { id: org }, data: { pharmacyMaxDiscountBps: bps } })
  );
const lines = (saleId: string) =>
  tenant((db) =>
    db.pharmacySaleLine.findMany({ where: { saleId }, orderBy: { createdAt: 'asc' } })
  );
const tender = (saleId: string, amountMinor: number) =>
  tenant((db) =>
    applyPharmacyTender(db, scope, {
      saleId,
      deviceId: randomUUID(),
      businessDate: day,
      type: 'BANK_TRANSFER',
      providerRef: 'BANK-956',
      amountMinor,
      idempotencyKey: randomUUID(),
    })
  );

suite('DEV-956 whole-bill discount on PostgreSQL', () => {
  beforeAll(async () => {
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
    // The prepaid tier change is audited against a real member.
    await withPlatformDb(async (db) => {
      await db.$executeRaw(Prisma.sql`INSERT INTO organization_departments
        (id, "organizationId", key, name, "updatedAt")
        VALUES (${org + '_department'}, ${org}, 'Owner', 'Owner', now())`);
      await db.$executeRaw(Prisma.sql`INSERT INTO users
        (id, "organizationId", name, email, department, title, role, "updatedAt")
        VALUES (${scope.actorId}, ${org}, 'Cashier', ${scope.actorId + '@bill-discount.test'},
          'Owner', 'Cashier', 'EMPLOYEE', now())`);
    });
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
    await retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
  });

  it('is off by default and refused while off, changing nothing', async () => {
    const f = await bill();
    const before = await lines(f.sale.id);
    await expect(
      tenant((db) =>
        applyBillDiscount(db, scope, {
          saleId: f.sale.id,
          request: { kind: 'AMOUNT', minor: 50 },
          approval,
        })
      )
    ).rejects.toMatchObject({ reason: 'BILL_DISCOUNT_OFF' });
    expect(await lines(f.sale.id)).toEqual(before);
  });

  it('shares the discount exactly over the undiscounted lines and keeps receipt, payment, journal and returns exact', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const f = await bill();
    const outcome = await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 101 },
        approval,
      })
    );
    expect(outcome).toMatchObject({
      status: 'APPLIED',
      totalMinor: 101,
      excluded: [{ saleLineId: f.lineC.id, reason: 'OWN_DISCOUNT' }],
    });
    const after = await lines(f.sale.id);
    const [a, b, c] = after;
    // Largest remainder by price: 101 × 300/633 = 47.87 → 48, 101 × 333/633 = 53.13 → 53.
    expect([a!.billDiscountMinor, b!.billDiscountMinor, c!.billDiscountMinor]).toEqual([48, 53, 0]);
    expect([a!.discountMinor, b!.discountMinor, c!.discountMinor]).toEqual([48, 53, 10]);
    expect(a).toMatchObject({
      discountKind: 'DISCOUNT',
      approvedByUserId: approval.approvedByUserId,
      approvalPolicy: 'MANAGER_PIN',
    });
    // Each lot of line A takes its part by its own room above cost (50 and 150).
    const allocations = await tenant((db) =>
      db.pharmacySaleLineAllocation.findMany({
        where: { saleLineId: a!.id },
        orderBy: { id: 'asc' },
      })
    );
    const snapshot = a!.billAllocationDiscounts as Record<string, number>;
    expect(Object.values(snapshot).reduce((n, v) => n + v, 0)).toBe(48);
    expect(allocations.map((row) => snapshot[row.id])).toEqual(
      allocations.map((row) => (row.grossMinor === 100 ? 12 : 36))
    );
    const event = await tenant((db) =>
      db.pharmacySaleEvent.findFirstOrThrow({ where: { saleId: f.sale.id, kind: 'BILL_DISCOUNT' } })
    );
    expect(event).toMatchObject({ actorId: scope.actorId, reason: 'GIVEN' });
    expect(event.payload).toMatchObject({
      totalMinor: 101,
      givenByUserId: scope.actorId,
      approvedByUserId: approval.approvedByUserId,
      approvalPolicy: 'MANAGER_PIN',
    });

    const cart = await tenant((db) => readCounterCart(db, scope, f.sale.id));
    expect(cart.totals).toMatchObject({ grossMinor: 1133, discountMinor: 111, netMinor: 1022 });
    await tender(f.sale.id, 1022);
    const receipt = await tenant((db) =>
      readCounterReceipt(db, scope, f.sale.id, { name: 'QA', currency: 'PKR' })
    );
    expect(receipt.totals).toMatchObject({ discountMinor: 111, netMinor: 1022 });
    expect(receiptTierLines(receipt, 'en')).toEqual(['Whole-bill discount: -1.01']);
    // The journal discount legs agree with the receipt, lot by lot.
    const discountLegs = await tenant((db) =>
      db.financeJournalLine.findMany({
        where: {
          sourceLineId: { in: after.map((line) => line.id) },
          accountCode: 'SALES_DISCOUNT',
          side: 'DEBIT',
        },
        select: { amountMinor: true, lotId: true },
      })
    );
    expect(discountLegs.reduce((n, leg) => n + leg.amountMinor, 0)).toBe(111);
    expect(discountLegs.find((leg) => leg.lotId === f.lots.b[0]!.id)!.amountMinor).toBe(53);

    // Once paid, the share is frozen: neither the service nor SQL can change it.
    await expect(
      tenant((db) =>
        applyBillDiscount(db, scope, {
          saleId: f.sale.id,
          request: { kind: 'AMOUNT', minor: 0 },
          approval: null,
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    await expect(
      tenant((db) =>
        db.$executeRaw(
          Prisma.sql`UPDATE pharmacy_sale_lines SET "billDiscountMinor" = 0, "discountMinor" = 0,
            "billAllocationDiscounts" = NULL WHERE id = ${b!.id}`
        )
      )
    ).rejects.toThrow(/immutable/);

    // Returning each lot gives back exactly what was paid for it; the whole bill adds up.
    for (const [lineId, lot] of [
      [a!.id, f.lots.a[0]!],
      [a!.id, f.lots.a[1]!],
      [b!.id, f.lots.b[0]!],
      [c!.id, f.lots.c[0]!],
    ] as const)
      await tenant((db) =>
        returnSaleLine(db, scope, {
          saleLineId: lineId,
          lotId: lot.id,
          canonicalUnits: 1,
          disposition: 'RESTOCK',
          reason: 'Return',
          integrityDecision: 'Sealed',
          idempotencyKey: randomUUID(),
        })
      );
    const history = await tenant((db) => readReturnHistory(db, scope, f.sale.id));
    expect(history.refundableMinor).toBe(1022);
    const returned = await tenant((db) =>
      db.pharmacySaleReturnLine.findMany({
        where: { saleLineId: b!.id },
        select: { grossMinor: true, discountMinor: true },
      })
    );
    expect(returned).toEqual([{ grossMinor: 333, discountMinor: 53 }]);
  });

  it('refuses before any payment is taken once a tender exists, and replaces or removes the share while open', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const f = await bill();
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'PERCENT', bps: 1000 },
        approval,
      })
    );
    // 10% of the two undiscounted lines (633) is 63, shared 30 and 33.
    expect((await lines(f.sale.id)).map((line) => line.billDiscountMinor)).toEqual([30, 33, 0]);
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 20 },
        approval,
      })
    );
    expect((await lines(f.sale.id)).map((line) => line.discountMinor)).toEqual([9, 11, 10]);
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 0 },
        approval: null,
      })
    );
    const removed = await lines(f.sale.id);
    expect(removed.map((line) => [line.discountMinor, line.billDiscountMinor])).toEqual([
      [0, 0],
      [0, 0],
      [10, 0],
    ]);
    expect(removed[0]).toMatchObject({
      discountKind: null,
      approvedByUserId: null,
      billAllocationDiscounts: null,
    });
    const events = await tenant((db) =>
      db.pharmacySaleEvent.findMany({
        where: { saleId: f.sale.id, kind: 'BILL_DISCOUNT' },
        orderBy: { occurredAt: 'asc' },
      })
    );
    expect(events.map((row) => row.reason)).toEqual(['GIVEN', 'CHANGED', 'REMOVED']);

    await tender(f.sale.id, 100);
    await expect(
      tenant((db) =>
        applyBillDiscount(db, scope, {
          saleId: f.sale.id,
          request: { kind: 'AMOUNT', minor: 20 },
          approval,
        })
      )
    ).rejects.toMatchObject({ reason: 'BILL_DISCOUNT_AFTER_PAYMENT' });
    expect((await lines(f.sale.id)).map((line) => line.billDiscountMinor)).toEqual([0, 0, 0]);
  });

  it("never takes a lot below its cost or a line past the owner's maximum, and refuses what the bill cannot take", async () => {
    await setEnabled(true);
    await setMaximum(5_000);
    const f = await bill();
    await expect(
      tenant((db) =>
        applyBillDiscount(db, scope, {
          saleId: f.sale.id,
          request: { kind: 'PERCENT', bps: 5_001 },
          approval,
        })
      )
    ).rejects.toMatchObject({ reason: 'DISCOUNT_ABOVE_MAXIMUM' });
    // Room: line A min(150 cap, 50 + 150 above cost) = 150; line B min(166, 233) = 166.
    const refused = await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 317 },
        approval,
      })
    );
    expect(refused).toMatchObject({ status: 'REFUSED', reason: 'ABOVE_LIMIT', capacityMinor: 316 });
    expect((await lines(f.sale.id)).map((line) => line.discountMinor)).toEqual([0, 0, 10]);
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 316 },
        approval,
      })
    );
    const full = await lines(f.sale.id);
    expect(full.map((line) => line.billDiscountMinor)).toEqual([150, 166, 0]);
    // Within line A each lot takes its part by its room above cost (50 and 150): 37.5 and 112.5.
    const snapshot = Object.values(full[0]!.billAllocationDiscounts as Record<string, number>);
    expect(snapshot.sort((x, y) => x - y)).toEqual([38, 112]);

    // The database refuses a snapshot that does not add up or takes a lot below cost.
    await expect(
      tenant((db) =>
        db.$executeRaw(
          Prisma.sql`UPDATE pharmacy_sale_lines SET "billAllocationDiscounts" = '{"no-such-allocation": 166}'::jsonb
            WHERE id = ${full[1]!.id}`
        )
      )
    ).rejects.toThrow(/price floor/);
    const allocation = await tenant((db) =>
      db.pharmacySaleLineAllocation.findFirstOrThrow({ where: { saleLineId: full[1]!.id } })
    );
    await expect(
      tenant((db) =>
        db.$executeRaw(
          Prisma.sql`UPDATE pharmacy_sale_lines SET "billDiscountMinor" = 300, "discountMinor" = 300,
            "billAllocationDiscounts" = ${JSON.stringify({ [allocation.id]: 300 })}::jsonb
            WHERE id = ${full[1]!.id}`
        )
      )
    ).rejects.toThrow(/price floor/);
    await setMaximum(10_000);
  });

  it('lets the prepaid tier price on top at payment, with the bill share counted in every lot floor', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const customerId = await tenant(async (db) => {
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: 'Tier customer' },
      });
      const customer = await db.pharmacyCustomer.create({
        data: { organizationId: org, patientId: patient.id, displayName: 'Tier customer' },
      });
      await publishPrepaidSettings(db, scope, {
        refundable: true,
        tiers: [{ name: 'Bronze', upfrontMinor: 1000, discountBasisPoints: 1000 }],
      });
      await movePrepaid(db, scope, {
        customerId: customer.id,
        kind: 'PAYMENT',
        amountMinor: 5000,
        idempotencyKey: randomUUID(),
      });
      return customer.id;
    });
    const f = await bill();
    await tenant((db) =>
      db.pharmacySale.update({ where: { id: f.sale.id }, data: { customerId } })
    );
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 400 },
        approval,
      })
    );
    const quoted = await tenant((db) => readCounterCart(db, scope, f.sale.id));
    await tender(f.sale.id, quoted.totals.netMinor);
    const paid = await lines(f.sale.id);
    for (const line of paid) {
      expect(line.discountMinor).toBe(
        line.billDiscountMinor + line.tierDiscountMinor + (line.id === f.lineC.id ? 10 : 0)
      );
    }
    // Line A took 190 of the bill discount, which leaves its lots only 10 above cost. The tier
    // asks for 10% of the 110 left (11) and gets 10: the bill share counts in its lot floor.
    expect(paid[0]).toMatchObject({ billDiscountMinor: 190, tierDiscountMinor: 10 });
    expect(paid[1]).toMatchObject({ billDiscountMinor: 210, tierDiscountMinor: 12 });
    expect(paid[2]).toMatchObject({ billDiscountMinor: 0, tierDiscountMinor: 49 });
    expect(quoted.totals.netMinor).toBe(652);
    const sale = await tenant((db) =>
      db.pharmacySale.findFirstOrThrow({ where: { id: f.sale.id } })
    );
    expect(sale.status).toBe('COMPLETED');
  });

  it('DEV-966: a cash-on-delivery bill the rider has collected, with a bill and a tier share, refuses a new item in words and keeps its totals', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const customerId = await tenant(async (db) => {
      const patient = await db.pharmacyPatient.create({
        data: { organizationId: org, displayName: 'Delivery customer' },
      });
      const customer = await db.pharmacyCustomer.create({
        data: { organizationId: org, patientId: patient.id, displayName: 'Delivery customer' },
      });
      await publishPrepaidSettings(db, scope, {
        refundable: true,
        tiers: [{ name: 'Bronze', upfrontMinor: 1000, discountBasisPoints: 1000 }],
      });
      await movePrepaid(db, scope, {
        customerId: customer.id,
        kind: 'PAYMENT',
        amountMinor: 5000,
        idempotencyKey: randomUUID(),
      });
      return customer.id;
    });
    const f = await bill();
    await tenant((db) =>
      db.pharmacySale.update({ where: { id: f.sale.id }, data: { customerId } })
    );
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 400 },
        approval,
      })
    );
    // A cash-on-delivery order out with its rider (the cashier here) for this bill. Orders are
    // visible only to staff holding the orders permission.
    await withPlatformDb(async (db) => {
      await db.$executeRaw(Prisma.sql`INSERT INTO organization_roles
        (id, "organizationId", key, name, "isSystem", "updatedAt")
        VALUES (${org + '_orders'}, ${org}, 'order-staff', 'Order staff', true, now())`);
      await db.$executeRaw(Prisma.sql`INSERT INTO organization_role_permissions
        (id, "organizationId", "organizationRoleId", capability, effect)
        VALUES (${org + '_orders_allow'}, ${org}, ${org + '_orders'}, 'pharmacy:orders', 'ALLOW')`);
      await db.$executeRaw(Prisma.sql`UPDATE users SET "organizationRoleId" = ${org + '_orders'}
        WHERE id = ${scope.actorId} AND "organizationId" = ${org}`);
    });
    const rider = <T>(fn: (db: ScopedDb) => Promise<T>) =>
      withTenantDb(org, fn, { timeout: 30000, userId: scope.actorId });
    const orderId = org + '_cod_' + randomUUID().slice(0, 8);
    await rider((db) =>
      db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_customer_orders
        (id, "organizationId", "branchId", "customerId", "placedByUserId", fulfillment, status,
         "intendedPaymentMethod", "runnerUserId", "reservationExpiresAt", "counterSaleId",
         "outForDeliveryAt", "updatedAt")
        VALUES (${orderId}, ${org}, ${scope.branchId}, ${customerId}, ${scope.actorId}, 'DELIVER',
          'OUT_FOR_DELIVERY', 'CASH', ${scope.actorId}, now() + interval '30 minutes',
          ${f.sale.id}, now(), now())`)
    );
    const quoted = await tenant((db) => readCounterCart(db, scope, f.sale.id));
    expect(quoted.totals.netMinor).toBe(652);
    // The rider collects the cash: that freezes the prepaid tier price on the bill, with no tender.
    await rider((db) =>
      recordDeliveryCommand(db, scope, {
        branchId: scope.branchId,
        orderId,
        action: 'COLLECT',
        amountMinor: 652,
        reference: 'COD-966',
        requestKey: randomUUID(),
      })
    );
    const collected = await lines(f.sale.id);
    expect(collected.map((line) => [line.billDiscountMinor, line.tierDiscountMinor])).toEqual([
      [190, 10],
      [210, 12],
      [0, 49],
    ]);
    const extra = await tenant((db) => item(db, [400], [100]));
    const addOne = () =>
      tenant((db) =>
        addSaleLine(db, scope, {
          saleId: f.sale.id,
          medicineId: extra.medicine.id,
          presentationId: extra.presentation.id,
          packLevelId: extra.pack.id,
          saleUnit: 'UNIT',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 1,
          idempotencyKey: randomUUID(),
        })
      );
    const refusal = await addOne().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PharmacySaleError);
    expect(refusal).toMatchObject({ reason: 'BILL_DISCOUNT_LOCKED_BY_PREPAID_TIER' });
    expect(counterSaleErrorMessage(refusal)).toBe(
      COUNTER_ERROR_MESSAGES.BILL_DISCOUNT_LOCKED_BY_PREPAID_TIER
    );
    // Changing or removing the whole-bill discount is refused the same way.
    for (const request of [
      { kind: 'AMOUNT', minor: 0 },
      { kind: 'AMOUNT', minor: 100 },
    ] as const) {
      await expect(
        tenant((db) =>
          applyBillDiscount(db, scope, {
            saleId: f.sale.id,
            request,
            approval: request.minor ? approval : null,
          })
        )
      ).rejects.toMatchObject({ reason: 'BILL_DISCOUNT_LOCKED_BY_PREPAID_TIER' });
    }
    // Nothing moved: the lines, the bill total the rider collected and the stock are as they were.
    expect(await lines(f.sale.id)).toEqual(collected);
    const after = await tenant((db) => readCounterCart(db, scope, f.sale.id));
    expect(after.totals.netMinor).toBe(652);
    expect(after.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0)).toBe(652);
    expect(
      await tenant((db) =>
        db.pharmacySaleEvent.count({
          where: { saleId: f.sale.id, kind: 'BILL_DISCOUNT', reason: 'CLEARED' },
        })
      )
    ).toBe(0);
    expect(
      await tenant((db) =>
        db.pharmacySaleLineAllocation.count({
          where: { inventoryLotId: { in: extra.lots.map((lot) => lot.id) } },
        })
      )
    ).toBe(0);
  });

  it('clears the discount when an item is added afterwards, and refuses the item once paid', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const f = await bill();
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'PERCENT', bps: 1_000 },
        approval,
      })
    );
    const addOne = () =>
      tenant(async (db) => {
        const extra = await item(db, [400], [100]);
        return addSaleLine(db, scope, {
          saleId: f.sale.id,
          medicineId: extra.medicine.id,
          presentationId: extra.presentation.id,
          packLevelId: extra.pack.id,
          saleUnit: 'UNIT',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 1,
          idempotencyKey: randomUUID(),
        });
      });
    const added = await addOne();
    expect(added).toMatchObject({ billDiscountClearedMinor: 63 });
    const after = await lines(f.sale.id);
    expect(after.map((line) => [line.discountMinor, line.billDiscountMinor])).toEqual([
      [0, 0],
      [0, 0],
      [10, 0],
      [0, 0],
    ]);
    const cleared = await tenant((db) =>
      db.pharmacySaleEvent.findFirstOrThrow({
        where: { saleId: f.sale.id, kind: 'BILL_DISCOUNT', reason: 'CLEARED' },
      })
    );
    expect(cleared.payload).toMatchObject({ cause: 'LINE_ADDED', previousTotalMinor: 63 });
    // Given again, it covers the new item too.
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'PERCENT', bps: 1_000 },
        approval,
      })
    );
    expect((await lines(f.sale.id)).map((line) => line.billDiscountMinor)).toEqual([30, 33, 0, 40]);
    // Once a payment is taken, no item can be added to the discounted bill.
    await tender(f.sale.id, 100);
    await expect(addOne()).rejects.toMatchObject({ reason: 'BILL_DISCOUNT_LOCKED_BY_PAYMENT' });
    expect((await lines(f.sale.id)).map((line) => line.billDiscountMinor)).toEqual([30, 33, 0, 40]);
  });

  it('a line add that waited on the sale lock while a discount was given still clears it', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const f = await bill();
    const extra = await tenant((db) => item(db, [400], [100]));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // The discount takes the sale lock and holds it, uncommitted, while the add starts.
    const discount = tenant(async (db) => {
      await applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 60 },
        approval,
      });
      locked();
      await held;
    });
    await lockTaken;
    const add = tenant((db) =>
      addSaleLine(db, scope, {
        saleId: f.sale.id,
        medicineId: extra.medicine.id,
        presentationId: extra.presentation.id,
        packLevelId: extra.pack.id,
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: randomUUID(),
      })
    );
    // Let the add read the bill (no share yet) and block on the lock, then commit the discount.
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await discount;
    await expect(add).resolves.toMatchObject({ billDiscountClearedMinor: 60 });
    expect((await lines(f.sale.id)).map((line) => line.billDiscountMinor)).toEqual([0, 0, 0, 0]);
  });

  it('voids an unpaid discounted bill and gives its stock back', async () => {
    await setEnabled(true);
    await setMaximum(10_000);
    const f = await bill();
    await tenant((db) =>
      applyBillDiscount(db, scope, {
        saleId: f.sale.id,
        request: { kind: 'AMOUNT', minor: 50 },
        approval,
      })
    );
    await tenant((db) =>
      changeSaleStatus(db, scope, f.sale.id, 'void', { kind: 'COUNTER', actorIsManager: false })
    );
    const balance = await tenant((db) =>
      db.pharmacyStockBalance.findFirstOrThrow({
        where: { inventoryLotId: f.lots.b[0]!.id, disposition: 'AVAILABLE' },
      })
    );
    expect(balance.onHandUnits).toBe(1);
    await expect(
      tenant((db) =>
        applyBillDiscount(db, scope, {
          saleId: f.sale.id,
          request: { kind: 'AMOUNT', minor: 0 },
          approval: null,
        })
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });
});
