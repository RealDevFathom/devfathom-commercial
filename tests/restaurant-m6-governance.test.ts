import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const client = TEST_DATABASE_URL ? new pg.Client({ connectionString: TEST_DATABASE_URL }) : null;

const M6_COLUMNS = {
  restaurant_stock_locations: [
    'id',
    'organizationId',
    'branchId',
    'name',
    'code',
    'isActive',
    'createdAt',
    'updatedAt',
  ],
  restaurant_stock_items: [
    'id',
    'organizationId',
    'ingredientId',
    'canonicalUnitId',
    'isActive',
    'trackBatches',
    'createdAt',
    'updatedAt',
  ],
  restaurant_stock_movements: [
    'id',
    'organizationId',
    'stockItemId',
    'locationId',
    'reason',
    'quantity',
    'unitCost',
    'occurredAt',
    'recordedAt',
    'orderId',
    'receiptId',
    'transferId',
    'countId',
    'batchId',
    'staffProfileId',
    'deviceId',
  ],
  restaurant_stock_batches: [
    'id',
    'organizationId',
    'stockItemId',
    'receiptId',
    'code',
    'expiryDate',
    'createdAt',
    'updatedAt',
  ],
  restaurant_stock_counts: [
    'id',
    'organizationId',
    'locationId',
    'status',
    'reference',
    'countedAt',
    'submittedAt',
    'postedAt',
    'staffProfileId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_stock_count_lines: [
    'id',
    'organizationId',
    'stockCountId',
    'stockItemId',
    'countedQuantity',
    'snapshotQuantity',
    'varianceQuantity',
    'createdAt',
    'updatedAt',
  ],
  restaurant_stock_transfers: [
    'id',
    'organizationId',
    'sourceLocationId',
    'destinationLocationId',
    'status',
    'reference',
    'dispatchedAt',
    'receivedAt',
    'staffProfileId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_stock_transfer_lines: [
    'id',
    'organizationId',
    'stockTransferId',
    'stockItemId',
    'quantity',
    'createdAt',
    'updatedAt',
  ],
  restaurant_low_stock_rules: [
    'id',
    'organizationId',
    'stockItemId',
    'locationId',
    'threshold',
    'createdAt',
    'updatedAt',
  ],
  restaurant_suppliers: [
    'id',
    'organizationId',
    'name',
    'code',
    'contactName',
    'contactEmail',
    'contactPhone',
    'isActive',
    'createdAt',
    'updatedAt',
  ],
  restaurant_purchase_orders: [
    'id',
    'organizationId',
    'supplierId',
    'branchId',
    'locationId',
    'status',
    'reference',
    'expectedDate',
    'submittedAt',
    'approvedAt',
    'closedAt',
    'cancelledAt',
    'createdByStaffProfileId',
    'approvedByStaffProfileId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_purchase_order_lines: [
    'id',
    'organizationId',
    'purchaseOrderId',
    'stockItemId',
    'orderedQuantity',
    'unitId',
    'unitCost',
    'createdAt',
    'updatedAt',
  ],
  restaurant_purchase_receipts: [
    'id',
    'organizationId',
    'purchaseOrderId',
    'supplierId',
    'branchId',
    'locationId',
    'reference',
    'receivedAt',
    'staffProfileId',
    'deviceId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_purchase_receipt_lines: [
    'id',
    'organizationId',
    'purchaseReceiptId',
    'purchaseOrderLineId',
    'stockItemId',
    'receivedQuantity',
    'unitId',
    'unitCost',
    'batchId',
    'createdAt',
    'updatedAt',
  ],
  restaurant_receiving_discrepancies: [
    'id',
    'organizationId',
    'purchaseReceiptId',
    'purchaseReceiptLineId',
    'stockItemId',
    'kind',
    'expectedQuantity',
    'receivedQuantity',
    'note',
    'createdAt',
    'updatedAt',
  ],
  restaurant_inventory_idempotency_keys: [
    'id',
    'organizationId',
    'key',
    'commandType',
    'resultRef',
    'deviceId',
    'createdAt',
    'updatedAt',
  ],
} as const;

const MOVEMENT_REASONS = [
  'PURCHASE_RECEIPT',
  'RECIPE_CONSUMPTION',
  'SALE_REVERSAL',
  'TRANSFER',
  'PHYSICAL_COUNT_ADJUSTMENT',
  'WASTAGE',
  'SPOILAGE',
  'STAFF_MEAL',
  'SUPPLIER_RETURN',
  'MANUAL_CORRECTION',
] as const;

type M6Table = keyof typeof M6_COLUMNS;
const M6_TABLES = Object.keys(M6_COLUMNS) as M6Table[];

describeIfDatabase('M6 schema governance (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(TEST_DATABASE_URL!);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M6 governance probes against a non-local database.');
    }
    await client!.connect();
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  it('pins all 16 M6 table column allowlists in ordinal order', async () => {
    const result = await client!.query<{ table_name: M6Table; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [M6_TABLES]
    );
    expect(
      Object.fromEntries(
        M6_TABLES.map((table) => [
          table,
          result.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
        ])
      )
    ).toEqual(M6_COLUMNS);
  });

  it('has no mutable balance or on-hand column on any M6 table', async () => {
    const result = await client!.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
          AND (
            lower(column_name) LIKE '%balance%'
            OR regexp_replace(lower(column_name), '[^a-z0-9]', '', 'g') LIKE '%onhand%'
          )
        ORDER BY table_name, ordinal_position`,
      [M6_TABLES]
    );
    expect(result.rows).toEqual([]);
  });

  it('pins the exact RestaurantStockMovementReason values', async () => {
    const result = await client!.query<{ enumlabel: string }>(
      `SELECT enum_row.enumlabel
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
         JOIN pg_catalog.pg_enum enum_row ON enum_row.enumtypid = type_row.oid
        WHERE namespace_row.nspname = 'public'
          AND type_row.typname = 'RestaurantStockMovementReason'
        ORDER BY enum_row.enumsortorder`
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual(MOVEMENT_REASONS);
  });

  it('pins ENABLE and FORCE RLS on all 16 M6 tables', async () => {
    const result = await client!.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `SELECT table_row.relname AS table_name,
              table_row.relrowsecurity AS rls_enabled,
              table_row.relforcerowsecurity AS rls_forced
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public' AND table_row.relname = ANY($1::text[])
        ORDER BY table_row.relname`,
      [M6_TABLES]
    );
    expect(result.rows).toEqual(
      [...M6_TABLES]
        .sort()
        .map((table_name) => ({ table_name, rls_enabled: true, rls_forced: true }))
    );
  });

  it('pins stock movement INSERT/SELECT and the guarded demo-reset DELETE', async () => {
    const result = await client!.query<{ command: string }>(
      `SELECT CASE policy_row.polcmd
                WHEN 'r' THEN 'SELECT'
                WHEN 'a' THEN 'INSERT'
                WHEN 'w' THEN 'UPDATE'
                WHEN 'd' THEN 'DELETE'
                ELSE 'ALL'
              END AS command
         FROM pg_catalog.pg_policy policy_row
         JOIN pg_catalog.pg_class table_row ON table_row.oid = policy_row.polrelid
         JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND table_row.relname = 'restaurant_stock_movements'
        ORDER BY command`
    );
    // Ordinary tenants remain append-only; only the exact demo-reset DELETE is admitted.
    const resetPolicies = await client!.query(
      `SELECT tablename, policyname, cmd, permissive, roles::text[] AS roles, qual, with_check
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
          AND (policyname = 'restaurant_demo_reset_delete' OR cmd IN ('DELETE', 'ALL'))
        ORDER BY tablename, policyname`,
      [['restaurant_stock_movements']]
    );
    expect(
      resetPolicies.rows.map((row) => ({
        ...row,
        // Match the catalog rendering already pinned by the demo-reset guard.
        qual: row.qual?.replace(/^public\./, ''),
      }))
    ).toEqual(
      [...['restaurant_stock_movements']].sort().map((tablename) => ({
        tablename,
        policyname: 'restaurant_demo_reset_delete',
        cmd: 'DELETE',
        permissive: 'PERMISSIVE',
        roles: ['public'],
        qual: 'restaurant_demo_reset_allowed("organizationId")',
        with_check: null,
      }))
    );

    expect(result.rows.map((row) => row.command)).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
});
