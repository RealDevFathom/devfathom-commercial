/**
 * WHA-68 — the BINDING M6 stock-ledger concurrency battery.
 *
 * Requires TEST_DATABASE_URL (a migrated, disposable, unprivileged/NOBYPASSRLS
 * database). Skipped when unavailable.
 *
 * The append-only ledger must balance under concurrency (§11.4 / Phase-4
 * verification): >=8 independent writers each post N movements to ONE
 * (stockItem, location); each writer runs in its OWN tenant-scoped transaction
 * (a separate pooled connection = true parallelism), so this exercises real
 * concurrent INSERTs, not serialized ones. After they all commit the derived
 * balance must equal the EXACT Decimal sum of every posted quantity and the
 * movement count must be EXACT — no lost, duplicated, or phantom rows.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const D = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  postStockMovements: (typeof import('@/lib/restaurant/inventory-ledger'))['postStockMovements'];
  deriveBalance: (typeof import('@/lib/restaurant/inventory-ledger'))['deriveBalance'];
  deriveBalances: (typeof import('@/lib/restaurant/inventory-ledger'))['deriveBalances'];
};

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha68_conc_${suffix}`;
const ids = {
  branch: `branch_conc_${suffix}`,
  unit: `unit_conc_${suffix}`,
  ingredient: `ingredient_conc_${suffix}`,
  stockItem: `stockitem_conc_${suffix}`,
  location: `location_conc_${suffix}`,
};

let deps: Deps;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/inventory-ledger'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    postStockMovements: ledger.postStockMovements,
    deriveBalance: ledger.deriveBalance,
    deriveBalances: ledger.deriveBalances,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha68-conc-${suffix}`,
        legalName: 'WHA-68 Concurrency Test',
        displayName: 'WHA-68 Concurrency',
        status: 'ACTIVE',
      },
    })
  );
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: {
        id: ids.branch,
        name: 'Concurrency Branch',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    });
    await tx.restaurantUnit.create({ data: { id: ids.unit, name: 'Gram', abbreviation: 'g' } });
    await tx.restaurantIngredient.create({
      data: { id: ids.ingredient, name: 'Concurrency Ingredient', baseUnitId: ids.unit },
    });
    await tx.restaurantStockItem.create({
      data: { id: ids.stockItem, ingredientId: ids.ingredient, canonicalUnitId: ids.unit },
    });
    await tx.restaurantStockLocation.create({
      data: { id: ids.location, branchId: ids.branch, name: 'Concurrency Store' },
    });
  });
}, 60_000);

describeIfDatabase('WHA-68 M6 stock-ledger concurrency battery (real DB)', () => {
  it('balances exactly under >=8 parallel writers with signed 6dp quantities', async () => {
    const WRITERS = 8;
    const PER_WRITER = 6;

    // Deterministic, mixed-sign, 6-decimal-place quantities. Every fourth writer
    // CONSUMES (negative), so the ledger carries both signs and the exact sum is
    // non-trivial — a float fold would drift here; an exact Decimal fold cannot.
    const quantityFor = (writer: number, movement: number): Prisma.Decimal => {
      const magnitude = D(
        `${writer + 1}.${String((movement + 1) * 100003)
          .slice(0, 6)
          .padStart(6, '0')}`
      );
      return writer % 4 === 3 ? magnitude.negated() : magnitude;
    };

    const plan: Prisma.Decimal[][] = Array.from({ length: WRITERS }, (_writer, writer) =>
      Array.from({ length: PER_WRITER }, (_movement, movement) => quantityFor(writer, movement))
    );
    const expectedSum = plan
      .flat()
      .reduce<Prisma.Decimal>((total, quantity) => total.plus(quantity), D('0'));

    const results = await Promise.allSettled(
      plan.map((quantities, writer) =>
        deps.withTenantDb(orgId, (tx) =>
          deps.postStockMovements(tx, {
            actor: { idempotencyKey: `conc_${suffix}_${writer}` },
            commandType: 'stock.concurrency',
            movements: quantities.map((quantity) => ({
              stockItemId: ids.stockItem,
              locationId: ids.location,
              reason: quantity.isNegative()
                ? ('RECIPE_CONSUMPTION' as const)
                : ('PURCHASE_RECEIPT' as const),
              quantity,
            })),
          })
        )
      )
    );

    // Every writer committed — no lost transaction.
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toEqual([]);
    const posted = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value.movements : []
    );
    expect(posted).toHaveLength(WRITERS * PER_WRITER);
    expect(results.every((result) => result.status === 'fulfilled' && !result.value.replayed)).toBe(
      true
    );

    // Movement count is EXACT (no duplicated / phantom rows).
    const count = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockMovement.count({
        where: { stockItemId: ids.stockItem, locationId: ids.location },
      })
    );
    expect(count).toBe(WRITERS * PER_WRITER);

    // Derived balance == EXACT Decimal sum of every posted quantity.
    const balance = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalance(tx, ids.stockItem, ids.location)
    );
    expect(balance.equals(expectedSum)).toBe(true);

    // The groupBy fold agrees with the single aggregate.
    const balances = await deps.withTenantDb(orgId, (tx) =>
      deps.deriveBalances(tx, { stockItemIds: [ids.stockItem], locationIds: [ids.location] })
    );
    expect(balances).toHaveLength(1);
    expect(balances[0]!.onHand.equals(expectedSum)).toBe(true);
  }, 90_000);
});
