import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  ledgerCurrencies,
  perpetualValuation,
  postedInventoryValue,
  unallocatedInventoryValue,
} from './finance-reports';
import { priceFromLot } from './medicine';
import { normalizeExpiryBoundary } from './stock-ledger';

type Scope = { organizationId: string; branchIds: readonly string[] };
export const VALUATION_EXPIRY_DAYS = [30, 60, 90] as const;
export const STOCK_VALUE_PAGE_SIZE = 20;
const day = 86_400_000;
const valuationAccounts = ['INVENTORY', 'INVENTORY_IN_TRANSIT'] as const;

function currentPositions({ organizationId, branchIds }: Scope, at: Date, withMoney = false) {
  const branches = Prisma.join(branchIds);
  // Finance attributes transit to the destination. Do not also count the source's transit
  // balance. Use open transfer quantities, including stock that had no journal cost.
  return Prisma.sql`
    WITH positions AS (
      SELECT b."branchId", b."inventoryLotId" AS "lotId", b."disposition"::text AS "disposition",
             b."onHandUnits" AS units, b."sealedPacks" AS sealed
        FROM "pharmacy_stock_balances" b
       WHERE b."organizationId" = ${organizationId}
         AND b."branchId" IN (${branches}) AND b."onHandUnits" > 0
         AND b."disposition" IN ('AVAILABLE', 'QUARANTINE', 'DAMAGED')
      UNION ALL
      SELECT t."toBranchId", l."sourceLotId", 'IN_TRANSIT', l."quantityUnits" - l."receivedUnits", 0
        FROM "pharmacy_interbranch_transfers" t
        JOIN "pharmacy_interbranch_transfer_lines" l
          ON l."organizationId" = t."organizationId" AND l."transferId" = t.id
       WHERE t."organizationId" = ${organizationId} AND t."toBranchId" IN (${branches})
         AND t."status" IN ('DISPATCHED', 'PARTIALLY_RECEIVED') AND t."dispatchedAt" <= ${at}
         AND l."quantityUnits" > l."receivedUnits"
    ),
    lots AS (
      SELECT p."branchId", p."lotId", p."disposition", p.units, p.sealed,
             batch."medicineId"
             ${
               withMoney
                 ? Prisma.sql`,
             lot."unitCostMinor", lot."printedMrpMinor", lot."unitsPerPack", lot."packLevelId",
             batch."expiresAt", batch."state", batch."batchNumber"`
                 : Prisma.empty
             }
        FROM positions p
        JOIN "pharmacy_inventory_lots" lot
          ON lot."organizationId" = ${organizationId} AND lot.id = p."lotId"
        JOIN "pharmacy_manufacturing_batches" batch
          ON batch."organizationId" = lot."organizationId" AND batch.id = lot."manufacturingBatchId"
       WHERE lot."receivedAt" <= ${at}
    )`;
}

export async function countInventoryProducts(db: ScopedDb, scope: Scope, at: Date) {
  if (!scope.branchIds.length) return 0;
  const [result] = await db.$queryRaw<{ productCount: bigint }[]>(Prisma.sql`
    ${currentPositions(scope, at)}
    SELECT COUNT(DISTINCT "medicineId")::bigint AS "productCount" FROM lots`);
  return Number(result?.productCount ?? BigInt(0));
}

type Position = {
  branchId: string;
  lotId: string;
  medicineId: string;
  name: string;
  family: string;
  category: string | null;
  expiresAt: Date | null;
  unitCostMinor: number;
  printedMrpMinor: number;
  unitsPerPack: number;
  roundingIncrement: number;
  transit: boolean;
  units: bigint;
  held: bigint;
  sealed: bigint;
};

function readPositions(db: ScopedDb, scope: Scope, at: Date) {
  return db.$queryRaw<Position[]>(Prisma.sql`
    ${currentPositions(scope, at, true)}
    SELECT lot."branchId", lot."lotId", lot."medicineId", product."productName" AS name,
           product."productFamily"::text AS family, product."retailCategory" AS category,
           lot."expiresAt", lot."unitCostMinor", lot."printedMrpMinor", lot."unitsPerPack",
           COALESCE(mrp."roundingIncrementMinor", 1) AS "roundingIncrement",
           lot."disposition" = 'IN_TRANSIT' AS transit,
           SUM(lot.units)::bigint AS units,
           COALESCE(SUM(lot.units) FILTER (
             WHERE lot."disposition" IN ('QUARANTINE', 'DAMAGED', 'IN_TRANSIT')
                OR lot."state" <> 'ACTIVE'
           ), 0)::bigint AS held,
           SUM(lot.sealed)::bigint AS sealed
      FROM lots lot
      JOIN "pharmacy_medicines" product
        ON product."organizationId" = ${scope.organizationId} AND product.id = lot."medicineId"
      LEFT JOIN "pharmacy_medicine_pack_mrps" mrp
        ON mrp."organizationId" = product."organizationId"
       AND mrp."packLevelId" = lot."packLevelId" AND mrp."batchReference" = lot."batchNumber"
     GROUP BY lot."branchId", lot."lotId", lot."medicineId", product."productName",
              product."productFamily", product."retailCategory", lot."expiresAt", lot."unitCostMinor",
              lot."printedMrpMinor", lot."unitsPerPack", mrp."roundingIncrementMinor",
              lot."disposition" = 'IN_TRANSIT'`);
}

const familyNames: Record<string, string> = {
  PHARMACEUTICAL: 'Medicines',
  BIOLOGICAL: 'Biologic medicines',
  DEVICE: 'Medical devices',
  ALTERNATIVE: 'Alternative remedies',
  FRONT_SHOP: 'Shop products',
};

const positionKey = (branch: string | null, lot: string, transit: boolean) =>
  JSON.stringify([branch, lot, transit]);

function sellingValue(position: Position): bigint | null {
  const { printedMrpMinor, unitsPerPack, roundingIncrement, units, sealed, transit } = position;
  if (printedMrpMinor <= 0) return null;
  const packs = transit ? units / BigInt(unitsPerPack) : sealed;
  const loose = units - packs * BigInt(unitsPerPack);
  const loosePrice = priceFromLot({
    printedMrpMinor,
    canonicalUnitsInPack: unitsPerPack,
    canonicalUnitsPerSaleUnit: 1,
    roundingIncrementMinor: roundingIncrement,
  }).unitPriceMinor;
  return packs * BigInt(printedMrpMinor) + loose * BigInt(loosePrice);
}

export type StockValueRow = { id: string; name: string; costMinor: bigint };

function rank(rows: Iterable<StockValueRow>) {
  return [...rows].sort(
    (a, b) =>
      (a.costMinor > b.costMinor ? -1 : a.costMinor < b.costMinor ? 1 : 0) ||
      a.name.localeCompare(b.name, 'en-PK') ||
      a.id.localeCompare(b.id)
  );
}

export async function currentInventoryValuation(
  db: ScopedDb,
  scope: Scope,
  at: Date,
  { currencySetting, missingPage }: { currencySetting?: string | null; missingPage: number }
) {
  const [rows, unallocatedMinor, currencies, positions] = await Promise.all([
    perpetualValuation(db, scope, at, { splitTransit: true }),
    unallocatedInventoryValue(db, scope, at),
    ledgerCurrencies(db, scope, { accountCodes: valuationAccounts, to: at, inclusive: true }),
    readPositions(db, scope, at),
  ]);
  const posted = new Map<string, { amount: bigint; transit: boolean }>();
  for (const row of rows) {
    const transit = row.inTransitValueMinor ?? BigInt(0);
    const values = [
      [false, BigInt(row.valueMinor) - transit],
      [true, transit],
    ] as const;
    for (const [inTransit, value] of values) {
      if (value === BigInt(0)) continue;
      const key = positionKey(row.branchId, row.lotId, inTransit);
      posted.set(key, {
        amount: (posted.get(key)?.amount ?? BigInt(0)) + value,
        transit: inTransit,
      });
    }
  }

  const products = new Set<string>();
  const missingCost = new Map<string, string>();
  const unposted = new Set<string>();
  const missingPrice = new Set<string>();
  const productValue = new Map<string, StockValueRow>();
  const categoryValue = new Map<string, StockValueRow>();
  const expiringMinor = [BigInt(0), BigInt(0), BigInt(0)];
  let expiredMinor = BigInt(0);
  let heldMinor = BigInt(0);
  let sellingMinor = BigInt(0);
  let mappedMinor = BigInt(0);

  for (const position of positions) {
    const { branchId, lotId, medicineId, name, expiresAt, units, held, transit } = position;
    products.add(medicineId);
    const key = positionKey(branchId, lotId, transit);
    const cost = posted.get(key)?.amount ?? BigInt(0);
    posted.delete(key);
    if (position.unitCostMinor <= 0) missingCost.set(medicineId, name);
    else if (cost <= BigInt(0)) unposted.add(medicineId);
    const selling = sellingValue(position);
    if (selling === null) missingPrice.add(medicineId);
    else sellingMinor += selling;

    if (cost === BigInt(0)) continue;
    const remaining = expiresAt
      ? normalizeExpiryBoundary(expiresAt).getTime() - at.getTime()
      : null;
    if (remaining !== null) {
      if (remaining <= 0) expiredMinor += cost;
      else
        VALUATION_EXPIRY_DAYS.forEach((days, i) => {
          if (remaining <= days * day) expiringMinor[i]! += cost;
        });
    }
    // Ledger locations may predate a physical move. Prorate the lot's posted cost only
    // within the same branch and lot, keeping transit at the exact separate ledger amount.
    heldMinor += (cost * held) / units;
    mappedMinor += cost;

    const category = position.category?.trim() || familyNames[position.family] || 'Other products';
    for (const [map, id, rowName] of [
      [productValue, medicineId, name],
      [categoryValue, category, category],
    ] as const) {
      map.set(id, { id, name: rowName, costMinor: (map.get(id)?.costMinor ?? BigInt(0)) + cost });
    }
  }

  // A transit posting is itself evidence the value is held, even if physical counts cannot
  // match it to an open transfer. It is not assigned to an expiry or product breakdown.
  for (const row of posted.values()) if (row.transit) heldMinor += row.amount;
  const costMinor = postedInventoryValue(rows, unallocatedMinor);
  const missing = [...missingCost].map(([id, name]) => ({ id, name }));
  missing.sort((a, b) => a.name.localeCompare(b.name, 'en-PK') || a.id.localeCompare(b.id));
  const lastPage = Math.max(1, Math.ceil(missing.length / STOCK_VALUE_PAGE_SIZE));
  const page = Math.min(missingPage, lastPage);
  const categoryRows = rank(categoryValue.values());
  const categories = categoryRows.slice(0, STOCK_VALUE_PAGE_SIZE);

  return {
    productCount: products.size,
    // The Finance view leaves the headline absent when there are no posted rows.
    costMinor: rows.length || unallocatedMinor !== BigInt(0) ? costMinor : null,
    costCurrency: currencies.length > 1 ? null : (currencies[0] ?? currencySetting ?? null),
    mixedCurrencies: currencies.length > 1,
    sellingMinor: missingPrice.size === products.size && products.size > 0 ? null : sellingMinor,
    sellingCurrency: currencySetting ?? null,
    expiredMinor,
    expiringMinor,
    heldMinor,
    coveredProductCount: products.size - new Set([...missingCost.keys(), ...unposted]).size,
    unpostedProductCount: [...unposted].filter((id) => !missingCost.has(id)).length,
    missingPriceCount: missingPrice.size,
    missingCost: {
      count: missing.length,
      page,
      lastPage,
      rows: missing.slice((page - 1) * STOCK_VALUE_PAGE_SIZE, page * STOCK_VALUE_PAGE_SIZE),
    },
    topProducts: rank(productValue.values()).slice(0, STOCK_VALUE_PAGE_SIZE),
    categories,
    otherCategoriesMinor: categoryRows
      .slice(STOCK_VALUE_PAGE_SIZE)
      .reduce((sum, row) => sum + row.costMinor, BigInt(0)),
    otherCategoryCount: Math.max(0, categoryRows.length - STOCK_VALUE_PAGE_SIZE),
    unassignedCostMinor: costMinor === null ? null : costMinor - mappedMinor,
  };
}

export type CurrentInventoryValuation = Awaited<ReturnType<typeof currentInventoryValuation>>;
