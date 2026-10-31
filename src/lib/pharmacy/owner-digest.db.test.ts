import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertDisposableRlsDatabase } from '../../../tests/disposable-rls-database';

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

// Keep the date-window fixture above; this second connection uses migrated public
// tables, their real policies/triggers, and a role which cannot bypass RLS.
describe.skipIf(!url)('owner briefing aggregates under migrated PostgreSQL RLS', () => {
  let client: pg.Client;
  let db: ScopedDb;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const orgA = `digest_a_${suffix}`;
  const orgB = `digest_b_${suffix}`;
  const branchA = `digest_branch_a_${suffix}`;
  const branchB = `digest_branch_b_${suffix}`;
  const tables = [
    'pharmacy_unfulfilled_demand_events',
    'pharmacy_medicines',
    'pharmacy_purchase_orders',
    'pharmacy_purchase_order_lines',
  ];

  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    const currentRole = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    // CI may supply the DB administrator. Drop privileges explicitly instead
    // of allowing a superuser to make isolation assertions vacuously pass.
    if (currentRole.rows[0].rolsuper || currentRole.rows[0].rolbypassrls) {
      const role = `digest_runtime_${suffix}`;
      await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT "${role}" TO CURRENT_USER`);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await client.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await client.query(`SET LOCAL ROLE "${role}"`);
    }
    const runtime = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(runtime.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const policies = await client.query(
      `
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]) ORDER BY relname
    `,
      [tables]
    );
    expect(policies.rows).toEqual(
      [...tables].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      }))
    );

    for (const [org, branch, label] of [
      [orgA, branchA, 'Own'],
      [orgB, branchB, 'Foreign'],
    ]) {
      await client.query(
        `SELECT set_config('app.is_platform_admin', 'false', true),
        set_config('app.current_organization_id', $1, true),
        set_config('app.current_branch_id', $2, true)`,
        [org, branch]
      );
      await client.query(
        `INSERT INTO organizations
        (id, slug, "legalName", "displayName", status, vertical, "deploymentMode", "createdAt", "updatedAt")
        VALUES ($1,$1,$1,$1,'ACTIVE','PHARMACY','SHARED',now(),now())`,
        [org]
      );
      await client.query(
        `INSERT INTO pharmacy_branches
        (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
        VALUES ($1,$2,$1,$1,'1 Test Road','Lahore','PB',now())`,
        [branch, org]
      );
      await client.query(
        `INSERT INTO pharmacy_medicines
        (id,"organizationId","productName","productFamily","updatedAt")
        VALUES ($1,$2,$3,'PHARMACEUTICAL',now())`,
        [`medicine_${org}`, org, `${label} medicine`]
      );
      await client.query(
        `INSERT INTO pharmacy_presentations
        (id,"organizationId","medicineId",presentation,"updatedAt")
        VALUES ($1,$2,$3,'tablet',now())`,
        [`presentation_${org}`, org, `medicine_${org}`]
      );
      await client.query(
        `INSERT INTO pharmacy_pack_levels
        (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
        VALUES ($1,$2,$3,$1,1,'CARTON',1,now())`,
        [`pack_${org}`, org, `presentation_${org}`]
      );
      await client.query(
        `INSERT INTO pharmacy_suppliers (id,"organizationId",name,authorized,"updatedAt")
        VALUES ($1,$2,$1,true,now())`,
        [`supplier_${org}`, org]
      );
      await client.query(
        `INSERT INTO pharmacy_supplier_licences
        (id,"organizationId","supplierId","licenceType","licenceNumber","issuingAuthority",
         "issuedAt","expiresAt","verifiedAt","verifiedByUserId")
        VALUES ($1,$2,$3,'WHOLESALE',$1,'Test authority',now()-interval '1 day',
          now()+interval '1 year',now(),'test_owner')`,
        [`licence_${org}`, org, `supplier_${org}`]
      );
      await client.query(
        `INSERT INTO pharmacy_purchase_orders
        (id,"organizationId","branchId",reference,"supplierId","createdByUserId","updatedAt")
        VALUES ($1,$2,$3,$1,$4,'test_owner',now())`,
        [`po_${org}`, org, branch, `supplier_${org}`]
      );
      await client.query(
        `INSERT INTO pharmacy_purchase_order_lines
        (id,"organizationId","purchaseOrderId","medicineId","packLevelId","lineNumber",
         "orderedPacks","canonicalUnitsPerPack","orderedCanonicalUnits","listPricePerPackMinor")
        VALUES ($1,$2,$3,$4,$5,1,1,1,1,100)`,
        [`pol_${org}`, org, `po_${org}`, `medicine_${org}`, `pack_${org}`]
      );
      await client.query(
        `INSERT INTO pharmacy_unfulfilled_demand_events
        (id,"organizationId","branchId","requestedMedicineId","saleUnit",quantity,reason,
         "inventoryRuleSnapshot","estimatedValueMinor","capturedByUserId","createdAt")
        VALUES ($1,$3,$4,$5,'UNIT',1,'STOCKOUT','{}',1500000000,'test_owner','2026-09-04 08:00'),
               ($2,$3,$4,$5,'UNIT',1,'STOCKOUT','{}',1500000000,'test_owner','2026-09-04 09:00')`,
        [`demand_1_${org}`, `demand_2_${org}`, org, branch, `medicine_${org}`]
      );
    }
    db = {
      $queryRaw: async (statement: Prisma.Sql) =>
        (
          await client.query(
            statement.text,
            statement.values.map((value) => (value instanceof Date ? value.toISOString() : value))
          )
        ).rows,
    } as unknown as ScopedDb;
  });

  afterAll(async () => {
    if (client) {
      // Fixtures and any temporary runtime role disappear together.
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('uses real RLS for demand, catalog and draft-PO reads and accepts sums above int32', async () => {
    await client.query(
      `SELECT set_config('app.current_organization_id',$1,true),
      set_config('app.current_branch_id',$2,true)`,
      [orgA, branchA]
    );
    const own = await readOwnerBriefingFigures(db, branchA, '2026-09-04', '2026-09-04', 'UTC');
    expect(own).toMatchObject({
      lostDemandEstimatedMinor: 3_000_000_000,
      topGapEstimatedMinor: 3_000_000_000,
      walkOuts: 2,
      topGapName: 'Own medicine',
      topGapDraftPo: true,
    });
    const foreign = await readOwnerBriefingFigures(db, branchB, '2026-09-04', '2026-09-04', 'UTC');
    expect(foreign).toMatchObject({
      lostDemandEstimatedMinor: 0,
      topGapEstimatedMinor: 0,
      recoveredEstimatedMinor: 0,
      walkOuts: 0,
      topGapName: null,
      topGapDraftPo: false,
    });
    // Also assert the joins' source tables themselves enforce the real policies.
    for (const table of tables) {
      const visible = await client.query(`SELECT DISTINCT "organizationId" FROM "${table}"`);
      expect(visible.rows).toEqual([{ organizationId: orgA }]);
    }
    await client.query(
      `SELECT set_config('app.current_organization_id',$1,true),
      set_config('app.current_branch_id',$2,true)`,
      [orgB, branchB]
    );
    const other = await readOwnerBriefingFigures(db, branchB, '2026-09-04', '2026-09-04', 'UTC');
    expect(other).toMatchObject({
      topGapName: 'Foreign medicine',
      topGapDraftPo: true,
      walkOuts: 2,
    });
  });
});
