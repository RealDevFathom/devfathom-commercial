import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TerminalContext } from '@/lib/restaurant/terminal-auth';
import type { MoneyCommandArgs } from '@/lib/restaurant/checkout-routes';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { saveRestaurantReceiptLayout } from '@/lib/receipts/restaurant-settings';
import { PrintDocumentSchema } from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import { buildReceiptPreview } from '@/lib/receipts/preview';
import { dispatchReceipt, receiptPrintBody } from './receipt-dispatch';

const database = process.env.TEST_DATABASE_URL;
if (database) process.env.DATABASE_URL = database;
const suffix = randomBytes(6).toString('hex');
const orgA = `wha1355_a_${suffix}`;
const orgB = `wha1355_b_${suffix}`;
const branchA = `wha1355_branch_a_${suffix}`;
const branchOther = `wha1355_branch_other_${suffix}`;
const staff = `wha1355_staff_${suffix}`;
const device = `wha1355_device_${suffix}`;
const product = `wha1355_product_${suffix}`;
const date = new Date('2026-09-05T10:00:00Z');
let tenancy: typeof import('@/lib/tenancy/scoped-db');
let orderNumber = 0;

async function bill(options: { fractionalWithoutLines?: boolean } = {}) {
  return tenancy.withTenantDb(orgA, async (db) => {
    const order = await db.restaurantOrder.create({
      data: {
        branchId: branchA,
        staffProfileId: staff,
        deviceId: device,
        orderNumber: ++orderNumber,
        businessDate: date,
        channel: 'DINE_IN',
        status: 'SERVED',
      },
    });
    const item = await db.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        productId: product,
        name: 'Meal',
        quantity: 2,
        unitPrice: '12',
        status: 'SERVED',
      },
    });
    return db.restaurantBill.create({
      data: {
        orderId: order.id,
        branchId: branchA,
        openerStaffProfileId: staff,
        deviceId: device,
        businessDate: date,
        status: 'SETTLED',
        receiptNumber: orderNumber,
        settledAt: date,
        subtotal: '24',
        taxTotal: '2',
        serviceChargeTotal: '1',
        deliveryFeeTotal: '3',
        compTotal: '4',
        discountTotal: '0.50',
        roundingAdjustment: '0.05',
        grandTotal: '25.55',
        splitKind: options.fractionalWithoutLines ? 'FRACTIONAL' : 'NONE',
        fractionNumerator: options.fractionalWithoutLines ? 1 : null,
        fractionDenominator: options.fractionalWithoutLines ? 3 : null,
        lines: options.fractionalWithoutLines
          ? undefined
          : {
              create: {
                orderItemId: item.id,
                name: 'Meal',
                quantity: 2,
                unitPrice: '12',
                lineSubtotal: '24',
                compAmount: '4',
                taxAmount: '2',
                serviceChargeAmount: '1',
                lineTotal: '20',
              },
            },
        tenders: {
          create: {
            type: 'CASH',
            amount: '25.55',
            tipAmount: '1.50',
            cashReceived: '30',
            changeGiven: '4.45',
            staffProfileId: staff,
            deviceId: device,
            businessDate: date,
          },
        },
      },
    });
  });
}

function args(
  db: TerminalContext['db'],
  billId: string,
  branchId = branchA,
  organizationId = orgA
): MoneyCommandArgs<typeof receiptPrintBody> {
  return {
    ctx: {
      db,
      organizationId,
      device: { id: device, name: 'Counter', kind: 'POS', branchId },
    } as TerminalContext,
    data: { billId, action: 'print' },
    actor: { staffProfileId: staff, deviceId: device, idempotencyKey: `dispatch-${billId}` },
    now: date,
  };
}

// Requires a NEW disposable migrated database. Fixtures remain only until its owner drops it;
// do not bypass append-only event rules to clean up rows or run against an existing test DB.
describe.skipIf(!database)('receipt caller snapshots with enforcing RLS', () => {
  beforeAll(async () => {
    tenancy = await import('@/lib/tenancy/scoped-db');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(tenancy.withPlatformDb);
    await tenancy.withPlatformDb((db) =>
      db.organization.createMany({
        data: [orgA, orgB].map((id) => ({ id, slug: id, legalName: id, displayName: id })),
      })
    );
    await tenancy.withTenantDb(orgA, async (db) => {
      await db.restaurantBranch.createMany({
        data: [branchA, branchOther].map((id) => ({ id, name: id, organizationId: orgA })),
      });
      await db.restaurantStaffProfile.create({
        data: { id: staff, displayName: 'Operator', primaryBranchId: branchA },
      });
      await db.restaurantRegisteredDevice.create({
        data: {
          id: device,
          branchId: branchA,
          name: 'Counter',
          deviceSecretHash: `synthetic-${suffix}`,
        },
      });
      await db.restaurantProduct.create({ data: { id: product, name: 'Meal' } });
      await db.restaurantPrintRoute.create({
        data: {
          branchId: branchA,
          documentType: 'RECEIPT',
          stationId: null,
          printerId: 'queue:///Synthetic',
          enabled: true,
        },
      });
    });
  });

  it('uses persisted settings for new jobs and immutable layout/facts for replay and browser bytes', async () => {
    const first = await bill();
    const layout = {
      ...DEFAULT_RECEIPT_LAYOUT,
      paperWidth: 58 as const,
      headerText: 'Captured header',
    };
    await tenancy.withTenantDb(orgA, (db) =>
      saveRestaurantReceiptLayout(db, orgA, { branchId: branchA, revision: 0, layout })
    );
    await tenancy.withTenantDb(orgA, (db) => dispatchReceipt(args(db, first.id)));
    const stored = await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintJob.findFirstOrThrow({ where: { branchId: branchA } })
    );
    const document = PrintDocumentSchema.parse(stored.document);
    const snapshot = document.receiptSnapshot!;
    expect(snapshot.layout).toEqual(layout);
    expect(snapshot.facts.totals).toContain('Discount 0.50');
    expect(snapshot.facts.payments).toEqual([
      'CASH 25.55 / Tip 1.50 / Change 4.45 / Cash received 30.00',
    ]);
    const changed = { ...layout, paperWidth: 80 as const, headerText: 'Next receipt header' };
    await tenancy.withTenantDb(orgA, (db) =>
      saveRestaurantReceiptLayout(db, orgA, { branchId: branchA, revision: 1, layout: changed })
    );
    const replay = await tenancy.withTenantDb(orgA, (db) => dispatchReceipt(args(db, first.id)));
    expect(replay).toMatchObject({
      replayed: true,
      preview: {
        source: 'queued',
        paperWidth: 58,
        text: buildReceiptPreview(layout, snapshot.facts),
      },
    });
    expect(
      Buffer.from(renderEscPos(document)).includes(
        Buffer.from(buildReceiptPreview(layout, snapshot.facts))
      )
    ).toBe(true);
    const persisted = await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintJob.findUniqueOrThrow({ where: { id: stored.id } })
    );
    expect(persisted.document).toEqual(stored.document);
    const second = await bill();
    const result = await tenancy.withTenantDb(orgA, (db) => dispatchReceipt(args(db, second.id)));
    expect(result).toMatchObject({
      preview: {
        source: 'queued',
        paperWidth: 80,
        text: expect.stringContaining('Next receipt header'),
      },
    });
  });

  it('loads a settled line-less fractional split from storage into the printer contract', async () => {
    const fractional = await bill({ fractionalWithoutLines: true });
    const persistedLineCount = await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantBillLine.count({ where: { billId: fractional.id } })
    );
    expect(persistedLineCount).toBe(0);

    const result = await tenancy.withTenantDb(orgA, (db) =>
      dispatchReceipt(args(db, fractional.id))
    );
    if (result instanceof Response || !result.latestJob) throw new Error('Expected queued receipt');
    expect(result).toMatchObject({ outcome: 'QUEUED', replayed: false });
    const jobId = result.latestJob.id;

    const stored = await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantPrintJob.findUniqueOrThrow({ where: { id: jobId } })
    );
    const facts = PrintDocumentSchema.parse(stored.document).receiptSnapshot!.facts;
    expect(facts.lines).toEqual(['Fractional share 1/3: 25.55']);
    expect(facts.totals).toContain('Split FRACTIONAL 1/3');
  });

  it('denies foreign tenant and sibling branch dispatch before enqueue', async () => {
    const receipt = await bill();
    const foreign = await tenancy.withTenantDb(orgB, (db) =>
      dispatchReceipt(args(db, receipt.id, branchA, orgA))
    );
    const sibling = await tenancy.withTenantDb(orgA, (db) =>
      dispatchReceipt(args(db, receipt.id, branchOther))
    );
    expect(foreign).toBeInstanceOf(Response);
    expect((foreign as Response).status).toBe(404);
    expect((sibling as Response).status).toBe(404);
    expect(await tenancy.withTenantDb(orgB, (db) => db.restaurantPrintJob.count())).toBe(0);
  });

  it('concurrent original requests persist one job, event and outbox record', async () => {
    const receipt = await bill();
    const run = () => tenancy.withTenantDb(orgA, (db) => dispatchReceipt(args(db, receipt.id)));
    const results = await Promise.all([run(), run()]);
    expect(
      results.filter((result) => !(result instanceof Response) && result.replayed)
    ).toHaveLength(1);
    const evidence = await tenancy.withTenantDb(orgA, async (db) => ({
      events: await db.restaurantOrderEvent.count({
        where: { orderId: receipt.orderId, eventType: 'receipt.print_requested' },
      }),
      outbox: await db.restaurantEventOutbox.count({
        where: { aggregateId: receipt.orderId, eventType: 'receipt.print_requested' },
      }),
    }));
    expect(evidence).toEqual({ events: 1, outbox: 1 });
  });

  it('rejects Unicode and invalid raw receipts before any job/event, then admits later ASCII work', async () => {
    const receipt = await bill();
    const before = await tenancy.withTenantDb(orgA, (db) => db.restaurantPrintJob.count());
    for (const [name, code, fallback] of [
      ['اردو e\u0301 𐐀 👩‍🍳', 'UNSUPPORTED_PRINT_TEXT', 'BROWSER_OS'],
      ['bad\u001bname', 'INVALID_PRINT_DOCUMENT', null],
    ] as const) {
      await tenancy.withTenantDb(orgA, (db) =>
        db.restaurantBillLine.updateMany({ where: { billId: receipt.id }, data: { name } })
      );
      const result = await tenancy.withTenantDb(orgA, (db) =>
        dispatchReceipt(args(db, receipt.id))
      );
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(422);
      expect(await (result as Response).json()).toMatchObject({ code, fallback });
      const evidence = await tenancy.withTenantDb(orgA, async (db) => ({
        jobs: await db.restaurantPrintJob.count(),
        events: await db.restaurantOrderEvent.count({ where: { orderId: receipt.orderId } }),
        outbox: await db.restaurantEventOutbox.count({ where: { aggregateId: receipt.orderId } }),
      }));
      expect(evidence).toEqual({ jobs: before, events: 0, outbox: 0 });
    }
    await tenancy.withTenantDb(orgA, (db) =>
      db.restaurantBillLine.updateMany({ where: { billId: receipt.id }, data: { name: 'Meal' } })
    );
    const later = await tenancy.withTenantDb(orgA, (db) => dispatchReceipt(args(db, receipt.id)));
    expect(later).toMatchObject({ outcome: 'QUEUED', replayed: false });
  });

  it('rolls queue, event and outbox back together when the owning transaction fails', async () => {
    const receipt = await bill();
    let jobId = '';
    await expect(
      tenancy.withTenantDb(orgA, async (db) => {
        const result = await dispatchReceipt(args(db, receipt.id));
        if (result instanceof Response || !result.latestJob)
          throw new Error('Expected queued receipt');
        jobId = result.latestJob.id;
        throw new Error('Forced rollback');
      })
    ).rejects.toThrow('Forced rollback');
    const evidence = await tenancy.withTenantDb(orgA, async (db) => ({
      job: await db.restaurantPrintJob.findUnique({ where: { id: jobId } }),
      events: await db.restaurantOrderEvent.count({ where: { orderId: receipt.orderId } }),
      outbox: await db.restaurantEventOutbox.count({ where: { aggregateId: receipt.orderId } }),
    }));
    expect(evidence).toEqual({ job: null, events: 0, outbox: 0 });
  });
});
