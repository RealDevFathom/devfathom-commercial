import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { exportRestaurantReportCsv, readPurchasingReport, readWastageReport } from './reports';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const timezoneCases = [
  {
    timezone: '+05:00',
    day: '2026-10-21',
    start: '2026-10-20T19:00:00Z',
    end: '2026-10-21T19:00:00Z',
  },
  {
    timezone: '-04:00',
    day: '2026-10-21',
    start: '2026-10-21T04:00:00Z',
    end: '2026-10-22T04:00:00Z',
  },
  {
    timezone: '+05:45',
    day: '2026-10-21',
    start: '2026-10-20T18:15:00Z',
    end: '2026-10-21T18:15:00Z',
  },
  {
    timezone: '-03:30',
    day: '2026-10-21',
    start: '2026-10-21T03:30:00Z',
    end: '2026-10-22T03:30:00Z',
  },
  {
    timezone: '+0530',
    day: '2026-10-21',
    start: '2026-10-20T18:30:00Z',
    end: '2026-10-21T18:30:00Z',
  },
  {
    timezone: '-0330',
    day: '2026-10-21',
    start: '2026-10-21T03:30:00Z',
    end: '2026-10-22T03:30:00Z',
  },
  {
    timezone: '+05',
    day: '2026-10-21',
    start: '2026-10-20T19:00:00Z',
    end: '2026-10-21T19:00:00Z',
  },
  {
    timezone: '-04',
    day: '2026-10-21',
    start: '2026-10-21T04:00:00Z',
    end: '2026-10-22T04:00:00Z',
  },
  {
    timezone: '-00:30',
    day: '2026-10-21',
    start: '2026-10-21T00:30:00Z',
    end: '2026-10-22T00:30:00Z',
  },
  {
    timezone: '+00:00',
    day: '2026-10-21',
    start: '2026-10-21T00:00:00Z',
    end: '2026-10-22T00:00:00Z',
  },
  {
    timezone: 'America/New_York',
    day: '2026-03-08',
    start: '2026-03-08T05:00:00Z',
    end: '2026-03-09T04:00:00Z',
  },
  {
    timezone: 'America/New_York',
    day: '2026-11-01',
    start: '2026-11-01T04:00:00Z',
    end: '2026-11-02T05:00:00Z',
  },
];

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

    const boundaries: Array<readonly [string, string, number]> = [
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
    ];

    for (const { timezone, day, start, end } of timezoneCases) {
      const branchId = `${timezone}-${day}`;
      await db!
        .$executeRaw`INSERT INTO "restaurant_branches" VALUES (${branchId}, ${branchId}, ${timezone})`;
      await db!
        .$executeRaw`INSERT INTO "restaurant_stock_locations" VALUES (${`${branchId}-location`}, ${branchId}, 'Pantry')`;
      for (const [instant, quantity] of [
        [Date.parse(start) - 1, 100],
        [Date.parse(start), 1],
        [Date.parse(start) + 3_600_000, 2],
        [Date.parse(end) - 1, 4],
        [Date.parse(end), 100],
      ]) {
        boundaries.push([
          branchId,
          new Date(instant).toISOString().replace('T', ' ').replace('Z', ''),
          quantity,
        ]);
      }
    }

    for (const [branchId, occurredAt, quantity] of boundaries) {
      const locationId = `${branchId}-location`;
      const id = `${branchId}-${occurredAt}`;
      await db!.$executeRaw`
        INSERT INTO "restaurant_stock_movements"
        VALUES (${id}, 'item', ${locationId}, 'WASTAGE', ${-quantity}, 1, ${occurredAt}::timestamp)
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_orders"
        VALUES (${`order-${id}`}, 'supplier', ${branchId}, 'DRAFT', ${occurredAt}::timestamp)
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_order_lines"
        VALUES (${`order-line-${id}`}, ${`order-${id}`}, ${quantity}, 1)
      `;
      await db!.$executeRaw`
        INSERT INTO "restaurant_purchase_receipts"
        VALUES (${`receipt-${id}`}, 'supplier', ${branchId}, ${occurredAt}::timestamp)
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

  it.each(timezoneCases)(
    'uses $timezone local dates on $day for reports and exports',
    async ({ timezone, day, start, end }) => {
      const range = { branchIds: [`${timezone}-${day}`], from: day, to: day };
      const scopedDb = db! as unknown as ScopedDb;
      const wastage = await readWastageReport(scopedDb, range);
      expect(wastage.totals).toMatchObject({ movementCount: 3, quantity: '7', cost: '7' });
      expect(wastage.byDay).toEqual([
        expect.objectContaining({ day, movementCount: 3, quantity: '7' }),
      ]);

      const purchasing = await readPurchasingReport(scopedDb, range);
      expect(purchasing).toMatchObject({
        purchaseOrderCount: 3,
        purchaseOrderValue: '7',
        receiptCount: 3,
        receivedSupplierSpend: '7',
        discrepancyCount: 3,
        statusCounts: { DRAFT: 3 },
        supplierSpend: [{ supplierName: 'Supplier', amount: '7' }],
      });
      expect(purchasing.discrepancies).toHaveLength(3);
      expect(purchasing.discrepancies.map((row) => row.receivedAt)).toEqual([
        new Date(start).toISOString(),
        new Date(Date.parse(start) + 3_600_000).toISOString(),
        new Date(Date.parse(end) - 1).toISOString(),
      ]);

      const wastageCsv = await exportRestaurantReportCsv(scopedDb, 'wastage', range, {
        includeLabourCosts: false,
      });
      const detailLines = wastageCsv.content.split('\n').slice(1);
      expect(detailLines).toHaveLength(3);
      expect(detailLines.map((line) => line.split(',')[0])).toEqual([day, day, day]);
      expect(detailLines.map((line) => line.split(',')[6])).toEqual(['1', '2', '4']);
      expect(wastageCsv.truncated).toBe(false);

      const purchasingCsv = await exportRestaurantReportCsv(scopedDb, 'purchasing', range, {
        includeLabourCosts: false,
      });
      expect(purchasingCsv.content.split('\n')[1]).toBe(`${day},${day},3,7,3,7,3`);
    }
  );

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
