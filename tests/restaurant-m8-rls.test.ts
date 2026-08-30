import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const M8_TEST_OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
const describeIfDatabase =
  TEST_DATABASE_URL && M8_TEST_OWNER_DATABASE_URL ? describe : describe.skip;
const runtimeClient = TEST_DATABASE_URL
  ? new pg.Client({ connectionString: TEST_DATABASE_URL })
  : null;
const ownerClient = M8_TEST_OWNER_DATABASE_URL
  ? new pg.Client({ connectionString: M8_TEST_OWNER_DATABASE_URL })
  : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

const M8_TABLES = [
  'restaurant_customers',
  'restaurant_customer_identifiers',
  'restaurant_customer_interactions',
  'restaurant_customer_tags',
  'restaurant_customer_tag_assignments',
  'restaurant_customer_consents',
  'restaurant_loyalty_program_versions',
  'restaurant_loyalty_accounts',
  'restaurant_loyalty_points_entries',
  'restaurant_insight_daily_rollups',
  'restaurant_insight_loyalty_liabilities',
  'restaurant_insight_item_mix_rollups',
  'restaurant_labour_cost_facts',
] as const;

const APPEND_ONLY = [
  'restaurant_customer_interactions',
  'restaurant_customer_consents',
  'restaurant_loyalty_points_entries',
  'restaurant_labour_cost_facts',
] as const;

const ids = {
  orgA: `m8_org_a_${suffix}`,
  orgB: `m8_org_b_${suffix}`,
  branchA: `m8_branch_a_${suffix}`,
  branchB: `m8_branch_b_${suffix}`,
  staffA: `m8_staff_a_${suffix}`,
  staffB: `m8_staff_b_${suffix}`,
  productA: `m8_product_a_${suffix}`,
  productB: `m8_product_b_${suffix}`,
  closeA: `m8_close_a_${suffix}`,
  closeB: `m8_close_b_${suffix}`,
  customerA: `m8_customer_a_${suffix}`,
  customerB: `m8_customer_b_${suffix}`,
  identifierA: `m8_identifier_a_${suffix}`,
  identifierB: `m8_identifier_b_${suffix}`,
  interactionA: `m8_interaction_a_${suffix}`,
  interactionB: `m8_interaction_b_${suffix}`,
  tagA: `m8_tag_a_${suffix}`,
  tagB: `m8_tag_b_${suffix}`,
  assignmentA: `m8_assignment_a_${suffix}`,
  assignmentB: `m8_assignment_b_${suffix}`,
  consentA: `m8_consent_a_${suffix}`,
  consentB: `m8_consent_b_${suffix}`,
  programA: `m8_program_a_${suffix}`,
  programB: `m8_program_b_${suffix}`,
  accountA: `m8_account_a_${suffix}`,
  accountB: `m8_account_b_${suffix}`,
  pointsA: `m8_points_a_${suffix}`,
  pointsB: `m8_points_b_${suffix}`,
  dailyA: `m8_daily_a_${suffix}`,
  dailyB: `m8_daily_b_${suffix}`,
  liabilityA: `m8_liability_a_${suffix}`,
  liabilityB: `m8_liability_b_${suffix}`,
  itemA: `m8_item_a_${suffix}`,
  itemB: `m8_item_b_${suffix}`,
  labourA: `m8_labour_a_${suffix}`,
  labourB: `m8_labour_b_${suffix}`,
} as const;

const rowIds: Record<(typeof M8_TABLES)[number], [string, string]> = {
  restaurant_customers: [ids.customerA, ids.customerB],
  restaurant_customer_identifiers: [ids.identifierA, ids.identifierB],
  restaurant_customer_interactions: [ids.interactionA, ids.interactionB],
  restaurant_customer_tags: [ids.tagA, ids.tagB],
  restaurant_customer_tag_assignments: [ids.assignmentA, ids.assignmentB],
  restaurant_customer_consents: [ids.consentA, ids.consentB],
  restaurant_loyalty_program_versions: [ids.programA, ids.programB],
  restaurant_loyalty_accounts: [ids.accountA, ids.accountB],
  restaurant_loyalty_points_entries: [ids.pointsA, ids.pointsB],
  restaurant_insight_daily_rollups: [ids.dailyA, ids.dailyB],
  restaurant_insight_loyalty_liabilities: [ids.liabilityA, ids.liabilityB],
  restaurant_insight_item_mix_rollups: [ids.itemA, ids.itemB],
  restaurant_labour_cost_facts: [ids.labourA, ids.labourB],
};

let normalizedIdentifierProof: Array<{ kind: string; organizations: number; rows: number }> = [];
let connectionProof: Array<{
  connection: string;
  database: string;
  role: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
}> = [];

async function expectDatabaseError(code: string, run: () => Promise<unknown>) {
  await runtimeClient!.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await runtimeClient!.query('ROLLBACK TO SAVEPOINT expected_failure');
    await runtimeClient!.query('RELEASE SAVEPOINT expected_failure');
  }
}

describeIfDatabase('M8 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const urls = [TEST_DATABASE_URL!, M8_TEST_OWNER_DATABASE_URL!];
    if (
      urls.some(
        (url) => !['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname)
      )
    ) {
      throw new Error('Refusing to run M8 RLS probes against a non-local database.');
    }

    await ownerClient!.connect();
    await runtimeClient!.connect();
    await ownerClient!.query('BEGIN');
    await ownerClient!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await ownerClient!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M8 Tenant A', 'M8 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M8 Tenant B', 'M8 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m8-a-${suffix}`, ids.orgB, `m8-b-${suffix}`]
    );

    connectionProof = (
      await Promise.all([
        ['owner', ownerClient!],
        ['runtime', runtimeClient!],
      ] as const).then((connections) =>
        Promise.all(
          connections.map(async ([connection, client]) => ({
            connection,
            ...(
              await client.query<{
                database: string;
                role: string;
                rolcanlogin: boolean;
                rolsuper: boolean;
                rolbypassrls: boolean;
              }>(
                `SELECT current_database() AS database, current_user AS role,
                        rolcanlogin, rolsuper, rolbypassrls
                   FROM pg_catalog.pg_roles
                  WHERE rolname = current_user`
              )
            ).rows[0],
          }))
        )
      )
    ).sort((left, right) => left.connection.localeCompare(right.connection));

    await ownerClient!.query(
      `INSERT INTO "restaurant_branches" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'M8 Branch A', CURRENT_TIMESTAMP),
        ($3, $4, 'M8 Branch B', CURRENT_TIMESTAMP)`,
      [ids.branchA, ids.orgA, ids.branchB, ids.orgB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_staff_profiles" (
        "id", "organizationId", "displayName", "primaryBranchId", "updatedAt"
      ) VALUES
        ($1, $2, 'M8 Staff A', $3, CURRENT_TIMESTAMP),
        ($4, $5, 'M8 Staff B', $6, CURRENT_TIMESTAMP)`,
      [ids.staffA, ids.orgA, ids.branchA, ids.staffB, ids.orgB, ids.branchB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_products" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'M8 Product A', CURRENT_TIMESTAMP),
        ($3, $4, 'M8 Product B', CURRENT_TIMESTAMP)`,
      [ids.productA, ids.orgA, ids.productB, ids.orgB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_daily_closes" (
        "id", "organizationId", "branchId", "businessDate", "cutByStaffProfileId"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', $4),
        ($5, $6, $7, DATE '2030-01-01', $8)`,
      [ids.closeA, ids.orgA, ids.branchA, ids.staffA, ids.closeB, ids.orgB, ids.branchB, ids.staffB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt") VALUES
        ($1, $2, 'Tenant A Customer', CURRENT_TIMESTAMP),
        ($3, $4, 'Tenant B Customer', CURRENT_TIMESTAMP)`,
      [ids.customerA, ids.orgA, ids.customerB, ids.orgB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_customer_identifiers" (
        "id", "organizationId", "customerId", "kind", "normalizedValue", "updatedAt"
      ) VALUES
        ($1, $2, $3, 'EMAIL', $4, CURRENT_TIMESTAMP),
        ($5, $6, $7, 'EMAIL', $4, CURRENT_TIMESTAMP),
        ($8, $2, $3, 'PHONE', $9, CURRENT_TIMESTAMP),
        ($10, $6, $7, 'PHONE', $9, CURRENT_TIMESTAMP)`,
      [
        ids.identifierA,
        ids.orgA,
        ids.customerA,
        `shared-${suffix}@example.test`,
        ids.identifierB,
        ids.orgB,
        ids.customerB,
        `m8_phone_a_${suffix}`,
        `+1555${suffix.slice(0, 8)}`,
        `m8_phone_b_${suffix}`,
      ]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_customer_interactions" (
        "id", "organizationId", "customerId", "branchId", "type", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, $4, 'ORDER', $5),
        ($6, $7, $8, $9, 'ORDER', $5)`,
      [
        ids.interactionA,
        ids.orgA,
        ids.customerA,
        ids.branchA,
        `interaction-${suffix}`,
        ids.interactionB,
        ids.orgB,
        ids.customerB,
        ids.branchB,
      ]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_customer_tags" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'Regular', CURRENT_TIMESTAMP), ($3, $4, 'Regular', CURRENT_TIMESTAMP)`,
      [ids.tagA, ids.orgA, ids.tagB, ids.orgB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_customer_tag_assignments" (
        "id", "organizationId", "customerId", "tagId"
      ) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [
        ids.assignmentA,
        ids.orgA,
        ids.customerA,
        ids.tagA,
        ids.assignmentB,
        ids.orgB,
        ids.customerB,
        ids.tagB,
      ]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_customer_consents" (
        "id", "organizationId", "customerId", "channel", "granted", "source",
        "actorId", "policyVersion", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, 'EMAIL', true, 'customer', 'actor-a', 'v1', $4),
        ($5, $6, $7, 'EMAIL', true, 'customer', 'actor-b', 'v1', $4)`,
      [
        ids.consentA,
        ids.orgA,
        ids.customerA,
        `consent-${suffix}`,
        ids.consentB,
        ids.orgB,
        ids.customerB,
      ]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_loyalty_program_versions" (
        "id", "organizationId", "versionNumber", "effectiveFrom", "earnRate", "redemptionValue", "updatedAt"
      ) VALUES
        ($1, $2, 1, clock_timestamp() - interval '1 minute', 1, 0.01, clock_timestamp()),
        ($3, $4, 1, clock_timestamp() - interval '1 minute', 1, 0.01, clock_timestamp())`,
      [ids.programA, ids.orgA, ids.programB, ids.orgB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_loyalty_accounts" ("id", "organizationId", "customerId", "updatedAt") VALUES
        ($1, $2, $3, CURRENT_TIMESTAMP), ($4, $5, $6, CURRENT_TIMESTAMP)`,
      [ids.accountA, ids.orgA, ids.customerA, ids.accountB, ids.orgB, ids.customerB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_loyalty_points_entries" (
        "id", "organizationId", "accountId", "programVersionId", "kind", "points",
        "actorId", "reason", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, $4, 'ADJUSTMENT', 1, 'actor-a', 'seed', $5),
        ($6, $7, $8, $9, 'ADJUSTMENT', 1, 'actor-b', 'seed', $5)`,
      [
        ids.pointsA,
        ids.orgA,
        ids.accountA,
        ids.programA,
        `points-${suffix}`,
        ids.pointsB,
        ids.orgB,
        ids.accountB,
        ids.programB,
      ]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_insight_daily_rollups" (
        "id", "organizationId", "branchId", "businessDate", "sourceDailyCloseId", "updatedAt"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', $4, CURRENT_TIMESTAMP),
        ($5, $6, $7, DATE '2030-01-01', $8, CURRENT_TIMESTAMP)`,
      [ids.dailyA, ids.orgA, ids.branchA, ids.closeA, ids.dailyB, ids.orgB, ids.branchB, ids.closeB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_insight_loyalty_liabilities" (
        "id", "organizationId", "businessDate", "cutoffAt", "programVersionId",
        "redemptionValue", "positivePoints", "signedPoints", "liability", "updatedAt"
      ) VALUES
        ($1, $2, DATE '2030-01-01', TIMESTAMPTZ '2030-01-02T00:00:00Z', $3, 0.01, 100, 80, 1, CURRENT_TIMESTAMP),
        ($4, $5, DATE '2030-01-01', TIMESTAMPTZ '2030-01-02T00:00:00Z', $6, 0.01, 200, 180, 2, CURRENT_TIMESTAMP)`,
      [ids.liabilityA, ids.orgA, ids.programA, ids.liabilityB, ids.orgB, ids.programB]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_insight_item_mix_rollups" (
        "id", "organizationId", "branchId", "businessDate", "productId", "sourceDailyCloseId",
        "quantity", "updatedAt"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', $4, $5, 1, CURRENT_TIMESTAMP),
        ($6, $7, $8, DATE '2030-01-01', $9, $10, 1, CURRENT_TIMESTAMP)`,
      [
        ids.itemA,
        ids.orgA,
        ids.branchA,
        ids.productA,
        ids.closeA,
        ids.itemB,
        ids.orgB,
        ids.branchB,
        ids.productB,
        ids.closeB,
      ]
    );
    await ownerClient!.query(
      `INSERT INTO "restaurant_labour_cost_facts" (
        "id", "organizationId", "branchId", "businessDate", "labourHours", "labourCost", "source", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', 8, 100, 'import', $4),
        ($5, $6, $7, DATE '2030-01-01', 8, 100, 'import', $4)`,
      [ids.labourA, ids.orgA, ids.branchA, `labour-${suffix}`, ids.labourB, ids.orgB, ids.branchB]
    );

    normalizedIdentifierProof = (
      await ownerClient!.query<{ kind: string; organizations: number; rows: number }>(
        `SELECT "kind"::text AS kind,
                COUNT(DISTINCT "organizationId")::int AS organizations,
                COUNT(*)::int AS rows
           FROM "restaurant_customer_identifiers"
          WHERE "normalizedValue" = ANY($1::text[])
          GROUP BY "kind"
          ORDER BY "kind"`,
        [[`shared-${suffix}@example.test`, `+1555${suffix.slice(0, 8)}`]]
      )
    ).rows;

    await ownerClient!.query('COMMIT');
    await runtimeClient!.query('BEGIN');
    await runtimeClient!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await runtimeClient!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
      ids.orgA,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (runtimeClient) {
      await runtimeClient.query('ROLLBACK');
      await runtimeClient.end();
    }
    if (ownerClient) {
      await ownerClient.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
      await ownerClient.query(`DELETE FROM "organizations" WHERE "id" IN ($1, $2)`, [
        ids.orgA,
        ids.orgB,
      ]);
      await ownerClient.end();
    }
  });

  it('records the owner and proves the runtime is LOGIN NOSUPERUSER NOBYPASSRLS', async () => {
    expect(connectionProof).toHaveLength(2);
    expect(connectionProof[0]).toMatchObject({
      connection: 'owner',
    });
    expect(connectionProof[1]).toMatchObject({
      connection: 'runtime',
      role: 'devfathom_local_runtime',
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
      database: connectionProof[0].database,
    });
    expect(
      (
        await runtimeClient!.query<{
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          `SELECT rolcanlogin, rolsuper, rolbypassrls
             FROM pg_catalog.pg_roles
            WHERE rolname = current_user`
        )
      ).rows
    ).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

    const metadata = await runtimeClient!.query<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
      commands: string[];
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity AS enabled,
              table_row.relforcerowsecurity AS forced,
              array_to_json(array_agg(DISTINCT policy_row.polcmd ORDER BY policy_row.polcmd)) AS commands
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = table_row.oid
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        GROUP BY table_row.relname, table_row.relrowsecurity, table_row.relforcerowsecurity
        ORDER BY table_row.relname`,
      [[...M8_TABLES]]
    );
    expect(metadata.rows).toEqual(
      [...M8_TABLES].sort().map((table_name) => ({
        table_name,
        enabled: true,
        forced: true,
        commands: (APPEND_ONLY as readonly string[]).includes(table_name) ? ['a', 'r'] : ['*'],
      }))
    );
  });

  it.each(M8_TABLES)('%s shows tenant A and hides tenant B', async (table) => {
    const [idA, idB] = rowIds[table];
    const visible = await runtimeClient!.query<{ id: string; organizationId: string }>(
      `SELECT "id", "organizationId" FROM "${table}" WHERE "id" IN ($1, $2)`,
      [idA, idB]
    );
    expect(visible.rows).toEqual([{ id: idA, organizationId: ids.orgA }]);
    expect(
      (
        await runtimeClient!.query(
          `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
          [idB]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await runtimeClient!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [idB])).rowCount
    ).toBe(0);
  });

  it('allows tenant A customer inserts and rejects cross-tenant writes', async () => {
    const customerId = `m8_customer_write_${suffix}`;

    await runtimeClient!.query(
      `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Tenant A Write', CURRENT_TIMESTAMP)`,
      [customerId, ids.orgA]
    );

    await expectDatabaseError('42501', () =>
      runtimeClient!.query(
        `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, 'Tenant B Write', CURRENT_TIMESTAMP)`,
        [`m8_customer_cross_tenant_${suffix}`, ids.orgB]
      )
    );
    await expectDatabaseError('42501', () =>
      runtimeClient!.query(
        `UPDATE "restaurant_customers" SET "organizationId" = $1 WHERE "id" = $2`,
        [ids.orgB, customerId]
      )
    );

    expect(
      (
        await runtimeClient!.query<{ id: string; organizationId: string }>(
          `SELECT "id", "organizationId" FROM "restaurant_customers" WHERE "id" = $1`,
          [customerId]
        )
      ).rows
    ).toEqual([{ id: customerId, organizationId: ids.orgA }]);
  });

  it('enforces normalized EMAIL and PHONE uniqueness per organization only', async () => {
    expect(normalizedIdentifierProof).toEqual([
      { kind: 'EMAIL', organizations: 2, rows: 2 },
      { kind: 'PHONE', organizations: 2, rows: 2 },
    ]);
    for (const [kind, value] of [
      ['EMAIL', `shared-${suffix}@example.test`],
      ['PHONE', `+1555${suffix.slice(0, 8)}`],
    ] as const) {
      await expectDatabaseError('23505', () =>
        runtimeClient!.query(
          `INSERT INTO "restaurant_customer_identifiers" (
            "id", "organizationId", "customerId", "kind", "normalizedValue", "updatedAt"
          ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
          [`m8_duplicate_${kind.toLowerCase()}_${suffix}`, ids.orgA, ids.customerA, kind, value]
        )
      );
    }
  });

  it.each(APPEND_ONLY)('%s denies UPDATE and DELETE on tenant A own row', async (table) => {
    const ownId = rowIds[table][0];
    expect(
      (await runtimeClient!.query(`SELECT "id" FROM "${table}" WHERE "id" = $1`, [ownId])).rowCount
    ).toBe(1);
    expect(
      (
        await runtimeClient!.query(
          `UPDATE "${table}" SET "createdAt" = "createdAt" WHERE "id" = $1`,
          [ownId]
        )
      ).rowCount
    ).toBe(0);
    expect(
      (await runtimeClient!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [ownId])).rowCount
    ).toBe(0);
  });

  it('rejects UPDATE and DELETE of tenant A effective loyalty version', async () => {
    await expectDatabaseError('55000', () =>
      runtimeClient!.query(
        `UPDATE "restaurant_loyalty_program_versions" SET "earnRate" = 2 WHERE "id" = $1`,
        [ids.programA]
      )
    );
    await expectDatabaseError('55000', () =>
      runtimeClient!.query(`DELETE FROM "restaurant_loyalty_program_versions" WHERE "id" = $1`, [
        ids.programA,
      ])
    );
  });
});
