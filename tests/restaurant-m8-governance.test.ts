import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthzDb } from '@/lib/authz';
import { can } from '@/lib/abac';
import { ALL_ACTIONS, POLICIES, type Action } from '@/lib/abac/policies';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const M8_COLUMNS = {
  restaurant_customers: [
    'id',
    'organizationId',
    'displayName',
    'givenName',
    'familyName',
    'birthDate',
    'notes',
    'anonymizedAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_customer_identifiers: [
    'id',
    'organizationId',
    'customerId',
    'kind',
    'normalizedValue',
    'verifiedAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_customer_interactions: [
    'id',
    'organizationId',
    'customerId',
    'branchId',
    'orderId',
    'type',
    'payload',
    'occurredAt',
    'idempotencyKey',
    'createdAt',
  ],
  restaurant_customer_tags: ['id', 'organizationId', 'name', 'color', 'createdAt', 'updatedAt'],
  restaurant_customer_tag_assignments: ['id', 'organizationId', 'customerId', 'tagId', 'createdAt'],
  restaurant_customer_consents: [
    'id',
    'organizationId',
    'customerId',
    'channel',
    'granted',
    'source',
    'actorId',
    'policyVersion',
    'occurredAt',
    'idempotencyKey',
    'createdAt',
  ],
  restaurant_loyalty_program_versions: [
    'id',
    'organizationId',
    'versionNumber',
    'effectiveFrom',
    'earnRate',
    'redemptionValue',
    'expiryDays',
    'createdAt',
    'updatedAt',
  ],
  restaurant_loyalty_accounts: [
    'id',
    'organizationId',
    'customerId',
    'active',
    'enrolledAt',
    'deactivatedAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_loyalty_points_entries: [
    'id',
    'organizationId',
    'accountId',
    'programVersionId',
    'kind',
    'points',
    'billId',
    'refundId',
    'reversesEntryId',
    'actorId',
    'reason',
    'expiresAt',
    'occurredAt',
    'idempotencyKey',
    'createdAt',
  ],
  restaurant_insight_daily_rollups: [
    'id',
    'organizationId',
    'branchId',
    'businessDate',
    'sourceDailyCloseId',
    'orderCount',
    'coverCount',
    'grossSales',
    'netSales',
    'compTotal',
    'refundTotal',
    'voidTotal',
    'drawerVariance',
    'loyaltyLiability',
    'computedAt',
    'createdAt',
    'updatedAt',
    'projectionVersion',
    'deliveryFeeSales',
    'deliveryFeeRefunds',
  ],
  restaurant_insight_loyalty_liabilities: [
    'id',
    'organizationId',
    'businessDate',
    'cutoffAt',
    'programVersionId',
    'redemptionValue',
    'positivePoints',
    'signedPoints',
    'liability',
    'projectionVersion',
    'computedAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_insight_item_mix_rollups: [
    'id',
    'organizationId',
    'branchId',
    'businessDate',
    'productId',
    'sourceDailyCloseId',
    'quantity',
    'grossSales',
    'netSales',
    'compTotal',
    'computedAt',
    'createdAt',
    'updatedAt',
    'projectionVersion',
  ],
  restaurant_labour_cost_facts: [
    'id',
    'organizationId',
    'branchId',
    'businessDate',
    'labourHours',
    'labourCost',
    'source',
    'idempotencyKey',
    'importedAt',
    'createdAt',
  ],
} as const;

type M8Table = keyof typeof M8_COLUMNS;
const M8_TABLES = Object.keys(M8_COLUMNS) as M8Table[];
const APPEND_ONLY = [
  'restaurant_customer_interactions',
  'restaurant_customer_consents',
  'restaurant_loyalty_points_entries',
  'restaurant_labour_cost_facts',
] as const;

const ENUMS = [
  ['CustomerIdentifierKind', ['EMAIL', 'PHONE', 'WALLET']],
  ['CustomerConsentChannel', ['EMAIL', 'SMS', 'PHONE', 'WHATSAPP', 'PUSH']],
  ['LoyaltyPointsEntryKind', ['EARN', 'REDEEM', 'REVERSAL', 'EXPIRY', 'ADJUSTMENT']],
] as const;

const INDEXES: Record<string, { unique: boolean; columns: string[]; predicate?: RegExp }> = {
  restaurant_customers_organizationId_idx: { unique: false, columns: ['organizationId'] },
  restaurant_customers_anonymizedAt_idx: { unique: false, columns: ['anonymizedAt'] },
  restaurant_customer_identifiers_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_customer_identifiers_customerId_idx: { unique: false, columns: ['customerId'] },
  // 20261019213000_restaurant_wallet_passes (L2): at most one WALLET identifier per customer.
  restaurant_customer_identifiers_active_wallet_key: {
    unique: true,
    columns: ['organizationId', 'customerId'],
    predicate: /wallet_identifier_kind_text\(kind\) = 'WALLET'/,
  },
  restaurant_customer_identifiers_org_kind_value_key: {
    unique: true,
    columns: ['organizationId', 'kind', 'normalizedValue'],
  },
  restaurant_customer_interactions_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_customer_interactions_customer_time_idx: {
    unique: false,
    columns: ['customerId', 'occurredAt'],
  },
  restaurant_customer_interactions_branch_time_idx: {
    unique: false,
    columns: ['branchId', 'occurredAt'],
  },
  restaurant_customer_interactions_orderId_idx: { unique: false, columns: ['orderId'] },
  restaurant_customer_interactions_org_idempotency_key: {
    unique: true,
    columns: ['organizationId', 'idempotencyKey'],
  },
  restaurant_customer_tags_organizationId_idx: { unique: false, columns: ['organizationId'] },
  restaurant_customer_tags_org_name_key: {
    unique: true,
    columns: ['organizationId', 'lower(btrim(name))'],
  },
  restaurant_customer_tag_assignments_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_customer_tag_assignments_tagId_idx: { unique: false, columns: ['tagId'] },
  restaurant_customer_tag_assignments_customer_tag_key: {
    unique: true,
    columns: ['customerId', 'tagId'],
  },
  restaurant_customer_consents_organizationId_idx: { unique: false, columns: ['organizationId'] },
  restaurant_customer_consents_customer_channel_time_idx: {
    unique: false,
    columns: ['customerId', 'channel', 'occurredAt'],
  },
  restaurant_customer_consents_org_idempotency_key: {
    unique: true,
    columns: ['organizationId', 'idempotencyKey'],
  },
  restaurant_loyalty_program_versions_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_loyalty_program_versions_effectiveFrom_idx: {
    unique: false,
    columns: ['effectiveFrom'],
  },
  restaurant_loyalty_program_versions_org_version_key: {
    unique: true,
    columns: ['organizationId', 'versionNumber'],
  },
  restaurant_loyalty_program_versions_org_effective_key: {
    unique: true,
    columns: ['organizationId', 'effectiveFrom'],
  },
  restaurant_loyalty_accounts_customerId_key: { unique: true, columns: ['customerId'] },
  restaurant_loyalty_accounts_org_customer_key: {
    unique: true,
    columns: ['organizationId', 'customerId'],
  },
  restaurant_loyalty_accounts_organizationId_idx: { unique: false, columns: ['organizationId'] },
  restaurant_loyalty_accounts_active_idx: { unique: false, columns: ['active'] },
  restaurant_loyalty_points_entries_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_loyalty_points_entries_account_time_idx: {
    unique: false,
    columns: ['accountId', 'occurredAt'],
  },
  restaurant_loyalty_points_entries_programVersionId_idx: {
    unique: false,
    columns: ['programVersionId'],
  },
  restaurant_loyalty_points_entries_billId_idx: { unique: false, columns: ['billId'] },
  restaurant_loyalty_points_entries_refundId_idx: { unique: false, columns: ['refundId'] },
  restaurant_loyalty_points_entries_reversesEntryId_idx: {
    unique: false,
    columns: ['reversesEntryId'],
  },
  restaurant_loyalty_points_entries_org_idempotency_key: {
    unique: true,
    columns: ['organizationId', 'idempotencyKey'],
  },
  restaurant_loyalty_points_entries_bill_earn_key: {
    unique: true,
    columns: ['organizationId', 'billId'],
    predicate: /kind = 'EARN'.*billId IS NOT NULL/,
  },
  restaurant_insight_daily_rollups_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_insight_daily_rollups_sourceDailyCloseId_idx: {
    unique: false,
    columns: ['sourceDailyCloseId'],
  },
  restaurant_insight_daily_rollups_org_branch_date_key: {
    unique: true,
    columns: ['organizationId', 'branchId', 'businessDate'],
  },
  restaurant_insight_loyalty_liabilities_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_insight_loyalty_liabilities_programVersionId_idx: {
    unique: false,
    columns: ['programVersionId'],
  },
  restaurant_insight_loyalty_liabilities_org_date_key: {
    unique: true,
    columns: ['organizationId', 'businessDate'],
  },
  restaurant_insight_item_mix_rollups_organizationId_idx: {
    unique: false,
    columns: ['organizationId'],
  },
  restaurant_insight_item_mix_rollups_productId_idx: { unique: false, columns: ['productId'] },
  restaurant_insight_item_mix_rollups_sourceCloseId_idx: {
    unique: false,
    columns: ['sourceDailyCloseId'],
  },
  restaurant_insight_item_mix_rollups_org_branch_date_product_key: {
    unique: true,
    columns: ['organizationId', 'branchId', 'businessDate', 'productId'],
  },
  restaurant_labour_cost_facts_organizationId_idx: { unique: false, columns: ['organizationId'] },
  restaurant_labour_cost_facts_branch_date_idx: {
    unique: false,
    columns: ['branchId', 'businessDate'],
  },
  restaurant_labour_cost_facts_org_idempotency_key: {
    unique: true,
    columns: ['organizationId', 'idempotencyKey'],
  },
};

const UNIQUE_CONSTRAINTS = {
  restaurant_customers_organizationId_id_key: ['organizationId', 'id'],
  restaurant_customer_tags_organizationId_id_key: ['organizationId', 'id'],
  restaurant_loyalty_program_versions_org_id_key: ['organizationId', 'id'],
  restaurant_loyalty_accounts_organizationId_id_key: ['organizationId', 'id'],
  restaurant_loyalty_points_entries_org_id_key: ['organizationId', 'id'],
} as const;

const CHECK_CONSTRAINTS = {
  restaurant_customer_identifiers_normalized_ck:
    /normalizedValue.*btrim.*normalizedValue.*<> ''.*kind.*EMAIL.*lower/,
  restaurant_customer_interactions_values_ck: /btrim.*type.*<> ''.*btrim.*idempotencyKey.*<> ''/,
  restaurant_customer_tags_name_ck: /btrim.*name.*<> ''/,
  restaurant_customer_consents_provenance_ck: /source.*actorId.*policyVersion.*idempotencyKey/,
  restaurant_loyalty_program_versions_values_ck:
    /versionNumber.*>= 1.*earnRate.*>= \(0\)::numeric.*redemptionValue.*> \(0\)::numeric.*expiryDays IS NULL.*expiryDays.*>= 1/,
  restaurant_loyalty_accounts_active_ck: /active.*deactivatedAt.*IS NULL/,
  restaurant_loyalty_points_entries_points_ck:
    /EARN.*points.*> 0.*billId.*IS NOT NULL.*REDEEM.*points.*< 0.*billId.*IS NOT NULL.*REVERSAL.*EXPIRY.*points.*< 0.*ADJUSTMENT.*points.*<> 0/,
  restaurant_loyalty_points_entries_reference_ck:
    /REVERSAL.*refundId.*IS NOT NULL.*reversesEntryId.*IS NOT NULL.*EXPIRY.*reversesEntryId.*IS NOT NULL.*ADJUSTMENT.*actorId.*reason.*idempotencyKey/,
  restaurant_insight_daily_rollups_counts_ck: /orderCount.*>= 0.*coverCount.*>= 0/,
  restaurant_insight_daily_rollups_delivery_fees_nonneg_ck:
    /deliveryFeeSales.*>= \(0\)::numeric.*deliveryFeeRefunds.*>= \(0\)::numeric/,
  restaurant_insight_item_mix_rollups_quantity_ck: /quantity.*>= 0/,
  restaurant_labour_cost_facts_values_ck:
    /labourHours.*>= \(0\)::numeric.*labourCost.*>= \(0\)::numeric.*source.*idempotencyKey/,
} as const;

const normalize = (value: string) => value.replaceAll('"', '').replaceAll(/\s+/g, ' ').trim();

describe('M8 source governance', () => {
  it('pins five typed ABAC actions with empty static policies and default deny', async () => {
    const actions = [
      'customers:read',
      'loyalty:redeem',
      'reports:financial',
      'workforce:rates',
      'restaurant:configure',
    ] as const satisfies readonly Action[];
    const db = {
      user: { findUnique: async () => ({ organizationRole: null, permissionOverrides: [] }) },
    } as unknown as AuthzDb;

    for (const action of actions) {
      expect(ALL_ACTIONS).toContain(action);
      expect(POLICIES[action]).toEqual([]);
    }
    await expect(
      can(
        { id: 'm8-governance', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
        'workforce:rates',
        undefined,
        { db }
      )
    ).resolves.toBe(false);
  });

  it('keeps ordinary insight rollups free of labour fields', () => {
    for (const table of [
      'restaurant_insight_daily_rollups',
      'restaurant_insight_item_mix_rollups',
    ] as const) {
      expect(M8_COLUMNS[table].some((column) => /labou?r|wage|payroll/i.test(column))).toBe(false);
    }
  });

  it('keeps generic schema and tenant-isolation verification explicit for all 13 tables', () => {
    const genericGovernance = readFileSync(
      resolve('tests/restaurant-m3-governance.test.ts'),
      'utf8'
    );
    const verifier = readFileSync(resolve('scripts/verify-tenant-isolation.ts'), 'utf8');
    const genericM8Tables = genericGovernance
      .match(/const M8_TABLES = \[([\s\S]*?)\] as const;/)?.[1]
      .match(/'restaurant_[^']+'/g)
      ?.map((table) => table.slice(1, -1));

    expect(genericM8Tables).toEqual(M8_TABLES);
    expect(genericM8Tables).toHaveLength(13);
    expect(genericGovernance).toContain("table_name LIKE 'restaurant\\_%'");
    for (const table of M8_TABLES) {
      expect(verifier).toContain(`INSERT INTO "${table}"`);
      expect(verifier).toContain(`['${table}',`);
    }
  });
});

describeIfDatabase('M8 schema governance (real PostgreSQL)', () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    const hostname = new URL(TEST_DATABASE_URL!).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      throw new Error('Refusing to run M8 governance probes against a non-local database.');
    }
    await client.connect();
  }, 60_000);

  afterAll(async () => client.end());

  it('pins all 12 table column allowlists in ordinal order', async () => {
    const result = await client.query<{ table_name: M8Table; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [M8_TABLES]
    );
    expect(
      Object.fromEntries(
        M8_TABLES.map((table) => [
          table,
          result.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
        ])
      )
    ).toEqual(M8_COLUMNS);
  });

  it.each(ENUMS)('pins exact %s values', async (typeName, expected) => {
    const result = await client.query<{ enumlabel: string }>(
      `SELECT enum_row.enumlabel
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
         JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
        WHERE namespace_row.nspname = 'public' AND type_row.typname = $1
        ORDER BY enum_row.enumsortorder`,
      [typeName]
    );
    expect(result.rows.map(({ enumlabel }) => enumlabel)).toEqual(expected);
  });

  it('pins complete non-constraint index inventory, columns, uniqueness, and predicates', async () => {
    const result = await client.query<{
      index_name: string;
      is_unique: boolean;
      columns: string[];
      predicate: string | null;
    }>(
      `SELECT index_row.relname AS index_name,
              index_meta.indisunique AS is_unique,
              ARRAY(
                SELECT pg_get_indexdef(index_meta.indexrelid, position, false)
                  FROM generate_series(1, index_meta.indnkeyatts) AS position
                 ORDER BY position
              ) AS columns,
              pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate
         FROM pg_catalog.pg_index index_meta
         JOIN pg_catalog.pg_class table_row ON table_row.oid = index_meta.indrelid
         JOIN pg_catalog.pg_class index_row ON index_row.oid = index_meta.indexrelid
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND table_row.relname = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint constraint_row
             WHERE constraint_row.conindid = index_meta.indexrelid
          )
        ORDER BY index_row.relname`,
      [M8_TABLES]
    );
    expect(result.rows.map(({ index_name }) => index_name)).toEqual(Object.keys(INDEXES).sort());
    for (const row of result.rows) {
      const expected = INDEXES[row.index_name]!;
      expect(row.is_unique, row.index_name).toBe(expected.unique);
      expect(row.columns.map(normalize), row.index_name).toEqual(expected.columns);
      if (expected.predicate)
        expect(normalize(row.predicate ?? ''), row.index_name).toMatch(expected.predicate);
      else expect(row.predicate, row.index_name).toBeNull();
    }
  });

  it('pins complete unique and check constraint inventories and definitions', async () => {
    const result = await client.query<{
      name: string;
      kind: 'c' | 'u';
      columns: string[] | null;
      definition: string;
    }>(
      `SELECT constraint_row.conname AS name,
              constraint_row.contype AS kind,
              CASE WHEN constraint_row.contype = 'u' THEN ARRAY(
                SELECT pg_get_indexdef(constraint_row.conindid, position, false)
                  FROM generate_series(1, array_length(constraint_row.conkey, 1)) AS position
                 ORDER BY position
              ) END AS columns,
              pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class table_row ON table_row.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND table_row.relname = ANY($1::text[])
          AND constraint_row.contype IN ('c', 'u')
        ORDER BY constraint_row.conname`,
      [M8_TABLES]
    );
    expect(result.rows.map(({ name }) => name)).toEqual(
      [...Object.keys(UNIQUE_CONSTRAINTS), ...Object.keys(CHECK_CONSTRAINTS)].sort()
    );
    for (const row of result.rows) {
      if (row.kind === 'u') {
        expect(row.columns?.map(normalize), row.name).toEqual(
          UNIQUE_CONSTRAINTS[row.name as keyof typeof UNIQUE_CONSTRAINTS]
        );
      } else {
        expect(normalize(row.definition), row.name).toMatch(
          CHECK_CONSTRAINTS[row.name as keyof typeof CHECK_CONSTRAINTS]
        );
      }
    }
  });

  it('pins ENABLE plus FORCE RLS and mutable versus append-only commands', async () => {
    const result = await client.query<{
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
      [M8_TABLES]
    );
    // Ordinary tenants remain append-only; only the exact demo-reset DELETE is admitted.
    const resetPolicies = await client.query(
      `SELECT tablename, policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
          AND (policyname = 'restaurant_demo_reset_delete' OR cmd IN ('DELETE', 'ALL'))
        ORDER BY tablename, policyname`,
      [APPEND_ONLY]
    );
    expect(
      resetPolicies.rows.map((row) => ({
        ...row,
        // Match the catalog rendering already pinned by the demo-reset guard.
        qual: row.qual?.replace(/^public\./, ''),
      }))
    ).toEqual(
      [...APPEND_ONLY].sort().map((tablename) => ({
        tablename,
        policyname: 'restaurant_demo_reset_delete',
        cmd: 'DELETE',
        permissive: 'PERMISSIVE',
        roles: ['public'],
        qual: 'restaurant_demo_reset_allowed("organizationId")',
        with_check: null,
      }))
    );

    expect(result.rows).toEqual(
      [...M8_TABLES].sort().map((table_name) => ({
        table_name,
        enabled: true,
        forced: true,
        commands: (APPEND_ONLY as readonly string[]).includes(table_name) ? ['a', 'd', 'r'] : ['*'],
      }))
    );
  });

  it('rejects UPDATE and DELETE of an effective loyalty version', async () => {
    const id = `m8_governance_${Date.now()}`;
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL app.is_platform_admin = 'true'`);
      await client.query(
        `INSERT INTO "restaurant_loyalty_program_versions" (
          "id", "organizationId", "versionNumber", "effectiveFrom", "earnRate",
          "redemptionValue", "updatedAt"
        ) VALUES ($1, 'org_devfathom', 2147483647, clock_timestamp() - interval '1 minute',
          1, 0.01, clock_timestamp())`,
        [id]
      );
      for (const [savepoint, sql] of [
        [
          'immutable_update',
          `UPDATE "restaurant_loyalty_program_versions" SET "earnRate" = 2 WHERE "id" = $1`,
        ],
        ['immutable_delete', `DELETE FROM "restaurant_loyalty_program_versions" WHERE "id" = $1`],
      ] as const) {
        await client.query(`SAVEPOINT ${savepoint}`);
        await expect(client.query(sql, [id])).rejects.toMatchObject({ code: '55000' });
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
