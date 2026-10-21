/**
 * M6-L1 — inventory ledger primitive against real PostgreSQL.
 *
 * Requires TEST_DATABASE_URL (a migrated, disposable, unprivileged/NOBYPASSRLS
 * database). Skipped when it is unavailable. Every quantity assertion is EXACT
 * Decimal string equality — never toBeCloseTo (D07: no float in stock math).
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const D = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value);
const eq = (actual: Prisma.Decimal | null | undefined, expected: string) =>
  expect((actual ?? D('0')).equals(expected)).toBe(true);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  postStockMovements: (typeof import('./inventory-ledger'))['postStockMovements'];
  deriveBalances: (typeof import('./inventory-ledger'))['deriveBalances'];
  deriveBalance: (typeof import('./inventory-ledger'))['deriveBalance'];
  StockLedgerError: (typeof import('./inventory-ledger'))['StockLedgerError'];
};

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha68_ledger_${suffix}`;
const ids = {
  branch: `branch_led_${suffix}`,
  unitEach: `unit_each_${suffix}`,
  unitCase: `unit_case_${suffix}`,
  ingredient: `ingredient_led_${suffix}`,
  stockItem: `stockitem_led_${suffix}`,
  location: `location_led_${suffix}`,
  location2: `location2_led_${suffix}`,
};

let deps: Deps;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./inventory-ledger'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    postStockMovements: ledger.postStockMovements,
    deriveBalances: ledger.deriveBalances,
    deriveBalance: ledger.deriveBalance,
    StockLedgerError: ledger.StockLedgerError,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha68-ledger-${suffix}`,
        legalName: 'WHA-68 Ledger Test',
        displayName: 'WHA-68 Ledger',
        status: 'ACTIVE',
      },
    })
  );
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Ledger Branch', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantUnit.create({
      data: { id: ids.unitEach, name: 'Each', abbreviation: 'ea' },
    });
    await tx.restaurantUnit.create({
      data: { id: ids.unitCase, name: 'Case', abbreviation: 'cs' },
    });
    // 1 case = 24 each (factor stored as "1 fromUnit = factor toUnit").
    await tx.restaurantUnitConversion.create({
      data: { fromUnitId: ids.unitCase, toUnitId: ids.unitEach, factor: D('24') },
    });
    await tx.restaurantIngredient.create({
      data: { id: ids.ingredient, name: 'Ledger Ingredient', baseUnitId: ids.unitEach },
    });
    await tx.restaurantStockItem.create({
      data: { id: ids.stockItem, ingredientId: ids.ingredient, canonicalUnitId: ids.unitEach },
    });
    await tx.restaurantStockLocation.create({
      data: { id: ids.location, branchId: ids.branch, name: 'Dry Store' },
    });
    await tx.restaurantStockLocation.create({
      data: { id: ids.location2, branchId: ids.branch, name: 'Walk-in' },
    });
  });
}, 60_000);

describeIfDatabase('M6 inventory ledger primitive (real PostgreSQL)', () => {
  it('folds a mix of signed movements into the exact derived balance', async () => {
    const posted = await deps.withTenantDb(orgId, (tx) =>
      deps.postStockMovements(tx, {
        movements: [
          {
            stockItemId: ids.stockItem,
            locationId: ids.location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '10.500000',
            unitCost: '2.000000',
          },
          {
            stockItemId: ids.stockItem,
            locationId: ids.location,
            reason: 'RECIPE_CONSUMPTION',
            quantity: '-3.250000',
          },
          {
            stockItemId: ids.stockItem,
            locationId: ids.location,
            reason: 'WASTAGE',
            quantity: '-0.125000',
          },
        ],
      })
    );
    expect(posted.replayed).toBe(false);
    expect(posted.movements).toHaveLength(3);

    // 10.5 - 3.25 - 0.125 = 7.125000 (exact).
    const balance = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalance(tx, ids.stockItem, ids.location)
    );
    eq(balance, '7.125000');

    const balances = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalances(tx, { stockItemIds: [ids.stockItem], locationIds: [ids.location] })
    );
    expect(balances).toHaveLength(1);
    eq(balances[0]!.onHand, '7.125000');
  }, 30_000);

  it('permits and surfaces a negative derived balance without blocking the post (D07)', async () => {
    // location2 starts empty; consume below zero. Posting never throws.
    const posted = await deps.withTenantDb(orgId, (tx) =>
      deps.postStockMovements(tx, {
        movements: [
          {
            stockItemId: ids.stockItem,
            locationId: ids.location2,
            reason: 'RECIPE_CONSUMPTION',
            quantity: '-5.000000',
          },
        ],
      })
    );
    expect(posted.movements).toHaveLength(1);
    const balance = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalance(tx, ids.stockItem, ids.location2)
    );
    eq(balance, '-5.000000');
    expect(balance.isNegative()).toBe(true);
  }, 30_000);

  it('converts an input unit to the canonical unit for quantity and (inversely) unit cost', async () => {
    const conversionLocation = `loc_conv_${suffix}`;
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockLocation.create({
        data: { id: conversionLocation, branchId: ids.branch, name: 'Conversion Bay' },
      })
    );
    const posted = await deps.withTenantDb(orgId, (tx) =>
      deps.postStockMovements(tx, {
        // 2 CASE @ 24.00/CASE, canonical unit is EACH (1 case = 24 each).
        movements: [
          {
            stockItemId: ids.stockItem,
            locationId: conversionLocation,
            reason: 'PURCHASE_RECEIPT',
            quantity: '2',
            unitId: ids.unitCase,
            unitCost: '24.00',
          },
        ],
      })
    );
    // 2 case -> 48 each; 24.00/case -> 1.00/each (total cost 48.00 invariant).
    eq(posted.movements[0]!.quantity, '48.000000');
    eq(posted.movements[0]!.unitCost, '1');
    const balance = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalance(tx, ids.stockItem, conversionLocation)
    );
    eq(balance, '48.000000');
  }, 30_000);

  it('replays an idempotent post without creating duplicate movements', async () => {
    const idempotencyKey = `idem_${suffix}_${randomBytes(3).toString('hex')}`;
    const location = `loc_idem_${suffix}`;
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockLocation.create({
        data: { id: location, branchId: ids.branch, name: 'Idem Bay' },
      })
    );
    const first = await deps.withTenantDb(orgId, (tx) =>
      deps.postStockMovements(tx, {
        actor: { idempotencyKey },
        commandType: 'stock.receive',
        movements: [
          {
            stockItemId: ids.stockItem,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '4.000000',
            unitCost: '1.000000',
          },
          {
            stockItemId: ids.stockItem,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '6.000000',
            unitCost: '1.000000',
          },
        ],
      })
    );
    expect(first.replayed).toBe(false);
    expect(first.movements).toHaveLength(2);

    const replay = await deps.withTenantDb(orgId, (tx) =>
      deps.postStockMovements(tx, {
        actor: { idempotencyKey },
        commandType: 'stock.receive',
        movements: [
          {
            stockItemId: ids.stockItem,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '4.000000',
            unitCost: '1.000000',
          },
          {
            stockItemId: ids.stockItem,
            locationId: location,
            reason: 'PURCHASE_RECEIPT',
            quantity: '6.000000',
            unitCost: '1.000000',
          },
        ],
      })
    );
    expect(replay.replayed).toBe(true);
    expect(replay.movements.map((movement) => movement.id).sort()).toEqual(
      first.movements.map((movement) => movement.id).sort()
    );

    const count = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockMovement.count({
        where: { stockItemId: ids.stockItem, locationId: location },
      })
    );
    expect(count).toBe(2);
    const balance = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalance(tx, ids.stockItem, location)
    );
    eq(balance, '10.000000');
  }, 30_000);

  it('rejects an unknown stock item and a missing unit conversion', async () => {
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.postStockMovements(tx, {
          movements: [
            {
              stockItemId: `missing_${suffix}`,
              locationId: ids.location,
              reason: 'MANUAL_CORRECTION',
              quantity: '1',
            },
          ],
        })
      )
    ).rejects.toMatchObject({ name: 'StockLedgerError', reason: 'STOCK_ITEM_NOT_FOUND' });

    const gram = `unit_gram_${suffix}`;
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantUnit.create({ data: { id: gram, name: 'Gram', abbreviation: 'g' } })
    );
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.postStockMovements(tx, {
          // No CASE-less path: grams -> each has no conversion row.
          movements: [
            {
              stockItemId: ids.stockItem,
              locationId: ids.location,
              reason: 'PURCHASE_RECEIPT',
              quantity: '100',
              unitId: gram,
            },
          ],
        })
      )
    ).rejects.toMatchObject({ name: 'StockLedgerError', reason: 'NO_UNIT_CONVERSION' });
  }, 30_000);
});
