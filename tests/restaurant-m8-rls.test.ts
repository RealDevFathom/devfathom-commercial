import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `m8_rls_${suffix}`;

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
  'restaurant_insight_loyalty_liability_rollups',
  'restaurant_insight_daily_rollups',
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
  liabilityA: `m8_liability_a_${suffix}`,
  liabilityB: `m8_liability_b_${suffix}`,
  dailyA: `m8_daily_a_${suffix}`,
  dailyB: `m8_daily_b_${suffix}`,
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
  restaurant_insight_loyalty_liability_rollups: [ids.liabilityA, ids.liabilityB],
  restaurant_insight_daily_rollups: [ids.dailyA, ids.dailyB],
  restaurant_insight_item_mix_rollups: [ids.itemA, ids.itemB],
  restaurant_labour_cost_facts: [ids.labourA, ids.labourB],
};

let normalizedIdentifierProof: Array<{ kind: string; organizations: number; rows: number }> = [];

async function expectDatabaseError(code: string, run: () => Promise<unknown>) {
  await client!.query('SAVEPOINT expected_failure');
  try {
    await run();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client!.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client!.query('RELEASE SAVEPOINT expected_failure');
  }
}

describeIfDatabase('M8 cross-tenant RLS probes (real PostgreSQL)', () => {
  beforeAll(async () => {
    const hostname = new URL(TEST_DATABASE_URL!).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      throw new Error('Refusing to run M8 RLS probes against a non-local database.');
    }

    await client!.connect();
    await client!.query('BEGIN');
    await client!.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client!.query(`GRANT "${role}" TO CURRENT_USER`);
    await client!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client!.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${M8_TABLES.map((table) => `"${table}"`).join(', ')} TO "${role}"`
    );
    await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client!.query(
      `INSERT INTO "organizations" (
        "id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt"
      ) VALUES
        ($1, $2, 'M8 Tenant A', 'M8 Tenant A', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'M8 Tenant B', 'M8 Tenant B', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `m8-a-${suffix}`, ids.orgB, `m8-b-${suffix}`]
    );

    // These probes target RLS only; foreign-key parents belong to downstream lanes.
    await client!.query(`SET LOCAL session_replication_role = 'replica'`);
    await client!.query(
      `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt") VALUES
        ($1, $2, 'Tenant A Customer', CURRENT_TIMESTAMP),
        ($3, $4, 'Tenant B Customer', CURRENT_TIMESTAMP)`,
      [ids.customerA, ids.orgA, ids.customerB, ids.orgB]
    );
    await client!.query(
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
    await client!.query(
      `INSERT INTO "restaurant_customer_interactions" (
        "id", "organizationId", "customerId", "branchId", "orderId", "type", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, $4, $5, 'ORDER', $6),
        ($7, $8, $9, $10, $11, 'ORDER', $6)`,
      [
        ids.interactionA,
        ids.orgA,
        ids.customerA,
        `m8_branch_a_${suffix}`,
        `m8_order_a_${suffix}`,
        `interaction-${suffix}`,
        ids.interactionB,
        ids.orgB,
        ids.customerB,
        `m8_branch_b_${suffix}`,
        `m8_order_b_${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_customer_tags" ("id", "organizationId", "name", "updatedAt") VALUES
        ($1, $2, 'Regular', CURRENT_TIMESTAMP), ($3, $4, 'Regular', CURRENT_TIMESTAMP)`,
      [ids.tagA, ids.orgA, ids.tagB, ids.orgB]
    );
    await client!.query(
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
    await client!.query(
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
    await client!.query(
      `INSERT INTO "restaurant_loyalty_program_versions" (
        "id", "organizationId", "versionNumber", "effectiveFrom", "earnRate", "redemptionValue", "updatedAt"
      ) VALUES
        ($1, $2, 1, clock_timestamp() - interval '1 minute', 1, 0.01, clock_timestamp()),
        ($3, $4, 1, clock_timestamp() - interval '1 minute', 1, 0.01, clock_timestamp())`,
      [ids.programA, ids.orgA, ids.programB, ids.orgB]
    );
    await client!.query(
      `INSERT INTO "restaurant_loyalty_accounts" ("id", "organizationId", "customerId", "updatedAt") VALUES
        ($1, $2, $3, CURRENT_TIMESTAMP), ($4, $5, $6, CURRENT_TIMESTAMP)`,
      [ids.accountA, ids.orgA, ids.customerA, ids.accountB, ids.orgB, ids.customerB]
    );
    await client!.query(
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
    await client!.query(
      `INSERT INTO "restaurant_insight_loyalty_liability_rollups" (
        "id", "organizationId", "businessDate", "liability", "updatedAt"
      ) VALUES
        ($1, $2, DATE '2030-01-01', 1.25, CURRENT_TIMESTAMP),
        ($3, $4, DATE '2030-01-01', 2.50, CURRENT_TIMESTAMP)`,
      [ids.liabilityA, ids.orgA, ids.liabilityB, ids.orgB]
    );
    await client!.query(
      `INSERT INTO "restaurant_insight_daily_rollups" (
        "id", "organizationId", "branchId", "businessDate", "sourceDailyCloseId",
        "loyaltyLiabilityRollupId", "updatedAt"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', $4, $5, CURRENT_TIMESTAMP),
        ($6, $7, $8, DATE '2030-01-01', $9, $10, CURRENT_TIMESTAMP)`,
      [
        ids.dailyA,
        ids.orgA,
        `m8_branch_a_${suffix}`,
        `m8_close_a_${suffix}`,
        ids.liabilityA,
        ids.dailyB,
        ids.orgB,
        `m8_branch_b_${suffix}`,
        `m8_close_b_${suffix}`,
        ids.liabilityB,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_insight_item_mix_rollups" (
        "id", "organizationId", "branchId", "businessDate", "productId", "sourceDailyCloseId",
        "quantity", "updatedAt"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', $4, $5, 1, CURRENT_TIMESTAMP),
        ($6, $7, $8, DATE '2030-01-01', $9, $10, 1, CURRENT_TIMESTAMP)`,
      [
        ids.itemA,
        ids.orgA,
        `m8_branch_a_${suffix}`,
        `m8_product_a_${suffix}`,
        `m8_close_a_${suffix}`,
        ids.itemB,
        ids.orgB,
        `m8_branch_b_${suffix}`,
        `m8_product_b_${suffix}`,
        `m8_close_b_${suffix}`,
      ]
    );
    await client!.query(
      `INSERT INTO "restaurant_labour_cost_facts" (
        "id", "organizationId", "branchId", "businessDate", "labourHours", "labourCost", "source", "idempotencyKey"
      ) VALUES
        ($1, $2, $3, DATE '2030-01-01', 8, 100, 'import', $4),
        ($5, $6, $7, DATE '2030-01-01', 8, 100, 'import', $4)`,
      [
        ids.labourA,
        ids.orgA,
        `m8_branch_a_${suffix}`,
        `labour-${suffix}`,
        ids.labourB,
        ids.orgB,
        `m8_branch_b_${suffix}`,
      ]
    );
    await client!.query(`SET LOCAL session_replication_role = 'origin'`);

    normalizedIdentifierProof = (
      await client!.query<{ kind: string; organizations: number; rows: number }>(
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

    await client!.query(`SET LOCAL ROLE "${role}"`);
    await client!.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    await client!.query(`SELECT set_config('app.current_organization_id', $1, true)`, [ids.orgA]);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  it('proves unprivileged NOBYPASSRLS role and exact policy metadata on all M8 tables', async () => {
    expect(
      (
        await client!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1`,
          [role]
        )
      ).rows
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    const metadata = await client!.query<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
      commands: string[];
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity AS enabled,
              table_row.relforcerowsecurity AS forced,
              array_agg(DISTINCT policy_row.polcmd::text ORDER BY policy_row.polcmd::text) AS commands
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
    const visible = await client!.query<{ id: string; organizationId: string }>(
      `SELECT "id", "organizationId" FROM "${table}" WHERE "id" IN ($1, $2)`,
      [idA, idB]
    );
    expect(visible.rows).toEqual([{ id: idA, organizationId: ids.orgA }]);
    expect(
      (
        await client!.query(
          `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "id" = $1`,
          [idB]
        )
      ).rowCount
    ).toBe(0);
    expect((await client!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [idB])).rowCount).toBe(0);
  });

  it('allows tenant A customer inserts and rejects cross-tenant writes', async () => {
    const customerId = `m8_customer_write_${suffix}`;

    await client!.query(
      `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt")
       VALUES ($1, $2, 'Tenant A Write', CURRENT_TIMESTAMP)`,
      [customerId, ids.orgA]
    );

    await expectDatabaseError('42501', () =>
      client!.query(
        `INSERT INTO "restaurant_customers" ("id", "organizationId", "displayName", "updatedAt")
         VALUES ($1, $2, 'Tenant B Write', CURRENT_TIMESTAMP)`,
        [`m8_customer_cross_tenant_${suffix}`, ids.orgB]
      )
    );
    await expectDatabaseError('42501', () =>
      client!.query(`UPDATE "restaurant_customers" SET "organizationId" = $1 WHERE "id" = $2`, [
        ids.orgB,
        customerId,
      ])
    );

    expect(
      (
        await client!.query<{ id: string; organizationId: string }>(
          `SELECT "id", "organizationId" FROM "restaurant_customers" WHERE "id" = $1`,
          [customerId]
        )
      ).rows
    ).toEqual([{ id: customerId, organizationId: ids.orgA }]);
  });

  it('rejects a cross-tenant daily-to-liability composite reference', async () => {
    await expectDatabaseError('23503', async () => {
      await client!.query(
        `UPDATE "restaurant_insight_daily_rollups"
            SET "loyaltyLiabilityRollupId" = $1
          WHERE "id" = $2`,
        [ids.liabilityB, ids.dailyA]
      );
      await client!.query(`SET CONSTRAINTS "tenant_insight_daily_loyalty_fact_fk" IMMEDIATE`);
    });
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
        client!.query(
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
      (await client!.query(`SELECT "id" FROM "${table}" WHERE "id" = $1`, [ownId])).rowCount
    ).toBe(1);
    expect(
      (
        await client!.query(`UPDATE "${table}" SET "createdAt" = "createdAt" WHERE "id" = $1`, [
          ownId,
        ])
      ).rowCount
    ).toBe(0);
    expect((await client!.query(`DELETE FROM "${table}" WHERE "id" = $1`, [ownId])).rowCount).toBe(
      0
    );
  });

  it('rejects UPDATE and DELETE of tenant A effective loyalty version', async () => {
    await expectDatabaseError('55000', () =>
      client!.query(
        `UPDATE "restaurant_loyalty_program_versions" SET "earnRate" = 2 WHERE "id" = $1`,
        [ids.programA]
      )
    );
    await expectDatabaseError('55000', () =>
      client!.query(`DELETE FROM "restaurant_loyalty_program_versions" WHERE "id" = $1`, [
        ids.programA,
      ])
    );
  });
});
