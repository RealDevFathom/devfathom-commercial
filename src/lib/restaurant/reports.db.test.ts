import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { readPurchasingReport, readWastageReport } from './reports';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase('restaurant report timezone boundaries', () => {
  const db = databaseUrl
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }) })
    : null;

  beforeAll(async () => {
    await db!.$executeRawUnsafe(`SET TIME ZONE 'Asia/Karachi'`);
    const setupStatements = [
      `CREATE TEMP TABLE "restaurant_branches" ("id" text PRIMARY KEY, "name" text NOT NULL, "timezone" text NOT NULL)`,
      `CREATE TEMP TABLE "restaurant_stock_locations" ("id" text PRIMARY KEY, "branchId" text NOT NULL, "name" text NOT NULL)`,
      `CREATE TEMP TABLE "restaurant_units" ("id" text PRIMARY KEY, "name" text NOT NULL, "abbreviation" text)`,
      `CREATE TEMP TABLE "restaurant_ingredients" ("id" text PRIMARY KEY, "name" text NOT NULL, "referenceCost" numeric)`,
      `CREATE TEMP TABLE "restaurant_stock_items" ("id" text PRIMARY KEY, "ingredientId" text NOT NULL, "canonicalUnitId" text NOT NULL)`,
      `CREATE TEMP TABLE "restaurant_stock_movements" (
        "id" text PRIMARY KEY, "stockItemId" text NOT NULL, "locationId" text NOT NULL,
        "reason" text NOT NULL, "quantity" numeric NOT NULL, "unitCost" numeric, "occurredAt" timestamp NOT NULL
      )`,
      `CREATE TEMP TABLE "restaurant_suppliers" ("id" text PRIMARY KEY, "name" text NOT NULL)`,
      `CREATE TEMP TABLE "restaurant_purchase_orders" (
        "id" text PRIMARY KEY, "supplierId" text NOT NULL, "branchId" text NOT NULL,
        "status" text NOT NULL, "createdAt" timestamp NOT NULL
      )`,
      `CREATE TEMP TABLE "restaurant_purchase_order_lines" (
        "id" text PRIMARY KEY, "purchaseOrderId" text NOT NULL, "orderedQuantity" numeric NOT NULL, "unitCost" numeric NOT NULL
      )`,
      `CREATE TEMP TABLE "restaurant_purchase_receipts" (
        "id" text PRIMARY KEY, "supplierId" text NOT NULL, "branchId" text NOT NULL, "receivedAt" timestamp NOT NULL
      )`,
      `CREATE TEMP TABLE "restaurant_purchase_receipt_lines" (
        "id" text PRIMARY KEY, "purchaseReceiptId" text NOT NULL, "receivedQuantity" numeric NOT NULL, "unitCost" numeric NOT NULL
      )`,
      `CREATE TEMP TABLE "restaurant_receiving_discrepancies" (
        "id" text PRIMARY KEY, "purchaseReceiptId" text NOT NULL, "kind" text NOT NULL
      )`,
      `INSERT INTO "restaurant_branches" VALUES
        ('karachi', 'Karachi', 'Asia/Karachi'), ('new-york', 'New York', 'America/New_York')`,
      `INSERT INTO "restaurant_stock_locations" VALUES
        ('karachi-location', 'karachi', 'Pantry'), ('new-york-location', 'new-york', 'Pantry')`,
      `INSERT INTO "restaurant_units" VALUES ('unit', 'kilogram', 'kg')`,
      `INSERT INTO "restaurant_ingredients" VALUES ('ingredient', 'Flour', NULL)`,
      `INSERT INTO "restaurant_stock_items" VALUES ('item', 'ingredient', 'unit')`,
      `INSERT INTO "restaurant_suppliers" VALUES ('supplier', 'Supplier')`,
    ];
    for (const statement of setupStatements) await db!.$executeRawUnsafe(statement);

    const boundaries = [
      ['karachi', '2026-10-20 18:59:59.999', 100],
      ['karachi', '2026-10-20 19:00:00', 1],
      ['karachi', '2026-10-20 20:00:00', 2],
      ['karachi', '2026-10-21 18:59:59.999', 4],
      ['karachi', '2026-10-21 19:00:00', 100],
      ['new-york', '2026-10-21 03:59:59.999', 100],
      ['new-york', '2026-10-21 04:00:00', 1],
      ['new-york', '2026-10-21 05:00:00', 2],
      ['new-york', '2026-10-22 03:59:59.999', 4],
      ['new-york', '2026-10-22 04:00:00', 100],
    ] as const;

    for (const [branchId, occurredAt, quantity] of boundaries) {
      const locationId = `${branchId}-location`;
      const id = `${branchId}-${occurredAt}`;
      await db!.$executeRaw`
        INSERT INTO "restaurant_stock_movements"
        VALUES (${id}, 'item', ${locationId}, 'WASTAGE', ${-quantity}, 1, ${occurredAt})
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_orders"
        VALUES (${`order-${id}`}, 'supplier', ${branchId}, 'DRAFT', ${occurredAt})
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_order_lines"
        VALUES (${`order-line-${id}`}, ${`order-${id}`}, ${quantity}, 1)
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_receipts"
        VALUES (${`receipt-${id}`}, 'supplier', ${branchId}, ${occurredAt})
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_receipt_lines"
        VALUES (${`receipt-line-${id}`}, ${`receipt-${id}`}, ${quantity}, 1)
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_receiving_discrepancies"
        VALUES (${`discrepancy-${id}`}, ${`receipt-${id}`}, 'QUANTITY')
      `;
    }
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('runs wastage report filtering and grouping against branch-local days', async () => {
    const session = await db!.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TIME ZONE');
    expect(session[0]?.TimeZone).toBe('Asia/Karachi');

    const report = await readWastageReport(db! as unknown as ScopedDb, {
      branchIds: ['karachi', 'new-york'],
      from: '2026-10-21',
      to: '2026-10-21',
    });

    expect(report.totals).toMatchObject({ movementCount: 6, quantity: '14', cost: '14' });
    expect(report.byDay).toEqual([
      expect.objectContaining({ day: '2026-10-21', movementCount: 6, quantity: '14' }),
    ]);
  });

  it('runs every purchasing aggregation against branch-local day boundaries', async () => {
    const report = await readPurchasingReport(db! as unknown as ScopedDb, {
      branchIds: ['karachi', 'new-york'],
      from: '2026-10-21',
      to: '2026-10-21',
    });

    expect(report).toMatchObject({
      purchaseOrderCount: 6,
      purchaseOrderValue: '14',
      receiptCount: 6,
      receivedSupplierSpend: '14',
      discrepancyCount: 6,
      statusCounts: { DRAFT: 6 },
      supplierSpend: [{ supplierName: 'Supplier', amount: '14' }],
    });
    expect(report.discrepancies).toHaveLength(6);
  });
});
