/** Real service/ledger acceptance. Only the reserved disposable PostgreSQL harness runs this. */
import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import * as ops from './catering-operations';
import { postStockMovements } from './inventory-ledger';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  assertAcceptanceDatabase,
  readAcceptanceReceipt,
} from '../../../scripts/restaurant-acceptance-target';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
// Skipped, never silently passed, without a database; the slot guard below still applies.
const describeIfDatabase = url ? describe : describe.skip;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const id = () => randomUUID();
const org = `catering_runtime_${id()}`;
const foreign = `catering_foreign_${id()}`;
const branch = id(),
  otherBranch = id(),
  staff = id(),
  location = id(),
  otherLocation = id();
const g = id(),
  kg = id(),
  ingredient = id(),
  stock = id(),
  recipe = id(),
  version = id();
const tenant = <T>(fn: (db: ScopedDb) => Promise<T>) => withTenantDb(org, fn);

async function newOrder(start = '2026-11-08T10:00:00Z') {
  return tenant(async (tx) => {
    const order = await tx.restaurantCateringOrder.create({
      data: {
        branchId: branch,
        eventName: 'Catering runtime',
        eventDate: new Date(start),
        headcount: 10,
        quotedTotal: '100',
        depositAmount: '20',
      },
    });
    await tx.restaurantCateringOrderLine.create({
      data: {
        orderId: order.id,
        recipeId: recipe,
        description: 'Rice',
        portions: '20',
        unitPrice: '5',
      },
    });
    await ops.setBooking(tx, org, order.id, {
      bookingStartsAt: new Date(start),
      bookingEndsAt: new Date(new Date(start).getTime() + 3600000),
      fulfillmentMode: 'PICKUP',
      stockLocationId: location,
    });
    const quote = await ops.publishQuote(tx, org, order.id, 'PKR', staff);
    await ops.approveQuote(tx, org, order.id, quote.id, staff);
    await tx.restaurantCateringOrder.update({
      where: { id: order.id },
      data: { status: 'QUOTED' },
    });
    return { order: order.id, quote };
  });
}
async function confirm(order: string) {
  return tenant(async (tx) => {
    await ops.lockBranch(tx, org, branch);
    await ops.lockOrder(tx, order);
    await ops.confirmQuote(tx, org, order, branch);
    await tx.restaurantCateringOrder.update({
      where: { id: order },
      data: { status: 'CONFIRMED' },
    });
  });
}
async function consume(order: string) {
  return tenant(async (tx) => {
    await ops.lockOrder(tx, order);
    await ops.consumeFrozen(tx, org, order, branch, staff);
    await tx.restaurantCateringOrder.update({ where: { id: order }, data: { status: 'READY' } });
  });
}
async function cancel(order: string) {
  return tenant(async (tx) => {
    await ops.lockOrder(tx, order);
    await tx.restaurantCateringOrder.update({
      where: { id: order },
      data: { status: 'CANCELLED' },
    });
  });
}
async function source(order: string) {
  return tenant(async (tx) => {
    const key = await tx.restaurantInventoryIdempotencyKey.findFirstOrThrow({
      where: { key: `catering:${order}:consumption` },
    });
    return tx.restaurantStockMovement.findUniqueOrThrow({ where: { id: key.resultRef! } });
  });
}

describeIfDatabase('catering real service acceptance', () => {
  beforeAll(async () => {
    if (process.env.RESTAURANT_ACCEPTANCE_ADMITTED === '1') {
      assertAcceptanceDatabase(url, readAcceptanceReceipt());
    } else if (
      !url ||
      new URL(url).port !== '55675' ||
      !new URL(url).pathname.includes('disposable')
    ) {
      throw new Error('Reserved disposable slot required');
    }
    await withPlatformDb(async (tx) => {
      const roles = await tx.$queryRaw<
        Array<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
        }>
      >`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
      expect(roles).toEqual([
        { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
      ]);
      for (const oid of [org, foreign])
        await tx.organization.create({
          data: {
            id: oid,
            slug: oid,
            legalName: 'Synthetic catering',
            displayName: 'Synthetic catering',
            status: 'ACTIVE',
          },
        });
    });
    await tenant(async (tx) => {
      for (const b of [branch, otherBranch])
        await tx.restaurantBranch.create({
          data: { id: b, name: 'Kitchen', timezone: 'UTC', businessDayCutoff: '00:00' },
        });
      await tx.restaurantStaffProfile.create({
        data: { id: staff, displayName: 'Synthetic cook', primaryBranchId: branch },
      });
      await tx.restaurantUnit.create({ data: { id: g, name: 'gram' } });
      await tx.restaurantUnit.create({ data: { id: kg, name: 'kilogram' } });
      await tx.restaurantUnitConversion.create({
        data: { fromUnitId: g, toUnitId: kg, factor: '0.001' },
      });
      await tx.restaurantIngredient.create({
        data: { id: ingredient, name: 'Rice', baseUnitId: g, referenceCost: '9' },
      });
      await tx.restaurantStockItem.create({
        data: { id: stock, ingredientId: ingredient, canonicalUnitId: kg },
      });
      await tx.restaurantStockLocation.create({
        data: { id: location, branchId: branch, name: 'Kitchen store' },
      });
      await tx.restaurantStockLocation.create({
        data: { id: otherLocation, branchId: otherBranch, name: 'Other store' },
      });
      const product = await tx.restaurantProduct.create({ data: { name: 'Rice' } });
      await tx.restaurantRecipe.create({
        data: { id: recipe, productId: product.id, name: 'Ten portions' },
      });
      await tx.restaurantRecipeVersion.create({
        data: {
          id: version,
          recipeId: recipe,
          versionNumber: 1,
          status: 'ACTIVE',
          portionCount: 10,
          yieldQuantity: '2',
          yieldUnitId: kg,
        },
      });
      await tx.restaurantRecipeLine.create({
        data: { recipeVersionId: version, ingredientId: ingredient, quantity: '100', unitId: g },
      });
      await postStockMovements(tx, {
        movements: [
          {
            stockItemId: stock,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '10',
            unitCost: '2',
          },
          {
            stockItemId: stock,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '30',
            unitCost: '4',
          },
        ],
      });
      await ops.setCapacity(tx, org, branch, 10);
    });
  });

  it('applies full catering RLS and reports exact catalog constraints for schema parity', async () => {
    await tenant(async (tx) => {
      const tables = await tx.$queryRaw<
        Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname LIKE 'restaurant_catering_%' AND relkind='r'`;
      expect(tables.length).toBe(11);
      for (const t of tables)
        expect([t.relrowsecurity, t.relforcerowsecurity]).toEqual([true, true]);
      const keys =
        await tx.$queryRaw`SELECT conrelid::regclass::text AS tab,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid::regclass::text LIKE 'restaurant_catering_%' ORDER BY 1,2`;
      console.log('CATERING_CONSTRAINT_CATALOG', JSON.stringify(keys));
    });
  });

  it('prefers actual weighted cost over stale reference, scales once and freezes approved history', async () => {
    const f = await newOrder('2026-11-09T10:00:00Z');
    expect(f.quote.snapshot.lines[0]!.recipeVersionId).toBe(version);
    expect(f.quote.snapshot.requirements[0]).toMatchObject({
      baseUnitId: g,
      quantityInBaseUnit: '200',
      unitCost: '0.0035',
      costSource: 'WEIGHTED_AVERAGE',
    });
    expect(ops.snapshotCosts(f.quote.snapshot)).toMatchObject({
      ingredientCost: '0.7',
      costBasis: 'ESTIMATED',
    });
    await confirm(f.order);
    await tenant(async (tx) => {
      await tx.restaurantIngredient.update({
        where: { id: ingredient },
        data: { referenceCost: '999' },
      });
      await postStockMovements(tx, {
        movements: [
          {
            stockItemId: stock,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '10',
            unitCost: '100',
          },
        ],
      });
      const loaded = await ops.frozenQuote(tx, org, f.order);
      expect(loaded).toEqual(f.quote);
      const line = await tx.restaurantCateringOrderLine.findFirstOrThrow({
        where: { orderId: f.order },
      });
      expect(line.costPerPortionSnapshot!.toString()).toBe('0.035');
      const next = await tx.restaurantRecipeVersion.create({
        data: { recipeId: recipe, versionNumber: 2, status: 'DRAFT', portionCount: 2 },
      });
      await tx.restaurantRecipeVersion.update({
        where: { id: version },
        data: { status: 'SUPERSEDED' },
      });
      await tx.restaurantRecipeVersion.update({
        where: { id: next.id },
        data: { status: 'ACTIVE' },
      });
      expect(await ops.frozenQuote(tx, org, f.order)).toEqual(f.quote);
      // Restore active selection for independent cases; persisted approved snapshot stays unchanged.
      await tx.restaurantRecipeVersion.update({
        where: { id: next.id },
        data: { status: 'SUPERSEDED' },
      });
      await tx.restaurantRecipeVersion.update({
        where: { id: version },
        data: { status: 'ACTIVE' },
      });
    });
    await expect(tenant((tx) => ops.invalidateQuote(tx, org, f.order))).rejects.toThrow(
      'cannot be edited'
    );
  });

  it('retains quote history, invalidates stale approval and serializes overlapping confirmations', async () => {
    const a = await newOrder(),
      b = await newOrder();
    await tenant((tx) => ops.invalidateQuote(tx, org, a.order));
    await expect(
      tenant((tx) => ops.approveQuote(tx, org, a.order, a.quote.id, staff))
    ).rejects.toThrow('stale');
    await tenant(async (tx) => {
      const q = await ops.publishQuote(tx, org, a.order, 'PKR', staff);
      await ops.approveQuote(tx, org, a.order, q.id, staff);
      expect(q.revision).toBe(a.quote.revision + 1);
    });
    const result = await Promise.allSettled([confirm(a.order), confirm(b.order)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const history = await tenant(
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM restaurant_catering_quote_revisions WHERE "orderId"=${a.order}`
    );
    expect(history).toHaveLength(2);
  });

  it('consumes base grams into canonical kg once, rolls back late failure, and caps physical dispositions', async () => {
    const f = await newOrder('2026-11-10T10:00:00Z');
    await confirm(f.order);
    await expect(
      tenant(async (tx) => {
        await ops.lockOrder(tx, f.order);
        await ops.consumeFrozen(tx, org, f.order, branch, staff);
        throw new Error('late failure');
      })
    ).rejects.toThrow('late failure');
    expect(
      await tenant((tx) =>
        tx.restaurantInventoryIdempotencyKey.count({
          where: { key: `catering:${f.order}:consumption` },
        })
      )
    ).toBe(0);
    await Promise.all([consume(f.order), consume(f.order)]);
    const movement = await source(f.order);
    expect(movement.quantity.toString()).toBe('-0.2');
    expect(
      await tenant((tx) =>
        tx.restaurantInventoryIdempotencyKey.count({
          where: { key: `catering:${f.order}:consumption` },
        })
      )
    ).toBe(1);
    await cancel(f.order);
    const key = id();
    const dispose = (kind: 'UNUSED_RETURN' | 'WASTE' | 'NO_RETURN', quantity: string, k = id()) =>
      tenant((tx) =>
        ops.recordDisposition(tx, org, f.order, staff, {
          originalMovementId: movement.id,
          kind,
          quantity,
          reason: 'Physical count',
          idempotencyKey: k,
        })
      );
    const before = await tenant((tx) => tx.restaurantStockMovement.count());
    await dispose('WASTE', '0.05');
    await dispose('NO_RETURN', '0.05');
    expect(await tenant((tx) => tx.restaurantStockMovement.count())).toBe(before);
    const results = await Promise.all([
      dispose('UNUSED_RETURN', '0.1', key),
      dispose('UNUSED_RETURN', '0.1', key),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(await tenant((tx) => tx.restaurantStockMovement.count())).toBe(before + 1);
    await expect(dispose('UNUSED_RETURN', '0.01')).rejects.toThrow();
  });

  it('denies cross-tenant reads/inserts, branch stock substitution, foreign actors and immutable updates', async () => {
    const f = await newOrder('2026-11-11T10:00:00Z');
    await expect(
      withTenantDb(foreign, (tx) => ops.quoteById(tx, foreign, f.order, f.quote.id))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      withTenantDb(
        foreign,
        (tx) =>
          tx.$executeRaw`INSERT INTO restaurant_catering_commands ("organizationId","orderId","idempotencyKey","payloadHash",result) VALUES (${org},${f.order},'bad','bad','{}')`
      )
    ).rejects.toThrow();
    await expect(
      tenant((tx) =>
        ops.setBooking(tx, org, f.order, {
          bookingStartsAt: new Date('2026-11-11T10:00:00Z'),
          bookingEndsAt: new Date('2026-11-11T11:00:00Z'),
          fulfillmentMode: 'PICKUP',
          stockLocationId: otherLocation,
        })
      )
    ).rejects.toThrow();
    expect((await tenant((tx) => ops.bookingState(tx, org, f.order))).revision).toBe(
      f.quote.revision
    );
    await expect(
      tenant((tx) => ops.approveQuote(tx, org, f.order, f.quote.id, id()))
    ).rejects.toThrow();
    const affected = await tenant(
      (tx) =>
        tx.$executeRaw`UPDATE restaurant_catering_quote_revisions SET "contentHash"='tampered' WHERE id=${f.quote.id}`
    );
    expect(affected).toBe(0);
    expect(await tenant((tx) => ops.quoteById(tx, org, f.order, f.quote.id))).toEqual(f.quote);
  });
});
