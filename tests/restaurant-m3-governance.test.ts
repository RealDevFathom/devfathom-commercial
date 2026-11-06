import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.WHA910_TEST_RUNTIME_DATABASE_URL ?? '';
const ownerUrl = process.env.WHA910_TEST_OWNER_DATABASE_URL ?? '';
// Skipped, never silently passed, until both URLs name a disposable database.
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
if (runtimeUrl && runtimeUrl === ownerUrl)
  throw new Error('Runtime and owner database URLs must differ');
const client = new pg.Client({ connectionString: runtimeUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

const BASE_RESTAURANT_TABLES = [
  'restaurant_branches',
  'restaurant_branch_assignments',
  'restaurant_staff_profiles',
  'restaurant_operator_credentials',
  'restaurant_registered_devices',
  'restaurant_terminal_sessions',
  'restaurant_co_authorizations',
] as const;

// M4 (orders, kitchen, floor) tables. Kept as a flat allowlist alongside the base set so the
// table-pinning probe fails deliberately whenever the restaurant schema grows without review.
const M4_TABLES = [
  'restaurant_orders',
  'restaurant_order_items',
  'restaurant_order_item_modifiers',
  'restaurant_order_tables',
  'restaurant_order_events',
  'restaurant_order_idempotency_keys',
  'restaurant_order_number_sequences',
  'restaurant_event_outbox',
  'restaurant_kitchen_tickets',
  'restaurant_kitchen_ticket_items',
  'restaurant_kitchen_stations',
  'restaurant_station_routing_rules',
  'restaurant_floors',
  'restaurant_tables',
  'restaurant_server_sections',
  'restaurant_server_section_tables',
  'restaurant_server_section_assignments',
] as const;

// M5 (money: bills, tenders, payments, refunds, drawers, daily close, receipt
// numbering, money idempotency) tables. Flat allowlist alongside the earlier
// sets so the table-pinning probe fails deliberately whenever the restaurant
// schema grows without review (directive 7).
const M5_TABLES = [
  'restaurant_bills',
  'restaurant_bill_lines',
  'restaurant_payments',
  'restaurant_payment_events',
  'restaurant_tenders',
  'restaurant_refunds',
  'restaurant_drawer_sessions',
  'restaurant_drawer_movements',
  'restaurant_daily_closes',
  'restaurant_daily_close_tender_totals',
  'restaurant_receipt_number_sequences',
  'restaurant_money_idempotency_keys',
] as const;

// M6 (inventory & purchasing: stock locations, the stockable-ingredient seam,
// the append-only movement ledger, batches, counts, transfers, low-stock rules,
// suppliers, purchase orders, receiving, discrepancies, and the inventory
// idempotency replay domain) tables. Flat allowlist alongside the earlier sets
// so the table-pinning probe fails deliberately whenever the restaurant schema
// grows without review (directive 7). Every M6 table shipped in M6-L1 is listed
// here — the WHA-51 "complete allowlist" contract: a new table without a listing,
// or a listed table not shipped, fails the pin below.
const M6_TABLES = [
  'restaurant_stock_locations',
  'restaurant_stock_items',
  'restaurant_stock_movements',
  'restaurant_stock_batches',
  'restaurant_stock_counts',
  'restaurant_stock_count_lines',
  'restaurant_stock_transfers',
  'restaurant_stock_transfer_lines',
  'restaurant_low_stock_rules',
  'restaurant_suppliers',
  'restaurant_purchase_orders',
  'restaurant_purchase_order_lines',
  'restaurant_purchase_receipts',
  'restaurant_purchase_receipt_lines',
  'restaurant_receiving_discrepancies',
  'restaurant_inventory_idempotency_keys',
] as const;

// M7 (scheduler primitive + append-only execution history, webhook inbox, SOP
// templates/versions/steps, branch assignments, dated occurrences + per-step
// completion, append-only evidence/verification/escalation events, escalation
// policies/steps, notifications + channel-setting matrix + append-only
// deliveries) tables. Flat allowlist alongside the earlier sets so the
// table-pinning probe fails deliberately whenever the restaurant schema grows
// without review (directive 7). Every M7 table shipped in M7-L1 is listed here —
// the WHA-51 "complete allowlist" contract: a new table without a listing, or a
// listed table not shipped, fails the pin below.
const M7_TABLES = [
  'restaurant_jobs',
  'restaurant_job_executions',
  'restaurant_webhook_inbox',
  'restaurant_sop_templates',
  'restaurant_sop_template_versions',
  'restaurant_sop_template_steps',
  'restaurant_sop_assignments',
  'restaurant_sop_occurrences',
  'restaurant_sop_occurrence_steps',
  'restaurant_sop_evidence',
  'restaurant_sop_verifications',
  'restaurant_sop_escalation_policies',
  'restaurant_sop_escalation_steps',
  'restaurant_sop_escalation_events',
  'restaurant_notifications',
  'restaurant_notification_channel_settings',
  'restaurant_notification_deliveries',
] as const;

// SOP-1 (WHA-224): restaurant job roles, staff role membership/audit records,
// and capability grants. Exact list keeps the WHA-51 complete allowlist pin
// aligned with the tables shipped by the SOP job-role assignment migration.
// M8 customer identity/consent, loyalty ledger, insight projections and
// restricted labour-cost seam. Exact list keeps generic restaurant governance
// fail-closed when a table is added without an explicit review.
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

// M3 tax core (WHA-156/WHA-159): immutable official-source, profile/rule,
// transaction and rate-bucket snapshots. These tables are intentional members
// of the complete restaurant schema established by the accepted tax lineage.
const TAX_CORE_TABLES = [
  'restaurant_tax_official_sources',
  'restaurant_tax_profile_versions',
  'restaurant_tax_rule_versions',
  'restaurant_tax_transaction_snapshots',
  'restaurant_tax_rate_bucket_snapshots',
  'restaurant_tax_tender_allocation_snapshots',
  'restaurant_tax_refund_allocations',
] as const;

// R-lane (WHA-194): OCR menu import — upload, per-page extraction and the review
// queue that gates catalog creation. Listed here under the same WHA-51 complete
// allowlist contract as every set above: a new restaurant table that is not
// listed, or a listed table that is not shipped, fails the pin below.
const MENU_IMPORT_TABLES = [
  'restaurant_menu_imports',
  'restaurant_menu_import_pages',
  'restaurant_menu_import_lines',
] as const;

// B-wave job roles: B0/SOP-1 (WHA-224, integrated by WHA-284) shipped the job-role
// record, its capabilities, the staff↔role holding, the per-person capability
// overrides and the append-only membership trail; B1 (WHA-285) added the
// append-only trail for those overrides. Listed here under the same WHA-51
// complete allowlist contract as every set above — the first five were shipped
// without a listing, which is why this pin was already red before B1.
const JOB_ROLE_TABLES = [
  'restaurant_job_roles',
  'restaurant_job_role_capabilities',
  'restaurant_staff_job_roles',
  'restaurant_staff_capability_grants',
  'restaurant_staff_job_role_audits',
  'restaurant_staff_capability_audits',
] as const;

// Completion wave (WHA-229): branch-scoped staff shift scheduling. One table,
// listed here under the same WHA-51 "complete allowlist" contract as every
// milestone above — a new restaurant table without a listing, or a listed table
// that was never shipped, fails the pin below.
// WHA-257 cameras: gateway, device, credential and stream-grant records for the
// branch camera console. Listed under the same WHA-51 complete allowlist
// contract as every set above.
const CAMERA_TABLES = [
  'restaurant_camera_gateways',
  'restaurant_cameras',
  'restaurant_camera_credentials',
  'restaurant_camera_stream_grants',
] as const;

// WHA-238 terminal payments: the per-branch provider configuration and the
// append-only reconciliation records its webhook inbox writes.
const TERMINAL_PAYMENT_TABLES = [
  'restaurant_terminal_provider_configs',
  'restaurant_terminal_reconciliations',
] as const;

const DELIVERY_AND_PRINT_TABLES = [
  'restaurant_customer_addresses',
  'restaurant_delivery_fulfillments',
  'restaurant_delivery_zones',
  'restaurant_print_jobs',
  'restaurant_print_routes',
] as const;

const CATERING_TABLES = [
  'restaurant_catering_orders',
  'restaurant_catering_order_lines',
  'restaurant_catering_extra_costs',
  'restaurant_catering_deliveries',
  'restaurant_catering_events',
  'restaurant_catering_branch_capacity',
  'restaurant_catering_quote_revisions',
  'restaurant_catering_quote_approvals',
  'restaurant_catering_dispositions',
  'restaurant_catering_commands',
  'restaurant_catering_money_evidence',
] as const;

// October 8 review and sandbox migrations; every new table remains tenant scoped.
const GROWTH_TABLES = [
  'restaurant_growth_reviews',
  'restaurant_growth_drafts',
  'restaurant_growth_fixtures',
  'restaurant_growth_attempts',
  'restaurant_growth_receipt_events',
] as const;

// SAFE-05 adds pharmacy tables outside the restaurant closed-world prefix, but
// pins them here as required by the shared schema-governance gate.
const SAFE05_PHARMACY_TABLES = [
  'pharmacy_pack_authentication_events',
  'pharmacy_pack_authentication_scans',
] as const;

// WHA-288 promotions: the promotion record and its immutable versions, the rule
// components, the deterministic evaluation/candidate/application snapshots, the
// per-unit allocations, and the cap counters plus their reservations.
const PROMOTION_TABLES = [
  'restaurant_promotions',
  'restaurant_promotion_versions',
  'restaurant_promotion_rule_components',
  'restaurant_promotion_evaluation_snapshots',
  'restaurant_promotion_candidate_snapshots',
  'restaurant_promotion_application_snapshots',
  'restaurant_promotion_bill_application_snapshots',
  'restaurant_promotion_unit_allocations',
  'restaurant_promotion_cap_counters',
  'restaurant_promotion_cap_reservations',
  'restaurant_promotion_audit_events',
] as const;

const COMPLETION_WAVE_TABLES = ['restaurant_shifts'] as const;
const FINAL_CORRECTION_TABLES = [
  'restaurant_activation_acknowledgements',
  'restaurant_notification_webhooks',
  'restaurant_recipe_line_substitutes',
  'restaurant_service_charge_policy_versions',
  'restaurant_shift_breaks',
  'restaurant_shift_swap_requests',
  'restaurant_shift_swap_decisions',
  'restaurant_shift_events',
  'restaurant_time_adjustments',
  'restaurant_workforce_commands',
] as const;
// 20261014000000_print_bridge_enrollment_only and
// 20261014010000_printer_inventory_foundation; both forced-RLS tenant tables.
const PRINTER_TABLES = ['restaurant_print_bridge_enrollment_codes', 'restaurant_printers'] as const;
// 20261019213000_restaurant_wallet_passes (L2 wallet lane); all forced-RLS tenant tables.
const WALLET_TABLES = [
  'restaurant_wallet_enrollment_attempts',
  'restaurant_wallet_enrollment_links',
  'restaurant_wallet_pass_registrations',
  'restaurant_wallet_pass_updates',
  'restaurant_wallet_passes',
  'restaurant_wallet_tenant_config',
] as const;

// MED-06 (WHA-1339): this governance file is also the cross-lane registration
// point for newly introduced tenant tables. These remain outside the restaurant
// closed-world prefix assertion below, but their forced-RLS posture is pinned.
const PHARMACY_REFERENCE_CONNECTOR_TABLES = [
  'pharmacy_reference_connectors',
  'pharmacy_reference_connector_runs',
  'pharmacy_reference_connector_proposals',
] as const;

// WHA-1338 adds pharmacy tables rather than restaurant tables, so they do not
// belong in the restaurant-only name allowlist below. They are still pinned in
// this closed-world governance suite and must all carry forced RLS.
const PHARMACY_CUSTOMER_ORDERING_TABLES = [
  'pharmacy_customer_orders',
  'pharmacy_customer_order_lines',
  'pharmacy_customer_order_events',
] as const;

// H1 (hospitality) registers its tenant tables here as a closed world over the
// `hotel_` prefix, re-derived from `prisma/schema.prisma`: a later hotel lane
// that adds a table without listing it fails this pin deliberately, and every
// listed table must carry ENABLE + FORCE RLS.
const HOSPITALITY_TABLES = [
  'hotel_beds',
  'hotel_confirmation_sequences',
  'hotel_extras',
  'hotel_folio_entries',
  'hotel_folio_payments',
  'hotel_folios',
  'hotel_function_spaces',
  'hotel_guests',
  'hotel_housekeeping_tasks',
  'hotel_journey_templates',
  'hotel_meal_plans',
  'hotel_operation_idempotency_keys',
  'hotel_properties',
  'hotel_property_assignments',
  'hotel_rate_plan_prices',
  'hotel_rate_plans',
  'hotel_reservation_stay_units',
  'hotel_reservations',
  'hotel_room_blocks',
  'hotel_room_status_events',
  'hotel_room_types',
  'hotel_rooms',
  'hotel_space_bookings',
] as const;

const M3_COLUMNS = {
  restaurant_brands: [
    'id',
    'organizationId',
    'name',
    'nameLocalized',
    'status',
    'isDefault',
    'createdAt',
    'updatedAt',
  ],
  restaurant_categories: [
    'id',
    'organizationId',
    'parentId',
    'name',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_products: [
    'id',
    'organizationId',
    'categoryId',
    'type',
    'status',
    'name',
    'nameLocalized',
    'description',
    'descriptionLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_product_variants: [
    'id',
    'organizationId',
    'productId',
    'name',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_modifier_groups: [
    'id',
    'organizationId',
    'name',
    'nameLocalized',
    'minSelect',
    'maxSelect',
    'createdAt',
    'updatedAt',
  ],
  restaurant_modifier_options: [
    'id',
    'organizationId',
    'modifierGroupId',
    'name',
    'nameLocalized',
    'priceDelta',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_product_modifier_groups: [
    'id',
    'organizationId',
    'productId',
    'modifierGroupId',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_combo_component_groups: [
    'id',
    'organizationId',
    'comboProductId',
    'name',
    'nameLocalized',
    'minChoose',
    'maxChoose',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_combo_component_options: [
    'id',
    'organizationId',
    'componentGroupId',
    'productId',
    'variantId',
    'priceDelta',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_units: ['id', 'organizationId', 'name', 'abbreviation', 'createdAt', 'updatedAt'],
  restaurant_unit_conversions: [
    'id',
    'organizationId',
    'fromUnitId',
    'toUnitId',
    'factor',
    'createdAt',
    'updatedAt',
  ],
  restaurant_allergens: ['id', 'organizationId', 'name', 'nameLocalized', 'createdAt', 'updatedAt'],
  restaurant_product_allergens: ['id', 'organizationId', 'productId', 'allergenId', 'createdAt'],
  restaurant_ingredient_allergens: [
    'id',
    'organizationId',
    'ingredientId',
    'allergenId',
    'createdAt',
  ],
  restaurant_ingredients: [
    'id',
    'organizationId',
    'name',
    'nameLocalized',
    'baseUnitId',
    'referenceCost',
    'createdAt',
    'updatedAt',
  ],
  restaurant_recipes: [
    'id',
    'organizationId',
    'productId',
    'variantId',
    'name',
    'createdAt',
    'updatedAt',
  ],
  restaurant_recipe_versions: [
    'id',
    'organizationId',
    'recipeId',
    'versionNumber',
    'status',
    'yieldQuantity',
    'yieldUnitId',
    'portionCount',
    'notes',
    'activatedAt',
    'supersededAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_recipe_lines: [
    'id',
    'organizationId',
    'recipeVersionId',
    'ingredientId',
    'subRecipeId',
    'quantity',
    'unitId',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_price_lists: ['id', 'organizationId', 'name', 'isDefault', 'createdAt', 'updatedAt'],
  restaurant_price_list_versions: [
    'id',
    'organizationId',
    'priceListId',
    'versionNumber',
    'effectiveFrom',
    'status',
    'activatedAt',
    'supersededAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_price_list_entries: [
    'id',
    'organizationId',
    'priceListVersionId',
    'productId',
    'variantId',
    'price',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menus: [
    'id',
    'organizationId',
    'brandId',
    'name',
    'nameLocalized',
    'description',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_sections: [
    'id',
    'organizationId',
    'menuId',
    'name',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_items: [
    'id',
    'organizationId',
    'sectionId',
    'productId',
    'variantId',
    'displayName',
    'nameLocalized',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ],
  restaurant_branch_menu_publications: [
    'id',
    'organizationId',
    'branchId',
    'menuId',
    'priceListId',
    'status',
    'channels',
    'publishedAt',
    'retiredAt',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_availability_windows: [
    'id',
    'organizationId',
    'publicationId',
    'menuItemId',
    'label',
    'daysOfWeek',
    'startMinutes',
    'endMinutes',
    'createdAt',
    'updatedAt',
  ],
  restaurant_menu_availability_exceptions: [
    'id',
    'organizationId',
    'publicationId',
    'date',
    'isClosed',
    'label',
    'createdAt',
    'updatedAt',
  ],
  restaurant_branch_menu_item_overrides: [
    'id',
    'organizationId',
    'publicationId',
    'menuItemId',
    'isAvailable',
    'priceOverride',
    'createdAt',
    'updatedAt',
  ],
} as const;

type M3Table = keyof typeof M3_COLUMNS;
const M3_TABLES = Object.keys(M3_COLUMNS) as M3Table[];
const CANONICAL_TABLES = M3_TABLES.filter(
  (table) =>
    ![
      'restaurant_branch_menu_publications',
      'restaurant_menu_availability_windows',
      'restaurant_menu_availability_exceptions',
      'restaurant_branch_menu_item_overrides',
    ].includes(table)
);

async function readM3Columns() {
  const result = await client!.query<{ table_name: M3Table; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [M3_TABLES]
  );
  return Object.fromEntries(
    M3_TABLES.map((table) => [
      table,
      result.rows.filter((row) => row.table_name === table).map((row) => row.column_name),
    ])
  ) as Record<M3Table, string[]>;
}

describeIfDatabase('M3 schema governance (real PostgreSQL)', () => {
  beforeAll(async () => {
    const parsed = new URL(runtimeUrl);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) &&
      process.env.ALLOW_REMOTE_RLS_TEST !== 'true'
    ) {
      throw new Error('Refusing to run M3 governance probes against a non-local database.');
    }
    await client.connect();
  }, 60_000);

  afterAll(async () => {
    await client.end();
  });

  it('pins the complete restaurant table and M3 column allowlists', async () => {
    const tables = await client!.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name LIKE 'restaurant\_%' ESCAPE '\\'
        ORDER BY table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      [
        ...BASE_RESTAURANT_TABLES,
        ...M3_TABLES,
        ...M4_TABLES,
        ...M5_TABLES,
        ...M6_TABLES,
        ...M7_TABLES,
        ...M8_TABLES,
        ...TAX_CORE_TABLES,
        ...MENU_IMPORT_TABLES,
        ...JOB_ROLE_TABLES,

        ...CAMERA_TABLES,
        ...TERMINAL_PAYMENT_TABLES,
        ...DELIVERY_AND_PRINT_TABLES,
        ...CATERING_TABLES,
        ...GROWTH_TABLES,
        ...PROMOTION_TABLES,
        ...COMPLETION_WAVE_TABLES,
        ...FINAL_CORRECTION_TABLES,
        ...PRINTER_TABLES,
        ...WALLET_TABLES,
      ].sort()
    );

    expect(await readM3Columns()).toEqual(M3_COLUMNS);
  });

  it('pins SAFE-05 tables and requires forced RLS', async () => {
    const rows = await client!.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[])
        ORDER BY c.relname`,
      [[...SAFE05_PHARMACY_TABLES]]
    );
    expect(rows.rows).toEqual(
      SAFE05_PHARMACY_TABLES.map((table_name) => ({
        table_name,
        relrowsecurity: true,
        relforcerowsecurity: true,
      }))
    );
  });

  it('registers MED-06 connector tables with enabled and forced RLS', async () => {
    const tables = await client!.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT table_row.relname, table_row.relrowsecurity, table_row.relforcerowsecurity
         FROM pg_catalog.pg_class table_row
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_row.relnamespace
        WHERE namespace.nspname = 'public' AND table_row.relname = ANY($1::text[])
        ORDER BY table_row.relname`,
      [PHARMACY_REFERENCE_CONNECTOR_TABLES]
    );
    expect(tables.rows).toEqual(
      [...PHARMACY_REFERENCE_CONNECTOR_TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      }))
    );
  });

  it('pins the pharmacy customer-order tables under forced RLS', async () => {
    const result = await client!.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind = 'r'
          AND relname = ANY($1::text[])
        ORDER BY relname`,
      [[...PHARMACY_CUSTOMER_ORDERING_TABLES]]
    );
    expect(result.rows).toEqual(
      [...PHARMACY_CUSTOMER_ORDERING_TABLES]
        .sort()
        .map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true }))
    );
  });

  it('pins the hospitality tables as a closed world under forced RLS', async () => {
    const tables = await client!.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name LIKE 'hotel\_%' ESCAPE '\\'
        ORDER BY table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([...HOSPITALITY_TABLES].sort());

    const posture = await client!.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relkind = 'r'
          AND relname = ANY($1::text[])
        ORDER BY relname`,
      [[...HOSPITALITY_TABLES]]
    );
    expect(posture.rows).toEqual(
      [...HOSPITALITY_TABLES]
        .sort()
        .map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true }))
    );
  });

  it('keeps canonical tables branch-free and publication children publication-owned', async () => {
    const columns = await readM3Columns();
    for (const table of CANONICAL_TABLES) {
      expect(columns[table], table).not.toContain('branchId');
      expect(columns[table], table).not.toContain('branch_id');
    }

    expect(
      columns.restaurant_menu_availability_windows.filter((column) => column.endsWith('Id'))
    ).toEqual(['organizationId', 'publicationId', 'menuItemId']);
    expect(
      columns.restaurant_menu_availability_exceptions.filter((column) => column.endsWith('Id'))
    ).toEqual(['organizationId', 'publicationId']);
    expect(
      columns.restaurant_branch_menu_item_overrides.filter((column) => column.endsWith('Id'))
    ).toEqual(['organizationId', 'publicationId', 'menuItemId']);
  });

  it('limits branch item overrides to availability and price data', async () => {
    const columns = await readM3Columns();
    const linkageAndMetadata = new Set([
      'id',
      'organizationId',
      'publicationId',
      'menuItemId',
      'createdAt',
      'updatedAt',
    ]);
    expect(
      columns.restaurant_branch_menu_item_overrides.filter(
        (column) => !linkageAndMetadata.has(column)
      )
    ).toEqual(['isAvailable', 'priceOverride']);
  });

  it('requires tenant-safe publication ownership and canonical references', async () => {
    const result = await client!.query<{
      table_name: string;
      columns: string[];
      referenced_table: string;
      referenced_columns: string[];
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `SELECT child.relname AS table_name,
              array_agg(child_column.attname::text ORDER BY key.ordinality) AS columns,
              parent.relname AS referenced_table,
              array_agg(parent_column.attname::text ORDER BY key.ordinality) AS referenced_columns,
              constraint_row.condeferrable,
              constraint_row.condeferred
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class child ON child.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_class parent ON parent.oid = constraint_row.confrelid
         JOIN pg_catalog.pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
         JOIN pg_catalog.pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
         CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
           WITH ORDINALITY AS key(child_attnum, parent_attnum, ordinality)
         JOIN pg_catalog.pg_attribute child_column
           ON child_column.attrelid = constraint_row.conrelid
          AND child_column.attnum = key.child_attnum
         JOIN pg_catalog.pg_attribute parent_column
           ON parent_column.attrelid = constraint_row.confrelid
          AND parent_column.attnum = key.parent_attnum
        WHERE constraint_row.contype = 'f'
          AND child_namespace.nspname = 'public'
          AND parent_namespace.nspname = 'public'
          AND child.relname = ANY($1::text[])
        GROUP BY child.relname, parent.relname, constraint_row.oid,
                 constraint_row.condeferrable, constraint_row.condeferred`,
      [
        [
          'restaurant_branch_menu_publications',
          'restaurant_menu_availability_windows',
          'restaurant_menu_availability_exceptions',
          'restaurant_branch_menu_item_overrides',
        ],
      ]
    );
    const composite = result.rows.filter((row) => row.columns.length === 2);
    const signatures = composite.map(
      (row) =>
        `${row.table_name}(${row.columns.join(',')})->${row.referenced_table}(${row.referenced_columns.join(',')})`
    );
    expect(signatures).toEqual(
      expect.arrayContaining([
        'restaurant_branch_menu_publications(organizationId,branchId)->restaurant_branches(organizationId,id)',
        'restaurant_branch_menu_publications(organizationId,menuId)->restaurant_menus(organizationId,id)',
        'restaurant_branch_menu_publications(organizationId,priceListId)->restaurant_price_lists(organizationId,id)',
        'restaurant_menu_availability_windows(organizationId,publicationId)->restaurant_branch_menu_publications(organizationId,id)',
        'restaurant_menu_availability_windows(organizationId,menuItemId)->restaurant_menu_items(organizationId,id)',
        'restaurant_menu_availability_exceptions(organizationId,publicationId)->restaurant_branch_menu_publications(organizationId,id)',
        'restaurant_branch_menu_item_overrides(organizationId,publicationId)->restaurant_branch_menu_publications(organizationId,id)',
        'restaurant_branch_menu_item_overrides(organizationId,menuItemId)->restaurant_menu_items(organizationId,id)',
      ])
    );
    expect(composite.every((row) => row.condeferrable && row.condeferred)).toBe(true);
  });

  it('enforces one default brand under concurrent insert attempts', async () => {
    const index = await client!.query<{ indisunique: boolean; predicate: string | null }>(
      `SELECT index_row.indisunique,
              pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
         FROM pg_catalog.pg_index index_row
         JOIN pg_catalog.pg_class table_row ON table_row.oid = index_row.indrelid
         JOIN pg_catalog.pg_class index_name ON index_name.oid = index_row.indexrelid
         JOIN pg_catalog.pg_namespace table_namespace ON table_namespace.oid = table_row.relnamespace
         JOIN pg_catalog.pg_namespace index_namespace ON index_namespace.oid = index_name.relnamespace
        WHERE table_namespace.nspname = 'public'
          AND index_namespace.nspname = 'public'
          AND table_row.relname = 'restaurant_brands'
          AND index_name.relname = 'restaurant_brands_organizationId_default_key'`
    );
    expect(index.rows).toEqual([{ indisunique: true, predicate: '"isDefault"' }]);

    const first = new pg.Client({ connectionString: runtimeUrl });
    const second = new pg.Client({ connectionString: runtimeUrl });
    const organizationId = `org_m3_default_${suffix}`;
    let firstConnected = false;
    let secondConnected = false;
    let firstTransaction = false;
    let secondTransaction = false;
    let fixtureInserted = false;
    let secondAttempt: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;

    try {
      await first.connect();
      firstConnected = true;
      await second.connect();
      secondConnected = true;
      await first.query('BEGIN');
      firstTransaction = true;
      await second.query('BEGIN');
      secondTransaction = true;
      await Promise.all([
        first.query(`SELECT set_config('app.is_platform_admin', 'true', true)`),
        second.query(`SELECT set_config('app.is_platform_admin', 'true', true)`),
      ]);
      await first.query(
        `INSERT INTO "restaurant_brands" (
          "id", "organizationId", "name", "isDefault", "updatedAt"
        ) VALUES ($1, $2, 'Default A', true, CURRENT_TIMESTAMP)`,
        [`brand_default_a_${suffix}`, organizationId]
      );
      fixtureInserted = true;
      const secondBackend = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      secondAttempt = second
        .query(
          `INSERT INTO "restaurant_brands" (
            "id", "organizationId", "name", "isDefault", "updatedAt"
          ) VALUES ($1, $2, 'Default B', true, CURRENT_TIMESTAMP)`,
          [`brand_default_b_${suffix}`, organizationId]
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );

      const waitDeadline = Date.now() + 5_000;
      let lastWaitEvent: string | null = null;
      let lockObserved = false;
      while (Date.now() < waitDeadline) {
        const activity = await client!.query<{
          wait_event_type: string | null;
          wait_event: string | null;
        }>(
          `SELECT wait_event_type, wait_event
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [secondBackend.rows[0]!.pid]
        );
        lastWaitEvent = activity.rows[0]?.wait_event ?? null;
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          lockObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!lockObserved) {
        throw new Error(
          `Second default-brand insert did not wait on a lock within 5000ms (last event: ${lastWaitEvent ?? 'none'})`
        );
      }

      await first.query('COMMIT');
      firstTransaction = false;

      expect(await secondAttempt).toMatchObject({ ok: false, error: { code: '23505' } });
      secondAttempt = undefined;
    } finally {
      if (firstConnected && firstTransaction) {
        const rolledBack = await first.query('ROLLBACK').then(
          () => true,
          () => false
        );
        if (!rolledBack) {
          await first.end().catch(() => undefined);
          firstConnected = false;
        }
        firstTransaction = false;
      }
      if (secondAttempt) {
        await secondAttempt;
        secondAttempt = undefined;
      }
      if (secondConnected && secondTransaction) {
        await second.query('ROLLBACK').catch(() => undefined);
        secondTransaction = false;
      }

      let cleanupError: unknown;
      if (fixtureInserted) {
        try {
          await client!.query('BEGIN');
          await client!.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
          await client!.query(`DELETE FROM "restaurant_brands" WHERE "organizationId" = $1`, [
            organizationId,
          ]);
          await client!.query('COMMIT');
        } catch (error) {
          cleanupError = error;
          await client!.query('ROLLBACK').catch(() => undefined);
        }
      }

      const closed = await Promise.allSettled([
        ...(firstConnected ? [first.end()] : []),
        ...(secondConnected ? [second.end()] : []),
      ]);
      const closeError = closed.find((result) => result.status === 'rejected');
      if (cleanupError) throw cleanupError;
      if (closeError?.status === 'rejected') throw closeError.reason;
    }
  }, 20_000);
});
