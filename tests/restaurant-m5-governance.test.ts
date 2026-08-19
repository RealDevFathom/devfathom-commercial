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

const APPEND_ONLY_TABLES = [
  'restaurant_tenders',
  'restaurant_payment_events',
  'restaurant_refunds',
  'restaurant_drawer_movements',
  'restaurant_daily_closes',
  'restaurant_daily_close_tender_totals',
] as const;

type M5Table = keyof typeof M5_COLUMNS;
const M5_TABLES = Object.keys(M5_COLUMNS) as M5Table[];

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
    ]);
  });
});
