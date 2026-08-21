import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;

const M5_COLUMNS = {
  restaurant_bills: [
    'id',
    'organizationId',
    'orderId',
    'branchId',
    'businessDate',
    'status',
    'splitKind',
    'fractionNumerator',
    'fractionDenominator',
    'subtotal',
    'taxTotal',
    'serviceChargeTotal',
    'compTotal',
    'roundingAdjustment',
    'grandTotal',
    'receiptNumber',
    'settledAt',
    'voidReason',
    'voidCoAuthorizationId',
    'openerStaffProfileId',
    'deviceId',
    'createdAt',
    'updatedAt',
    'discountTotal',
  ],
  restaurant_bill_lines: [
    'id',
    'organizationId',
    'billId',
    'orderItemId',
    'name',
    'quantity',
    'unitPrice',
    'lineSubtotal',
    'taxAmount',
    'serviceChargeAmount',
    'compAmount',
    'lineTotal',
    'compReason',
    'compCoAuthorizationId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_payments: [
    'id',
    'organizationId',
    'billId',
    'provider',
    'capability',
    'status',
    'amount',
    'tipAmount',
    'providerRef',
    'staffProfileId',
    'deviceId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_payment_events: [
    'id',
    'organizationId',
    'paymentId',
    'capability',
    'eventType',
    'amount',
    'providerRef',
    'payload',
    'createdAt',
  ],
  restaurant_tenders: [
    'id',
    'organizationId',
    'billId',
    'type',
    'amount',
    'tipAmount',
    'cashReceived',
    'changeGiven',
    'drawerSessionId',
    'paymentId',
    'businessDate',
    'staffProfileId',
    'deviceId',
    'createdAt',
  ],
  restaurant_refunds: [
    'id',
    'organizationId',
    'originalTenderId',
    'billId',
    'amount',
    'tipRefundAmount',
    'kind',
    'businessDate',
    'reason',
    'coAuthorizationId',
    'drawerSessionId',
    'paymentId',
    'staffProfileId',
    'deviceId',
    'createdAt',
  ],
  restaurant_drawer_sessions: [
    'id',
    'organizationId',
    'branchId',
    'deviceId',
    'staffProfileId',
    'businessDate',
    'status',
    'openedAt',
    'closedAt',
    'openingFloat',
    'expectedCash',
    'countedCash',
    'variance',
    'createdAt',
    'updatedAt',
  ],
  restaurant_drawer_movements: [
    'id',
    'organizationId',
    'drawerSessionId',
    'kind',
    'amount',
    'reason',
    'tenderId',
    'refundId',
    'staffProfileId',
    'deviceId',
    'createdAt',
  ],
  restaurant_daily_closes: [
    'id',
    'organizationId',
    'branchId',
    'businessDate',
    'supersedesCloseId',
    'correctionReason',
    'coAuthorizationId',
    'cutByStaffProfileId',
    'deviceId',
    'grossSales',
    'netSales',
    'taxTotal',
    'serviceChargeTotal',
    'tipTotal',
    'compTotal',
    'discountTotal',
    'refundTotal',
    'voidTotal',
    'cashExpected',
    'cashCounted',
    'cashVariance',
    'createdAt',
  ],
  restaurant_daily_close_tender_totals: [
    'id',
    'organizationId',
    'dailyCloseId',
    'tenderType',
    'amount',
    'tipAmount',
    'count',
    'createdAt',
  ],
  restaurant_receipt_number_sequences: [
    'id',
    'organizationId',
    'branchId',
    'businessDate',
    'nextNumber',
    'createdAt',
    'updatedAt',
  ],
  restaurant_money_idempotency_keys: [
    'id',
    'organizationId',
    'deviceId',
    'key',
    'commandType',
    'resultRef',
    'createdAt',
    'updatedAt',
  ],
} as const;

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

const M5_ENUMS = [
  ['RestaurantBillStatus', ['OPEN', 'SETTLED', 'VOID']],
  ['RestaurantBillSplitKind', ['NONE', 'BY_ITEM', 'BY_SEAT', 'FRACTIONAL']],
  ['RestaurantTenderType', ['CASH', 'CARD', 'OTHER']],
  ['RestaurantPaymentProvider', ['MOCK']],
  ['RestaurantPaymentCapability', ['SALE', 'AUTH', 'CAPTURE', 'ADJUST', 'VOID', 'REFUND']],
  [
    'RestaurantPaymentStatus',
    [
      'PENDING',
      'AUTHORIZED',
      'CAPTURED',
      'VOIDED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DECLINED',
      'FAILED',
    ],
  ],
  ['RestaurantRefundKind', ['REFUND', 'VOID_REVERSAL']],
  ['RestaurantDrawerSessionStatus', ['OPEN', 'CLOSED']],
  [
    'RestaurantDrawerMovementKind',
    ['OPENING_FLOAT', 'CASH_SALE', 'CASH_REFUND', 'PAID_IN', 'PAID_OUT', 'DROP', 'CLOSING_COUNT'],
  ],
] as const;

const M8_ENUMS = [
  ['CustomerIdentifierKind', ['EMAIL', 'PHONE']],
  ['CustomerConsentChannel', ['EMAIL', 'SMS', 'PHONE', 'WHATSAPP', 'PUSH']],
  ['LoyaltyPointsEntryKind', ['EARN', 'REDEEM', 'REVERSAL', 'EXPIRY', 'ADJUSTMENT']],
] as const;

const APPEND_ONLY_TABLES = [
  'restaurant_tenders',
  'restaurant_payment_events',
  'restaurant_refunds',
  'restaurant_drawer_movements',
  'restaurant_daily_closes',
  'restaurant_daily_close_tender_totals',
  // M6-L1: the append-only stock movement ledger (§11.4) — the single source of
  // stock truth, SELECT+INSERT policies only, same DB-enforced append-only shape
  // as the M5 money ledgers. A correction is a NEW movement, never an edit.
  'restaurant_stock_movements',
  // M7-L1: the five DB-enforced append-only ledgers (§11.5 / D13 / D21) — the
  // job-attempt execution history, SOP evidence, SOP verification decisions,
  // escalation events, and notification deliveries. SELECT+INSERT policies only;
  // a correction is a NEW row referencing the original context, never an edit.
  'restaurant_job_executions',
  'restaurant_sop_evidence',
  'restaurant_sop_verifications',
  'restaurant_sop_escalation_events',
  'restaurant_notification_deliveries',
  // M8-L1: customer events/consent, signed loyalty ledger, and imported labour
  // fact history are DB-enforced append-only.
  'restaurant_customer_interactions',
  'restaurant_customer_consents',
  'restaurant_loyalty_points_entries',
  'restaurant_labour_cost_facts',
] as const;

type M5Table = keyof typeof M5_COLUMNS;
const M5_TABLES = Object.keys(M5_COLUMNS) as M5Table[];
type M8Table = keyof typeof M8_COLUMNS;
const M8_TABLES = Object.keys(M8_COLUMNS) as M8Table[];
const M8_APPEND_ONLY_TABLES = [
  'restaurant_customer_interactions',
  'restaurant_customer_consents',
  'restaurant_loyalty_points_entries',
  'restaurant_labour_cost_facts',
] as const;
const M8_MUTABLE_TABLES = M8_TABLES.filter(
  (table) => !(M8_APPEND_ONLY_TABLES as readonly string[]).includes(table)
);

describeIfDatabase('M5 schema governance (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M5 governance probes against a non-local database.');
    }
    await client!.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it('pins all 12 M5 table column allowlists', async () => {
    const result = await client!.query<{ table_name: M5Table; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [M5_TABLES]
    );
    expect(
      Object.fromEntries(
        M5_TABLES.map((table) => [
          table,
          result.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
        ])
      )
    ).toEqual(M5_COLUMNS);
  });

  it('pins all 12 M8 table column allowlists', async () => {
    const result = await client!.query<{ table_name: M8Table; column_name: string }>(
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

  it.each(M5_ENUMS)('pins the exact %s values', async (typeName, expected) => {
    const result = await client!.query<{ enumlabel: string }>(
      `SELECT enum_row.enumlabel
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
         JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
        WHERE namespace_row.nspname = 'public' AND type_row.typname = $1
        ORDER BY enum_row.enumsortorder`,
      [typeName]
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual(expected);
  });

  it.each(M8_ENUMS)('pins the exact M8 %s values', async (typeName, expected) => {
    const result = await client!.query<{ enumlabel: string }>(
      `SELECT enum_row.enumlabel
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
         JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
        WHERE namespace_row.nspname = 'public' AND type_row.typname = $1
        ORDER BY enum_row.enumsortorder`,
      [typeName]
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual(expected);
  });

  it('denies app-role UPDATE and DELETE on append-only M5 tables', async () => {
    const result = await client!.query<{ table_name: string; commands: string[] }>(
      `SELECT table_row.relname AS table_name,
              array_agg(DISTINCT CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END ORDER BY CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END) AS commands
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = table_row.oid
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        GROUP BY table_row.relname
        ORDER BY table_row.relname`,
      [[...APPEND_ONLY_TABLES]]
    );
    expect(result.rows).toEqual(
      [...APPEND_ONLY_TABLES].sort().map((table_name) => ({
        table_name,
        commands: ['INSERT', 'SELECT'],
      }))
    );
  });

  it('pins forced RLS and exact M8 mutable/append-only policy shapes', async () => {
    const rls = await client!.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity,
              table_row.relforcerowsecurity
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        ORDER BY table_row.relname`,
      [M8_TABLES]
    );
    expect(rls.rows).toEqual(
      [...M8_TABLES].sort().map((table_name) => ({
        table_name,
        relrowsecurity: true,
        relforcerowsecurity: true,
      }))
    );

    const policies = await client!.query<{ table_name: string; commands: string[] }>(
      `SELECT table_row.relname AS table_name,
              array_agg(DISTINCT CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END ORDER BY CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END) AS commands
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
         JOIN pg_catalog.pg_policy policy_row ON policy_row.polrelid = table_row.oid
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        GROUP BY table_row.relname
        ORDER BY table_row.relname`,
      [M8_TABLES]
    );
    expect(policies.rows).toEqual(
      [
        ...M8_MUTABLE_TABLES.map((table_name) => ({ table_name, commands: ['ALL'] })),
        ...M8_APPEND_ONLY_TABLES.map((table_name) => ({
          table_name,
          commands: ['INSERT', 'SELECT'],
        })),
      ].sort((left, right) => left.table_name.localeCompare(right.table_name))
    );
  });

  it('pins corrected M8 loyalty and interaction database invariants', async () => {
    const constraints = await client!.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_catalog.pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [
        [
          'restaurant_loyalty_points_entries_points_ck',
          'restaurant_loyalty_points_entries_reference_ck',
        ],
      ]
    );
    const definitions = Object.fromEntries(
      constraints.rows.map(({ conname, definition }) => [conname, definition])
    );
    expect(definitions.restaurant_loyalty_points_entries_points_ck).toMatch(
      /'REDEEM'.*points < 0.*"billId" IS NOT NULL/s
    );
    expect(definitions.restaurant_loyalty_points_entries_reference_ck).toMatch(
      /"actorId" IS NOT NULL.*btrim\("actorId"\) <> ''::text.*reason IS NOT NULL.*btrim\(reason\) <> ''::text/s
    );

    const triggerFunction = await client!.query<{ definition: string }>(
      `SELECT pg_get_functiondef(routine_row.oid) AS definition
         FROM pg_catalog.pg_proc routine_row
         JOIN pg_catalog.pg_namespace namespace_row
           ON namespace_row.oid = routine_row.pronamespace
        WHERE namespace_row.nspname = 'public'
          AND routine_row.proname = 'prevent_effective_loyalty_program_version_mutation'`
    );
    expect(triggerFunction.rows[0]?.definition).toContain('clock_timestamp()');
    expect(triggerFunction.rows[0]?.definition).not.toContain('CURRENT_TIMESTAMP');

    const orderForeignKey = await client!.query<{ delete_action: string }>(
      `SELECT confdeltype AS delete_action
         FROM pg_catalog.pg_constraint
        WHERE conname = 'restaurant_customer_interactions_orderId_fkey'`
    );
    expect(orderForeignKey.rows).toEqual([{ delete_action: 'r' }]);
  });

  it('prevents UPDATE and DELETE of effective loyalty versions in the database', async () => {
    const id = `m8_effective_${Date.now()}`;
    await client!.query('BEGIN');
    try {
      await client!.query(`SET LOCAL app.is_platform_admin = 'true'`);
      await client!.query(
        `INSERT INTO "restaurant_loyalty_program_versions" (
          "id", "organizationId", "versionNumber", "effectiveFrom", "earnRate",
          "redemptionValue", "updatedAt"
        ) VALUES ($1, 'org_devfathom', 999999, CURRENT_TIMESTAMP - INTERVAL '1 minute',
          1, 0.01, CURRENT_TIMESTAMP)`,
        [id]
      );

      await client!.query('SAVEPOINT immutable_update');
      await expect(
        client!.query(
          `UPDATE "restaurant_loyalty_program_versions" SET "earnRate" = 2 WHERE "id" = $1`,
          [id]
        )
      ).rejects.toMatchObject({ code: '55000' });
      await client!.query('ROLLBACK TO SAVEPOINT immutable_update');

      await client!.query('SAVEPOINT immutable_delete');
      await expect(
        client!.query(`DELETE FROM "restaurant_loyalty_program_versions" WHERE "id" = $1`, [id])
      ).rejects.toMatchObject({ code: '55000' });
      await client!.query('ROLLBACK TO SAVEPOINT immutable_delete');
    } finally {
      await client!.query('ROLLBACK');
    }
  });

  it('uses no floating-point type in any restaurant table', async () => {
    const result = await client!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name LIKE 'restaurant\_%' ESCAPE '\\'
          AND (data_type IN ('real', 'double precision') OR udt_name IN ('float4', 'float8'))`
    );
    expect(result.rows).toEqual([]);
  });

  it('keeps restaurant order aggregates derived', async () => {
    const result = await client!.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'restaurant_orders'
        ORDER BY ordinal_position`
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'id',
      'organizationId',
      'branchId',
      'orderNumber',
      'businessDate',
      'status',
      'channel',
      'coverCount',
      'sectionId',
      'serverStaffProfileId',
      'staffProfileId',
      'deviceId',
      'publicationId',
      'priceListVersionId',
      'openedAt',
      'closedAt',
      'cancelledAt',
      'createdAt',
      'updatedAt',
      'customerId',
    ]);
  });
});
