/**
 * M6-L3 — purchasing & suppliers domain against real PostgreSQL.
 *
 * Requires TEST_DATABASE_URL (a migrated, disposable, unprivileged/NOBYPASSRLS
 * database) so the RLS-forced tenant scope and the append-only stock ledger are
 * exercised for real. Skipped when it is unavailable. Every quantity/cost
 * assertion is EXACT Decimal string equality — never toBeCloseTo (D07: no float
 * in stock math).
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { listPurchaseOrders } from './purchasing';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const D = (value: string | number) => new Prisma.Decimal(value);
const eq = (actual: Prisma.Decimal | null | undefined, expected: string) =>
  expect((actual ?? D('0')).equals(expected)).toBe(true);

type Purchasing = typeof import('./purchasing');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  purchasing: Purchasing;
};

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha70_${suffix}`;
const orgBId = `org_wha70_b_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  unitEach: `unit_each_${suffix}`,
  unitCase: `unit_case_${suffix}`,
  ingredient: `ingredient_${suffix}`,
  stockItem: `stockitem_${suffix}`,
  location: `location_${suffix}`,
  supplier: `supplier_${suffix}`,
};

let deps: Deps;

/** A fresh APPROVED single-line PO ready to receive. */
async function approvedOrder(input: {
  orderedQuantity: string;
  unitId?: string;
  unitCost?: string;
}): Promise<{ orderId: string; lineId: string }> {
  return deps.withTenantDb(orgId, async (tx) => {
    const created = await deps.purchasing.createPurchaseOrder(tx, {
      supplierId: ids.supplier,
      branchId: ids.branch,
      locationId: ids.location,
      lines: [
        {
          stockItemId: ids.stockItem,
          orderedQuantity: input.orderedQuantity,
          unitId: input.unitId ?? ids.unitEach,
          unitCost: input.unitCost ?? '2.00',
        },
      ],
    });
    await deps.purchasing.submitPurchaseOrder(tx, created.id);
    const approved = await deps.purchasing.approvePurchaseOrder(tx, created.id, {
      approvedByStaffProfileId: null,
    });
    return { orderId: approved.id, lineId: created.lines[0]!.id };
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, purchasing] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./purchasing'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    purchasing,
  };

  await deps.withPlatformDb(async (tx) => {
    for (const [id, slug] of [
      [orgId, `wha70-${suffix}`],
      [orgBId, `wha70-b-${suffix}`],
    ] as const) {
      await tx.organization.create({
        data: {
          id,
          slug,
          legalName: `WHA-70 Test ${id}`,
          displayName: 'WHA-70',
          status: 'ACTIVE',
        },
      });
    }
  });

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: {
        id: ids.branch,
        name: 'Purchasing Branch',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    });
    await tx.restaurantUnit.create({
      data: { id: ids.unitEach, name: 'Each', abbreviation: 'ea' },
    });
    await tx.restaurantUnit.create({
      data: { id: ids.unitCase, name: 'Case', abbreviation: 'cs' },
    });
    // 1 case = 24 each.
    await tx.restaurantUnitConversion.create({
      data: { fromUnitId: ids.unitCase, toUnitId: ids.unitEach, factor: D('24') },
    });
    await tx.restaurantIngredient.create({
      data: { id: ids.ingredient, name: 'Purchasing Ingredient', baseUnitId: ids.unitEach },
    });
    await tx.restaurantStockItem.create({
      data: { id: ids.stockItem, ingredientId: ids.ingredient, canonicalUnitId: ids.unitEach },
    });
    await tx.restaurantStockLocation.create({
      data: { id: ids.location, branchId: ids.branch, name: 'Receiving Bay' },
    });
    await tx.restaurantSupplier.create({
      data: { id: ids.supplier, name: 'Acme Foods' },
    });
  });
}, 60_000);

describeIfDatabase('M6 purchasing — suppliers CRUD', () => {
  it('creates, patches, deactivates, reads and lists suppliers', async () => {
    const created = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.createSupplier(tx, {
        name: 'Fresh Produce Co',
        code: 'FPC',
        contactEmail: 'orders@fpc.test',
      })
    );
    expect(created.name).toBe('Fresh Produce Co');
    expect(created.code).toBe('FPC');
    expect(created.isActive).toBe(true);

    const patched = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.updateSupplier(tx, created.id, { contactName: 'Dana' })
    );
    expect(patched.contactName).toBe('Dana');
    expect(patched.contactEmail).toBe('orders@fpc.test');

    const deactivated = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.setSupplierActive(tx, created.id, false)
    );
    expect(deactivated.isActive).toBe(false);

    const fetched = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getSupplier(tx, created.id)
    );
    expect(fetched.id).toBe(created.id);

    const active = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.listSuppliers(tx, { activeOnly: true })
    );
    expect(active.suppliers.some((s) => s.id === created.id)).toBe(false);
    expect(active.suppliers.some((s) => s.id === ids.supplier)).toBe(true);
  }, 30_000);

  it('throws NOT_FOUND for a missing supplier', async () => {
    await expect(
      deps.withTenantDb(orgId, (tx) => deps.purchasing.getSupplier(tx, `missing_${suffix}`))
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'NOT_FOUND' });
  }, 30_000);
});

describeIfDatabase('M6 purchasing — PO state machine (server-side guards)', () => {
  it('accepts only a finite internal creation instant', async () => {
    const now = new Date('2026-06-01T04:20:00.000Z');
    const created = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.createPurchaseOrder(tx, {
        supplierId: ids.supplier,
        branchId: ids.branch,
        locationId: ids.location,
        now,
      })
    );
    expect(created.createdAt).toEqual(now);

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.purchasing.createPurchaseOrder(tx, {
          supplierId: ids.supplier,
          branchId: ids.branch,
          now: new Date(Number.NaN),
        })
      )
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
  }, 30_000);

  it('walks DRAFT → SUBMITTED → APPROVED and blocks illegal transitions', async () => {
    const created = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.createPurchaseOrder(tx, {
        supplierId: ids.supplier,
        branchId: ids.branch,
        locationId: ids.location,
        lines: [
          {
            stockItemId: ids.stockItem,
            orderedQuantity: '10',
            unitId: ids.unitEach,
            unitCost: '2.00',
          },
        ],
      })
    );
    expect(created.status).toBe('DRAFT');

    // Receiving is illegal until APPROVED.
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.purchasing.receivePurchaseOrder(tx, {
          purchaseOrderId: created.id,
          lines: [{ purchaseOrderLineId: created.lines[0]!.id, receivedQuantity: '1' }],
        })
      )
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID_STATE' });

    const submitted = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.submitPurchaseOrder(tx, created.id)
    );
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submittedAt).not.toBeNull();

    const approved = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.approvePurchaseOrder(tx, created.id)
    );
    expect(approved.status).toBe('APPROVED');

    // Approving again is illegal (no longer SUBMITTED).
    await expect(
      deps.withTenantDb(orgId, (tx) => deps.purchasing.approvePurchaseOrder(tx, created.id))
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID_STATE' });
  }, 30_000);

  it('refuses to submit an order with no lines', async () => {
    const empty = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.createPurchaseOrder(tx, {
        supplierId: ids.supplier,
        branchId: ids.branch,
        locationId: ids.location,
      })
    );
    await expect(
      deps.withTenantDb(orgId, (tx) => deps.purchasing.submitPurchaseOrder(tx, empty.id))
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'EMPTY_ORDER' });
  }, 30_000);

  it('cancels a pre-receipt order and forbids cancelling a received one', async () => {
    const draft = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.createPurchaseOrder(tx, {
        supplierId: ids.supplier,
        branchId: ids.branch,
        locationId: ids.location,
        lines: [
          { stockItemId: ids.stockItem, orderedQuantity: '5', unitId: ids.unitEach, unitCost: '1' },
        ],
      })
    );
    const cancelled = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.cancelPurchaseOrder(tx, draft.id)
    );
    expect(cancelled.status).toBe('CANCELLED');

    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '5' });
    await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '5' }],
      })
    );
    await expect(
      deps.withTenantDb(orgId, (tx) => deps.purchasing.cancelPurchaseOrder(tx, orderId))
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID_STATE' });
  }, 30_000);
});

describeIfDatabase('M6 purchasing — receiving', () => {
  it('posts a PURCHASE_RECEIPT via the L1 primitive and advances to RECEIVED', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10', unitCost: '2.00' });
    const result = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '10', unitCost: '2.00' }],
      })
    );
    expect(result.replayed).toBe(false);
    expect(result.purchaseOrderStatus).toBe('RECEIVED');
    expect(result.movements).toHaveLength(1);
    eq(result.movements[0]!.quantity, '10');
    eq(result.movements[0]!.unitCost, '2');
    expect(result.discrepancyIds).toHaveLength(0);

    // The derived on-hand balance reflects exactly the received quantity.
    const order = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getPurchaseOrder(tx, orderId)
    );
    eq(order.lines[0]!.receivedQuantityCanonical, '10');
    expect(order.lines[0]!.fullyReceived).toBe(true);
  }, 30_000);

  it('receives partially then completes, tracking PARTIALLY_RECEIVED → RECEIVED', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10' });
    const partial = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '4' }],
      })
    );
    expect(partial.purchaseOrderStatus).toBe('PARTIALLY_RECEIVED');

    const complete = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '6' }],
      })
    );
    expect(complete.purchaseOrderStatus).toBe('RECEIVED');

    const order = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getPurchaseOrder(tx, orderId)
    );
    eq(order.lines[0]!.receivedQuantityCanonical, '10');
  }, 30_000);

  it('applies a receiving retry with the same idempotency key EXACTLY once', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10', unitCost: '2.00' });
    const key = `recv_${suffix}_${randomBytes(3).toString('hex')}`;
    const receive = () =>
      deps.withTenantDb(orgId, (tx) =>
        deps.purchasing.receivePurchaseOrder(tx, {
          purchaseOrderId: orderId,
          actor: { idempotencyKey: key },
          lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '10', unitCost: '2.00' }],
        })
      );

    const first = await receive();
    expect(first.replayed).toBe(false);
    const replay = await receive();
    expect(replay.replayed).toBe(true);
    expect(replay.receiptId).toBe(first.receiptId);
    expect(replay.movements.map((m) => m.id).sort()).toEqual(
      first.movements.map((m) => m.id).sort()
    );

    // Exactly one receipt and one movement exist for this order.
    const counts = await deps.withTenantDb(orgId, (tx) =>
      Promise.all([
        tx.restaurantPurchaseReceipt.count({ where: { purchaseOrderId: orderId } }),
        tx.restaurantStockMovement.count({ where: { receiptId: first.receiptId } }),
      ])
    );
    expect(counts).toEqual([1, 1]);
  }, 30_000);

  it('records a price-variance discrepancy when the received cost differs', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10', unitCost: '2.00' });
    const result = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '10', unitCost: '2.50' }],
      })
    );
    expect(result.discrepancyIds).toHaveLength(1);
    const receipt = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getPurchaseReceipt(tx, result.receiptId)
    );
    expect(receipt.discrepancies).toHaveLength(1);
    expect(receipt.discrepancies[0]!.kind).toBe('OTHER');
    expect(receipt.discrepancies[0]!.note).toContain('Price variance');
  }, 30_000);

  it('records an OVERAGE discrepancy when more is received than ordered', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10', unitCost: '2.00' });
    const result = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '12', unitCost: '2.00' }],
      })
    );
    expect(result.purchaseOrderStatus).toBe('RECEIVED');
    const receipt = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getPurchaseReceipt(tx, result.receiptId)
    );
    const overage = receipt.discrepancies.find((d) => d.kind === 'OVERAGE');
    expect(overage).toBeDefined();
    eq(overage!.expectedQuantity, '10');
    eq(overage!.receivedQuantity, '12');
  }, 30_000);

  it('records a caller-supplied shortage discrepancy', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10' });
    const result = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [
          {
            purchaseOrderLineId: lineId,
            receivedQuantity: '8',
            discrepancies: [
              {
                kind: 'SHORTAGE',
                expectedQuantity: '10',
                receivedQuantity: '8',
                note: 'two short',
              },
            ],
          },
        ],
      })
    );
    const receipt = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getPurchaseReceipt(tx, result.receiptId)
    );
    const shortage = receipt.discrepancies.find((d) => d.kind === 'SHORTAGE');
    expect(shortage).toBeDefined();
    expect(shortage!.note).toBe('two short');
  }, 30_000);

  it('records a batch + expiry at receiving without blocking (D07 optional seam)', async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10', unitCost: '2.00' });
    const code = `LOT_${randomBytes(3).toString('hex')}`;
    const result = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [
          {
            purchaseOrderLineId: lineId,
            receivedQuantity: '10',
            unitCost: '2.00',
            batch: { code, expiryDate: new Date('2027-01-01T00:00:00.000Z') },
          },
        ],
      })
    );
    expect(result.movements[0]!.batchId).not.toBeNull();
    const batch = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockBatch.findUnique({
        where: { stockItemId_code: { stockItemId: ids.stockItem, code } },
        select: { id: true, expiryDate: true, receiptId: true },
      })
    );
    expect(batch?.id).toBe(result.movements[0]!.batchId);
    expect(batch?.receiptId).toBe(result.receiptId);
    expect(batch?.expiryDate).not.toBeNull();
  }, 30_000);

  it('receives in a different unit and folds to the canonical unit for status', async () => {
    // Order 2 CASE (= 48 each). Receive 24 each → partial; 24 more each → full.
    const { orderId, lineId } = await approvedOrder({
      orderedQuantity: '2',
      unitId: ids.unitCase,
      unitCost: '48.00',
    });
    const order0 = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.getPurchaseOrder(tx, orderId)
    );
    eq(order0.lines[0]!.orderedQuantityCanonical, '48');

    const partial = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [
          {
            purchaseOrderLineId: lineId,
            receivedQuantity: '24',
            unitId: ids.unitEach,
            unitCost: '2.00',
          },
        ],
      })
    );
    expect(partial.purchaseOrderStatus).toBe('PARTIALLY_RECEIVED');
    eq(partial.movements[0]!.quantity, '24');

    const full = await deps.withTenantDb(orgId, (tx) =>
      deps.purchasing.receivePurchaseOrder(tx, {
        purchaseOrderId: orderId,
        lines: [
          {
            purchaseOrderLineId: lineId,
            receivedQuantity: '24',
            unitId: ids.unitEach,
            unitCost: '2.00',
          },
        ],
      })
    );
    expect(full.purchaseOrderStatus).toBe('RECEIVED');
  }, 30_000);
});

describeIfDatabase('M6 purchasing — supplier returns', () => {
  it('posts a negative SUPPLIER_RETURN and replays idempotently EXACTLY once', async () => {
    const key = `ret_${suffix}_${randomBytes(3).toString('hex')}`;
    const doReturn = () =>
      deps.withTenantDb(orgId, (tx) =>
        deps.purchasing.createSupplierReturn(tx, {
          locationId: ids.location,
          actor: { idempotencyKey: key },
          lines: [{ stockItemId: ids.stockItem, quantity: '3', unitCost: '2.00' }],
        })
      );

    const first = await doReturn();
    expect(first.replayed).toBe(false);
    expect(first.movements).toHaveLength(1);
    eq(first.movements[0]!.quantity, '-3');
    eq(first.movements[0]!.unitCost, '2');

    const replay = await doReturn();
    expect(replay.replayed).toBe(true);
    expect(replay.movements.map((m) => m.id)).toEqual(first.movements.map((m) => m.id));

    const count = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockMovement.count({
        where: { stockItemId: ids.stockItem, locationId: ids.location, reason: 'SUPPLIER_RETURN' },
      })
    );
    expect(count).toBe(1);
  }, 30_000);

  it('rejects a non-positive return quantity', async () => {
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.purchasing.createSupplierReturn(tx, {
          locationId: ids.location,
          lines: [{ stockItemId: ids.stockItem, quantity: '0' }],
        })
      )
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'INVALID' });
  }, 30_000);
});

describe('M6 purchasing — branch scope query', () => {
  it.each([{ branchIds: ['primary', 'assigned'] }, { branchIds: [] }])(
    'applies the authorized branch set before pagination ($branchIds)',
    async ({ branchIds }) => {
      const findMany = vi.fn().mockResolvedValue([]);
      const db = { restaurantPurchaseOrder: { findMany } } as unknown as ScopedDb;

      await listPurchaseOrders(db, { branchIds, branchId: 'other', limit: 2, cursor: 'previous' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            branchId: 'other',
            AND: [{ branchId: { in: branchIds } }],
          }),
          take: 3,
          cursor: { id: 'previous' },
          skip: 1,
        })
      );
    }
  );
});

describeIfDatabase('M6 purchasing — branch-scoped pagination', () => {
  it('fills pages from authorized branches while excluding other branches and empty scopes', async () => {
    await deps.withTenantDb(orgId, async (tx) => {
      const assignedBranch = `branch_list_assigned_${suffix}`;
      const otherBranch = `branch_list_other_${suffix}`;
      await tx.restaurantBranch.createMany({
        data: [
          { id: assignedBranch, name: 'Assigned purchasing branch' },
          { id: otherBranch, name: 'Other purchasing branch' },
        ],
      });
      const supplier = await tx.restaurantSupplier.create({
        data: { name: 'Pagination supplier' },
      });
      const branches = [ids.branch, otherBranch, assignedBranch, otherBranch, ids.branch];
      const orderIds = branches.map((_, index) => `po_list_${index}_${suffix}`);
      await tx.restaurantPurchaseOrder.createMany({
        data: branches.map((branchId, index) => ({
          id: orderIds[index]!,
          branchId,
          supplierId: supplier.id,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        })),
      });

      const input = { branchIds: [ids.branch, assignedBranch], supplierId: supplier.id, limit: 2 };
      const first = await deps.purchasing.listPurchaseOrders(tx, input);
      expect(first.orders.map(({ id }) => id)).toEqual([orderIds[4], orderIds[2]]);
      expect(first.nextCursor).toBe(orderIds[2]);
      const second = await deps.purchasing.listPurchaseOrders(tx, {
        ...input,
        cursor: first.nextCursor!,
      });
      expect(second.orders.map(({ id }) => id)).toEqual([orderIds[0]]);
      expect(second.nextCursor).toBeNull();

      await expect(
        deps.purchasing.listPurchaseOrders(tx, { ...input, branchIds: [] })
      ).resolves.toEqual({ orders: [], nextCursor: null });
      await expect(
        deps.purchasing.listPurchaseOrders(tx, { ...input, branchId: otherBranch })
      ).resolves.toEqual({ orders: [], nextCursor: null });

      const allBranches = await deps.purchasing.listPurchaseOrders(tx, {
        ...input,
        branchIds: [...input.branchIds, otherBranch],
        limit: 10,
      });
      expect(allBranches.orders.map(({ id }) => id)).toEqual([...orderIds].reverse());
    });
  });
});

describeIfDatabase('M6 purchasing — cross-org isolation (RLS)', () => {
  it("hides another org's purchase order and refuses to receive against it", async () => {
    const { orderId, lineId } = await approvedOrder({ orderedQuantity: '10' });

    // Org B cannot read org A's order.
    await expect(
      deps.withTenantDb(orgBId, (tx) => deps.purchasing.getPurchaseOrder(tx, orderId))
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'NOT_FOUND' });

    // Nor receive against it.
    await expect(
      deps.withTenantDb(orgBId, (tx) =>
        deps.purchasing.receivePurchaseOrder(tx, {
          purchaseOrderId: orderId,
          lines: [{ purchaseOrderLineId: lineId, receivedQuantity: '1' }],
        })
      )
    ).rejects.toMatchObject({ name: 'PurchasingError', reason: 'NOT_FOUND' });
  }, 30_000);
});
