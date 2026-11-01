import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
const RUNTIME_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = OWNER_DATABASE_URL && RUNTIME_DATABASE_URL ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `sc_org_a_${suffix}`,
  orgB: `sc_org_b_${suffix}`,
  branchA: `sc_branch_a_${suffix}`,
  branchB: `sc_branch_b_${suffix}`,
  staffA: `sc_staff_a_${suffix}`,
  deviceA: `sc_device_a_${suffix}`,
  legacyOrder: `sc_legacy_order_${suffix}`,
  legacyBill: `sc_legacy_bill_${suffix}`,
  policyOrder: `sc_policy_order_${suffix}`,
  policyBill: `sc_policy_bill_${suffix}`,
  zeroPolicyOrder: `sc_zero_policy_order_${suffix}`,
  zeroPolicyBill: `sc_zero_policy_bill_${suffix}`,
  policyA: `sc_policy_a_${suffix}`,
  policyB: `sc_policy_b_${suffix}`,
};

const owner = OWNER_DATABASE_URL ? new pg.Client({ connectionString: OWNER_DATABASE_URL }) : null;
const runtime = RUNTIME_DATABASE_URL
  ? new pg.Client({ connectionString: RUNTIME_DATABASE_URL })
  : null;

async function expectDatabaseError(
  client: pg.Client,
  code: string,
  operation: () => Promise<unknown>
) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
    expect(error).toMatchObject({ code });
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  throw new Error(`Expected PostgreSQL error ${code}`);
}

async function insertBill(
  id: string,
  orderId: string,
  evidence: {
    total: number;
    policyVersionId?: string | null;
    rate?: number | null;
    basis?: number;
    taxTreatment?: string | null;
  }
) {
  await owner!.query(
    `INSERT INTO "restaurant_bills" (
       "id", "organizationId", "orderId", "branchId", "businessDate",
       "serviceChargeTotal", "serviceChargePolicyVersionId", "serviceChargeRate",
       "serviceChargeBasis", "serviceChargeTaxTreatment", "openerStaffProfileId",
       "deviceId", "subtotal", "grandTotal", "updatedAt"
     ) VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8, $9, $10, $11,
               $8, $8::numeric + $5::numeric, CURRENT_TIMESTAMP)`,
    [
      id,
      ids.orgA,
      orderId,
      ids.branchA,
      evidence.total,
      evidence.policyVersionId ?? null,
      evidence.rate ?? null,
      evidence.basis ?? 0,
      evidence.taxTreatment ?? null,
      ids.staffA,
      ids.deviceA,
    ]
  );
}

describeIfDatabase('restaurant service-charge v1 database contract', () => {
  beforeAll(async () => {
    for (const url of [OWNER_DATABASE_URL!, RUNTIME_DATABASE_URL!]) {
      if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname)) {
        throw new Error('Refusing to run service-charge probes against a non-local database.');
      }
    }
    await owner!.connect();
    await runtime!.connect();
    await owner!.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await owner!.query(
      `INSERT INTO "organizations" (
         "id", "slug", "legalName", "displayName", "status", "deploymentMode",
         "createdAt", "updatedAt"
       ) VALUES
         ($1, $1, 'Service charge A', 'Service charge A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
         ($2, $2, 'Service charge B', 'Service charge B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, ids.orgB]
    );
    await owner!.query(
      `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES
         ($1, $2, 'Branch A', CURRENT_TIMESTAMP),
         ($3, $4, 'Branch B', CURRENT_TIMESTAMP)`,
      [ids.branchA, ids.orgA, ids.branchB, ids.orgB]
    );
    await owner!.query(
      `INSERT INTO "restaurant_staff_profiles" ("id", "organizationId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Operator A', CURRENT_TIMESTAMP)`,
      [ids.staffA, ids.orgA]
    );
    await owner!.query(
      `INSERT INTO "restaurant_registered_devices" (
         "id", "organizationId", "branchId", "name", "deviceSecretHash", "updatedAt"
       ) VALUES ($1, $2, $3, 'Register A', $4, CURRENT_TIMESTAMP)`,
      [ids.deviceA, ids.orgA, ids.branchA, `secret_${suffix}`]
    );
    await owner!.query(
      `INSERT INTO "restaurant_orders" (
         "id", "organizationId", "branchId", "orderNumber", "businessDate", "channel",
         "staffProfileId", "deviceId", "updatedAt"
       ) VALUES
         ($1, $2, $3, 1, CURRENT_DATE, 'DINE_IN', $4, $5, CURRENT_TIMESTAMP),
         ($6, $2, $3, 2, CURRENT_DATE, 'DINE_IN', $4, $5, CURRENT_TIMESTAMP),
         ($7, $2, $3, 3, CURRENT_DATE, 'DINE_IN', $4, $5, CURRENT_TIMESTAMP)`,
      [
        ids.legacyOrder,
        ids.orgA,
        ids.branchA,
        ids.staffA,
        ids.deviceA,
        ids.policyOrder,
        ids.zeroPolicyOrder,
      ]
    );
    await owner!.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ids.orgA]);
    await owner!.query(
      `INSERT INTO "restaurant_service_charge_policy_versions" (
         "id", "organizationId", "branchId", "rate", "effectiveFrom", "effectiveTo",
         "acknowledgedAt", "acknowledgementRef", "idempotencyKey", "payloadHash"
       ) VALUES ($1, $2, $3, 0.10, '2026-01-01', NULL, CURRENT_TIMESTAMP, 'approved-a', $4, $5)`,
      [ids.policyA, ids.orgA, ids.branchA, `policy_a_${suffix}`, `hash_a_${suffix}`]
    );
    await owner!.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ids.orgB]);
    await owner!.query(
      `INSERT INTO "restaurant_service_charge_policy_versions" (
         "id", "organizationId", "branchId", "rate", "effectiveFrom", "effectiveTo",
         "acknowledgedAt", "acknowledgementRef", "idempotencyKey", "payloadHash"
       ) VALUES ($1, $2, $3, 0.12, '2026-01-01', NULL, CURRENT_TIMESTAMP, 'approved-b', $4, $5)`,
      [ids.policyB, ids.orgB, ids.branchB, `policy_b_${suffix}`, `hash_b_${suffix}`]
    );
    await owner!.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ids.orgA]);
  });

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
  });

  it('accepts legacy taxable and complete policy-backed non-taxable bill evidence', async () => {
    await insertBill(ids.legacyBill, ids.legacyOrder, { total: 10 });
    await insertBill(ids.policyBill, ids.policyOrder, {
      total: 10,
      policyVersionId: ids.policyA,
      rate: 0.1,
      basis: 100,
      taxTreatment: 'NON_TAXABLE',
    });
    await insertBill(ids.zeroPolicyBill, ids.zeroPolicyOrder, {
      total: 0,
      policyVersionId: ids.policyA,
      rate: 0.1,
      basis: 0.01,
      taxTreatment: 'NON_TAXABLE',
    });

    const evidence = await owner!.query(
      `SELECT "id", "serviceChargeTotal", "serviceChargePolicyVersionId",
              "serviceChargeRate", "serviceChargeBasis", "serviceChargeTaxTreatment"
         FROM "restaurant_bills" WHERE "id" IN ($1, $2, $3) ORDER BY "id"`,
      [ids.legacyBill, ids.policyBill, ids.zeroPolicyBill]
    );
    expect(evidence.rowCount).toBe(3);
    expect(evidence.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ids.legacyBill,
          serviceChargeTotal: '10.00',
          serviceChargePolicyVersionId: null,
          serviceChargeBasis: '0.00',
          serviceChargeTaxTreatment: null,
        }),
        expect.objectContaining({
          id: ids.policyBill,
          serviceChargeTotal: '10.00',
          serviceChargePolicyVersionId: ids.policyA,
          serviceChargeRate: '0.100000',
          serviceChargeBasis: '100.00',
          serviceChargeTaxTreatment: 'NON_TAXABLE',
        }),
        expect.objectContaining({
          id: ids.zeroPolicyBill,
          serviceChargeTotal: '0.00',
          serviceChargePolicyVersionId: ids.policyA,
          serviceChargeRate: '0.100000',
          serviceChargeBasis: '0.01',
          serviceChargeTaxTreatment: 'NON_TAXABLE',
        }),
      ])
    );
  });

  it('rejects incomplete and mixed evidence shapes', async () => {
    await owner!.query('BEGIN');
    for (const [name, evidence] of [
      [
        'policy-without-rate',
        { total: 10, policyVersionId: ids.policyA, basis: 100, taxTreatment: 'NON_TAXABLE' },
      ],
      ['legacy-with-basis', { total: 10, basis: 100 }],
      [
        'taxable-policy',
        { total: 10, policyVersionId: ids.policyA, rate: 0.1, basis: 100, taxTreatment: 'TAXABLE' },
      ],
    ] as const) {
      await expectDatabaseError(owner!, '23514', () =>
        insertBill(`sc_invalid_${name}_${suffix}`, ids.policyOrder, evidence)
      );
    }
    await owner!.query('ROLLBACK');
  });

  it('uses a restricted runtime role and discloses zero cross-tenant policy rows', async () => {
    const role = await runtime!.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname = current_user`
    );
    expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });

    await runtime!.query(`SELECT set_config('app.current_organization_id', $1, false)`, [ids.orgA]);
    const visible = await runtime!.query(
      `SELECT "id" FROM "restaurant_service_charge_policy_versions" ORDER BY "id"`
    );
    expect(visible.rows).toEqual([{ id: ids.policyA }]);
    expect(
      (
        await runtime!.query(
          `SELECT "id" FROM "restaurant_service_charge_policy_versions" WHERE "id" = $1`,
          [ids.policyB]
        )
      ).rowCount
    ).toBe(0);
  });

  it('enforces GiST interval exclusion and closure immutability', async () => {
    await owner!.query('BEGIN');
    await expectDatabaseError(owner!, '23P01', () =>
      owner!.query(
        `INSERT INTO "restaurant_service_charge_policy_versions" (
           "id", "organizationId", "branchId", "rate", "effectiveFrom", "effectiveTo",
           "acknowledgedAt", "acknowledgementRef", "idempotencyKey", "payloadHash"
         ) VALUES ($1, $2, $3, 0.11, '2026-06-01', '2027-01-01', CURRENT_TIMESTAMP,
                   'overlap', $4, $5)`,
        [`sc_overlap_${suffix}`, ids.orgA, ids.branchA, `overlap_${suffix}`, `hash_${suffix}`]
      )
    );
    await owner!.query(
      `UPDATE "restaurant_service_charge_policy_versions"
          SET "effectiveTo" = '2027-01-01', "endIdempotencyKey" = $2, "endPayloadHash" = $3
        WHERE "id" = $1`,
      [ids.policyA, `end_${suffix}`, `end_hash_${suffix}`]
    );
    await expectDatabaseError(owner!, 'P0001', () =>
      owner!.query(
        `UPDATE "restaurant_service_charge_policy_versions" SET "rate" = 0.20 WHERE "id" = $1`,
        [ids.policyA]
      )
    );
    // Check the deployed DELETE policy as the restricted runtime role, even
    // when the fixture connection is a local superuser used for migration QA.
    const { role } = (
      await runtime!.query<{ role: string }>('SELECT quote_ident(current_user) AS role')
    ).rows[0]!;
    await owner!.query(`SET LOCAL ROLE ${role}`);
    expect(
      (
        await owner!.query(
          `DELETE FROM "restaurant_service_charge_policy_versions" WHERE "id" = $1`,
          [ids.policyA]
        )
      ).rowCount
    ).toBe(0);
    expect(
      await owner!.query(
        `SELECT "id" FROM "restaurant_service_charge_policy_versions" WHERE "id" = $1`,
        [ids.policyA]
      )
    ).toMatchObject({ rows: [{ id: ids.policyA }] });
    await owner!.query('ROLLBACK');
  });

  it('serializes the branch policy key with a transaction advisory lock', async () => {
    const contender = new pg.Client({ connectionString: RUNTIME_DATABASE_URL });
    await contender.connect();
    try {
      await runtime!.query('BEGIN');
      await contender.query('BEGIN');
      const key = `${ids.orgA}:service-charge:${ids.branchA}`;
      await runtime!.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
      expect(
        (
          await contender.query(
            `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
            [key]
          )
        ).rows[0]
      ).toEqual({ locked: false });
      await runtime!.query('COMMIT');
      expect(
        (
          await contender.query(
            `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
            [key]
          )
        ).rows[0]
      ).toEqual({ locked: true });
      await contender.query('COMMIT');
    } finally {
      await runtime!.query('ROLLBACK').catch(() => undefined);
      await contender.query('ROLLBACK').catch(() => undefined);
      await contender.end();
    }
  });
});
