import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('@/lib/tenancy/scoped-db', () => ({}));
vi.mock('./anomaly-signals-operations', () => ({}));
vi.mock('./reports', () => ({
  PHARMACY_METRIC_CONTRACT: [],
  readPharmacyOwnerCommandCentre: async () => ({
    metrics: { salesMinor: 10000, cashMinor: 6000, expiryValueMinor30: 700, khataAgingMinor: 300 },
  }),
}));

import { readOwnerBriefingFigures } from './owner-digest';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('owner briefing demand aggregates in PostgreSQL', () => {
  let client: pg.Client;
  let db: ScopedDb;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // Temporary tables isolate the real aggregate query from persistent tenant data.
    await client.query(`
      CREATE TEMP TABLE pharmacy_unfulfilled_demand_events (
        "organizationId" text, "branchId" text, "requestedMedicineId" text,
        "estimatedValueMinor" integer, status text, "createdAt" timestamp, "recoveredAt" timestamp
      );
      CREATE TEMP TABLE pharmacy_medicines (
        "organizationId" text, id text, "productName" text
      );
      CREATE TEMP TABLE pharmacy_purchase_orders (
        "organizationId" text, id text, "branchId" text, status text
      );
      CREATE TEMP TABLE pharmacy_purchase_order_lines (
        "organizationId" text, "purchaseOrderId" text, "medicineId" text
      );
      INSERT INTO pharmacy_medicines VALUES ('org_1', 'medicine_1', 'Paracetamol');
      INSERT INTO pharmacy_purchase_orders VALUES ('org_1', 'po_1', 'branch_1', 'DRAFT');
      INSERT INTO pharmacy_purchase_order_lines VALUES ('org_1', 'po_1', 'medicine_1');
      INSERT INTO pharmacy_unfulfilled_demand_events VALUES
        ('org_1', 'branch_1', 'medicine_1', 700, 'OPEN', '2026-08-27 19:00', NULL),
        ('org_1', 'branch_1', 'medicine_1', 400, 'OPEN', '2026-09-03 19:00', NULL),
        ('org_1', 'branch_1', 'medicine_1', 1000, 'RECOVERED', '2026-08-27 19:00', '2026-09-03 19:00'),
        ('org_1', 'branch_1', 'medicine_1', 200, 'RECOVERED', '2026-09-04 08:00', '2026-09-04 09:00'),
        ('org_1', 'branch_1', 'medicine_1', 900, 'RECOVERED', '2026-09-04 08:00', '2026-09-04 19:00'),
        ('org_1', 'branch_1', 'medicine_1', 800, 'RECOVERED', '2026-08-28 08:00', '2026-08-28 18:59'),
        ('org_1', 'branch_2', 'medicine_1', 5000, 'RECOVERED', '2026-09-04 08:00', '2026-09-04 09:00');
    `);
    db = {
      $queryRaw: async (statement: Prisma.Sql) =>
        (
          await client.query(
            statement.text,
            // Match Prisma's UTC encoding for timestamp-without-time-zone columns.
            statement.values.map((value) => (value instanceof Date ? value.toISOString() : value))
          )
        ).rows,
    } as unknown as ScopedDb;
  });

  afterAll(async () => {
    await client?.end();
  });

  it.each(['2026-09-04', '2026-08-29'])(
    'counts recoveries by recovery time, including demand created before %s',
    async (from) => {
      const figures = await readOwnerBriefingFigures(
        db,
        'branch_1',
        from,
        '2026-09-04',
        'Asia/Karachi'
      );
      expect(figures).toEqual({
        salesMinor: 10000,
        cashMinor: 6000,
        expiryAtRiskMinor: 700,
        khataDueMinor: 300,
        lostDemandEstimatedMinor: 400,
        walkOuts: 1,
        topGapName: 'Paracetamol',
        topGapEstimatedMinor: 400,
        topGapDraftPo: true,
        recoveredEstimatedMinor: 1200,
      });
    }
  );
});
