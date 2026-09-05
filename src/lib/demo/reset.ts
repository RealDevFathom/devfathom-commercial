import 'server-only';

import { demoApproverEmail } from '@/lib/demo/approval';
import { demoSeatIdentity, type DemoSeatIdentity } from '@/lib/demo/seed-data';
import {
  rebuildDemoRestaurantSeatInTransaction,
  type DemoRestaurantSeatResult,
} from '@/lib/demo/seed-seat';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DEMO_RESET_JOB_TYPE = 'demo-reset';

// Reviewed from Prisma's mapped, organization-scoped restaurant models.
// Activation acknowledgements are bootstrap control-plane state and stay intact.
const RESTAURANT_RESET_TABLES = [
  'restaurant_allergens',
  'restaurant_bill_lines',
  'restaurant_bills',
  'restaurant_branch_assignments',
  'restaurant_branch_menu_item_overrides',
  'restaurant_branch_menu_publications',
  'restaurant_branches',
  'restaurant_brands',
  'restaurant_camera_credentials',
  'restaurant_camera_gateways',
  'restaurant_camera_stream_grants',
  'restaurant_cameras',
  'restaurant_categories',
  'restaurant_co_authorizations',
  'restaurant_combo_component_groups',
  'restaurant_combo_component_options',
  'restaurant_customer_addresses',
  'restaurant_customer_consents',
  'restaurant_customer_identifiers',
  'restaurant_customer_interactions',
  'restaurant_customer_tag_assignments',
  'restaurant_customer_tags',
  'restaurant_customers',
  'restaurant_daily_close_tender_totals',
  'restaurant_daily_closes',
  'restaurant_delivery_fulfillments',
  'restaurant_delivery_zones',
  'restaurant_drawer_movements',
  'restaurant_drawer_sessions',
  'restaurant_event_outbox',
  'restaurant_floors',
  'restaurant_ingredient_allergens',
  'restaurant_ingredients',
  'restaurant_insight_daily_rollups',
  'restaurant_insight_item_mix_rollups',
  'restaurant_insight_loyalty_liabilities',
  'restaurant_inventory_idempotency_keys',
  'restaurant_job_executions',
  'restaurant_job_role_capabilities',
  'restaurant_job_roles',
  'restaurant_jobs',
  'restaurant_kitchen_stations',
  'restaurant_kitchen_ticket_items',
  'restaurant_kitchen_tickets',
  'restaurant_labour_cost_facts',
  'restaurant_low_stock_rules',
  'restaurant_loyalty_accounts',
  'restaurant_loyalty_points_entries',
  'restaurant_loyalty_program_versions',
  'restaurant_menu_availability_exceptions',
  'restaurant_menu_availability_windows',
  'restaurant_menu_import_lines',
  'restaurant_menu_import_pages',
  'restaurant_menu_imports',
  'restaurant_menu_items',
  'restaurant_menu_sections',
  'restaurant_menus',
  'restaurant_modifier_groups',
  'restaurant_modifier_options',
  'restaurant_money_idempotency_keys',
  'restaurant_notification_channel_settings',
  'restaurant_notification_deliveries',
  'restaurant_notification_webhooks',
  'restaurant_notifications',
  'restaurant_operator_credentials',
  'restaurant_order_events',
  'restaurant_order_idempotency_keys',
  'restaurant_order_item_modifiers',
  'restaurant_order_items',
  'restaurant_order_number_sequences',
  'restaurant_order_tables',
  'restaurant_orders',
  'restaurant_payment_events',
  'restaurant_payments',
  'restaurant_price_list_entries',
  'restaurant_price_list_versions',
  'restaurant_price_lists',
  'restaurant_print_jobs',
  'restaurant_print_routes',
  'restaurant_product_allergens',
  'restaurant_product_modifier_groups',
  'restaurant_product_variants',
  'restaurant_products',
  'restaurant_promotion_application_snapshots',
  'restaurant_promotion_audit_events',
  'restaurant_promotion_bill_application_snapshots',
  'restaurant_promotion_candidate_snapshots',
  'restaurant_promotion_cap_counters',
  'restaurant_promotion_cap_reservations',
  'restaurant_promotion_evaluation_snapshots',
  'restaurant_promotion_rule_components',
  'restaurant_promotion_unit_allocations',
  'restaurant_promotion_versions',
  'restaurant_promotions',
  'restaurant_purchase_order_lines',
  'restaurant_purchase_orders',
  'restaurant_purchase_receipt_lines',
  'restaurant_purchase_receipts',
  'restaurant_receipt_number_sequences',
  'restaurant_receiving_discrepancies',
  'restaurant_recipe_line_substitutes',
  'restaurant_recipe_lines',
  'restaurant_recipe_versions',
  'restaurant_recipes',
  'restaurant_refunds',
  'restaurant_registered_devices',
  'restaurant_server_section_assignments',
  'restaurant_server_section_tables',
  'restaurant_server_sections',
  'restaurant_service_charge_policy_versions',
  'restaurant_shift_breaks',
  'restaurant_shift_events',
  'restaurant_shift_swap_decisions',
  'restaurant_shift_swap_requests',
  'restaurant_shifts',
  'restaurant_sop_assignments',
  'restaurant_sop_escalation_events',
  'restaurant_sop_escalation_policies',
  'restaurant_sop_escalation_steps',
  'restaurant_sop_evidence',
  'restaurant_sop_occurrence_steps',
  'restaurant_sop_occurrences',
  'restaurant_sop_template_steps',
  'restaurant_sop_template_versions',
  'restaurant_sop_templates',
  'restaurant_sop_verifications',
  'restaurant_staff_capability_audits',
  'restaurant_staff_capability_grants',
  'restaurant_staff_job_role_audits',
  'restaurant_staff_job_roles',
  'restaurant_staff_profiles',
  'restaurant_station_routing_rules',
  'restaurant_stock_batches',
  'restaurant_stock_count_lines',
  'restaurant_stock_counts',
  'restaurant_stock_items',
  'restaurant_stock_locations',
  'restaurant_stock_movements',
  'restaurant_stock_transfer_lines',
  'restaurant_stock_transfers',
  'restaurant_suppliers',
  'restaurant_tables',
  'restaurant_tax_official_sources',
  'restaurant_tax_profile_versions',
  'restaurant_tax_rate_bucket_snapshots',
  'restaurant_tax_refund_allocations',
  'restaurant_tax_rule_versions',
  'restaurant_tax_tender_allocation_snapshots',
  'restaurant_tax_transaction_snapshots',
  'restaurant_tenders',
  'restaurant_terminal_provider_configs',
  'restaurant_terminal_reconciliations',
  'restaurant_terminal_sessions',
  'restaurant_time_adjustments',
  'restaurant_unit_conversions',
  'restaurant_units',
  'restaurant_webhook_inbox',
  'restaurant_workforce_commands',
] as const;

const SPECIAL_TABLES = new Set<string>([
  'restaurant_job_executions',
  'restaurant_jobs',
  'restaurant_operator_credentials',
  'restaurant_staff_profiles',
]);

type LockedOrganization = {
  id: string;
  slug: string;
  isDemo: boolean;
  vertical: string;
  deploymentMode: string;
  currentOrganizationId: string | null;
  isPlatformAdmin: string | null;
};

type StaffIdentity = { id: string; userId: string | null; email: string | null; status: string };
type ForeignKey = { tableName: string; parentTable: string | null; deleteAction: string | null };
type Residual = { tableName: string; count: number };

function identityForOrganization(organizationId: string): DemoSeatIdentity {
  const match = /^org_demo_restaurant_seat_([1-9]\d*)$/.exec(organizationId);
  if (!match) throw new Error('Demo reset requires a canonical restaurant seat organization.');
  const identity = demoSeatIdentity(Number(match[1]));
  if (identity.organizationId !== organizationId) {
    throw new Error('Demo reset requires a canonical restaurant seat organization.');
  }
  return identity;
}

function assertValidDate(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Demo reset requires a valid date.');
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function dependencyCycle(remaining: Set<string>, parents: Map<string, Set<string>>): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (table: string): string[] | undefined => {
    visited.add(table);
    active.add(table);
    path.push(table);
    for (const parent of parents.get(table) ?? []) {
      if (!remaining.has(parent)) continue;
      if (active.has(parent)) return [...path.slice(path.indexOf(parent)), parent];
      if (!visited.has(parent)) {
        const cycle = visit(parent);
        if (cycle) return cycle;
      }
    }
    path.pop();
    active.delete(table);
    return undefined;
  };
  for (const table of remaining) {
    if (!visited.has(table)) {
      const cycle = visit(table);
      if (cycle) return cycle;
    }
  }
  return [...remaining];
}

async function lockAndGuardOrganization(db: ScopedDb, identity: DemoSeatIdentity): Promise<void> {
  const [organization] = await db.$queryRawUnsafe<LockedOrganization[]>(
    `SELECT organization.id,
            organization.slug,
            organization."isDemo" AS "isDemo",
            organization.vertical::text AS vertical,
            organization."deploymentMode"::text AS "deploymentMode",
            current_setting('app.current_organization_id', true) AS "currentOrganizationId",
            current_setting('app.is_platform_admin', true) AS "isPlatformAdmin"
       FROM organizations AS organization
      WHERE organization.id = $1
      FOR UPDATE OF organization`,
    identity.organizationId
  );
  if (
    !organization ||
    organization.id !== identity.organizationId ||
    organization.slug !== identity.slug ||
    !organization.isDemo ||
    organization.vertical !== 'RESTAURANT' ||
    organization.deploymentMode !== 'SHARED' ||
    organization.currentOrganizationId !== identity.organizationId ||
    organization.isPlatformAdmin !== 'false'
  ) {
    throw new Error('Demo reset requires the locked canonical SHARED restaurant tenant scope.');
  }
}

async function assertDemoStillAllowed(db: ScopedDb, identity: DemoSeatIdentity): Promise<void> {
  const [row] = await db.$queryRawUnsafe<Array<{ allowed: boolean }>>(
    `SELECT COALESCE(
       current_setting('app.current_organization_id', true) = $1
       AND current_setting('app.is_platform_admin', true) = 'false'
       AND EXISTS (
         SELECT 1 FROM organizations
          WHERE id = $1 AND slug = $2 AND "isDemo" = true
            AND vertical = 'RESTAURANT' AND "deploymentMode" = 'SHARED'
       ), false) AS allowed`,
    identity.organizationId,
    identity.slug
  );
  if (!row?.allowed) throw new Error('Demo reset authorization changed during cleanup.');
}

async function preservedStaffIds(
  db: ScopedDb,
  identity: DemoSeatIdentity
): Promise<[managerStaffProfileId: string, approverStaffProfileId: string]> {
  const approverUserId = `user_demo_restaurant_seat_${identity.seatNumber}_approver`;
  const approverEmail = demoApproverEmail(identity.seatNumber);
  const users = await db.$queryRawUnsafe<Array<{ id: string; email: string }>>(
    `SELECT id, email FROM users
      WHERE "organizationId" = $1 AND id IN ($2, $3)`,
    identity.organizationId,
    identity.managerUserId,
    approverUserId
  );
  const managerUser = users.find(
    (user) => user.id === identity.managerUserId && user.email === identity.managerEmail
  );
  const approverUser = users.find(
    (user) => user.id === approverUserId && user.email === approverEmail
  );
  if (!managerUser || !approverUser) {
    throw new Error('Demo reset requires canonical manager and approver users.');
  }

  const staff = await db.$queryRawUnsafe<StaffIdentity[]>(
    `SELECT id, "userId" AS "userId", email, status::text AS status
       FROM restaurant_staff_profiles
      WHERE "organizationId" = $1
        AND ("userId" = $2 OR ("userId" = $3 AND email = $4))`,
    identity.organizationId,
    identity.managerUserId,
    approverUserId,
    approverEmail
  );
  const managers = staff.filter(
    (profile) => profile.userId === identity.managerUserId && profile.status === 'ACTIVE'
  );
  const approvers = staff.filter(
    (profile) =>
      profile.userId === approverUserId &&
      profile.email === approverEmail &&
      profile.status === 'ACTIVE'
  );
  if (managers.length !== 1 || approvers.length !== 1 || managers[0]!.id === approvers[0]!.id) {
    throw new Error('Demo reset requires distinct active manager and approver staff profiles.');
  }
  return [managers[0]!.id, approvers[0]!.id];
}

function deletionOrder(rows: ForeignKey[]): string[] {
  const remaining = new Set<string>(RESTAURANT_RESET_TABLES);
  const parents = new Map<string, Set<string>>(
    [...remaining].map((table) => [table, new Set<string>()])
  );
  for (const row of rows) {
    if (
      row.parentTable &&
      row.parentTable !== row.tableName &&
      remaining.has(row.tableName) &&
      remaining.has(row.parentTable)
    ) {
      parents.get(row.tableName)!.add(row.parentTable);
    }
  }

  const order: string[] = [];
  while (remaining.size) {
    const children = [...remaining].filter(
      (candidate) =>
        ![...remaining].some((other) => other !== candidate && parents.get(other)?.has(candidate))
    );
    if (!children.length) {
      const cycle = dependencyCycle(remaining, parents);
      throw new Error(`Restaurant demo reset found a cross-table FK cycle: ${cycle.join(' -> ')}`);
    }
    for (const child of children) {
      order.push(child);
      remaining.delete(child);
    }
  }
  return order;
}

async function loadDeletionOrder(db: ScopedDb): Promise<string[]> {
  const values = RESTAURANT_RESET_TABLES.map((table) => `('${table}')`).join(', ');
  const rows = await db.$queryRawUnsafe<ForeignKey[]>(
    `WITH allowed("tableName") AS (VALUES ${values})
     SELECT allowed."tableName" AS "tableName",
            parent.relname AS "parentTable",
            constraint_row.confdeltype::text AS "deleteAction"
       FROM allowed
       JOIN pg_class AS child
         ON child.relname = allowed."tableName"
        AND child.relnamespace = 'public'::regnamespace
       LEFT JOIN pg_constraint AS constraint_row
         ON constraint_row.conrelid = child.oid AND constraint_row.contype = 'f'
       LEFT JOIN pg_class AS parent ON parent.oid = constraint_row.confrelid`
  );
  const present = new Set(rows.map((row) => row.tableName));
  const missing = RESTAURANT_RESET_TABLES.filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Restaurant demo reset table allowlist is out of sync: ${missing.join(', ')}`);
  }
  return deletionOrder(rows);
}

async function guardedDelete(
  db: ScopedDb,
  identity: DemoSeatIdentity,
  statement: string,
  ...parameters: unknown[]
): Promise<void> {
  await assertDemoStillAllowed(db, identity);
  await db.$executeRawUnsafe(statement, ...parameters);
}

async function clearRestaurantData(
  db: ScopedDb,
  identity: DemoSeatIdentity,
  managerStaffProfileId: string,
  approverStaffProfileId: string
): Promise<void> {
  const order = await loadDeletionOrder(db);
  for (const table of order) {
    if (table === 'restaurant_job_executions') {
      await guardedDelete(
        db,
        identity,
        `DELETE FROM restaurant_job_executions AS execution
          USING restaurant_jobs AS job
          WHERE execution."organizationId" = $1
            AND job."organizationId" = $1
            AND execution."jobId" = job.id
            AND job.type <> $2`,
        identity.organizationId,
        DEMO_RESET_JOB_TYPE
      );
    } else if (table === 'restaurant_jobs') {
      await guardedDelete(
        db,
        identity,
        `DELETE FROM restaurant_jobs
          WHERE "organizationId" = $1 AND type <> $2`,
        identity.organizationId,
        DEMO_RESET_JOB_TYPE
      );
    } else if (table === 'restaurant_operator_credentials') {
      await guardedDelete(
        db,
        identity,
        `DELETE FROM restaurant_operator_credentials
          WHERE "organizationId" = $1
            AND NOT ("staffProfileId" IN ($2, $3) AND "deviceId" IS NULL)`,
        identity.organizationId,
        managerStaffProfileId,
        approverStaffProfileId
      );
    } else if (table === 'restaurant_staff_profiles') {
      await guardedDelete(
        db,
        identity,
        `DELETE FROM restaurant_staff_profiles
          WHERE "organizationId" = $1 AND id NOT IN ($2, $3)`,
        identity.organizationId,
        managerStaffProfileId,
        approverStaffProfileId
      );
    } else {
      await guardedDelete(
        db,
        identity,
        `DELETE FROM ${quoteIdentifier(table)} WHERE "organizationId" = $1`,
        identity.organizationId
      );
    }
  }

  const genericTables = RESTAURANT_RESET_TABLES.filter((table) => !SPECIAL_TABLES.has(table));
  const residuals = await db.$queryRawUnsafe<Residual[]>(
    genericTables
      .map(
        (table) =>
          `SELECT '${table}' AS "tableName", count(*)::int AS count
             FROM ${quoteIdentifier(table)} WHERE "organizationId" = $1`
      )
      .join(' UNION ALL '),
    identity.organizationId
  );
  const dirty = residuals.filter((row) => Number(row.count) !== 0);
  if (dirty.length) {
    throw new Error(
      `Restaurant demo reset left tenant rows behind: ${dirty
        .map((row) => `${row.tableName}=${row.count}`)
        .join(', ')}`
    );
  }

  const [special] = await db.$queryRawUnsafe<
    Array<{ staff: number; credentials: number; jobs: number; executions: number }>
  >(
    `SELECT
       (SELECT count(*)::int FROM restaurant_staff_profiles
         WHERE "organizationId" = $1 AND id NOT IN ($2, $3)) AS staff,
       (SELECT count(*)::int FROM restaurant_operator_credentials
         WHERE "organizationId" = $1
           AND NOT ("staffProfileId" IN ($2, $3) AND "deviceId" IS NULL)) AS credentials,
       (SELECT count(*)::int FROM restaurant_jobs
         WHERE "organizationId" = $1 AND type <> $4) AS jobs,
       (SELECT count(*)::int
          FROM restaurant_job_executions AS execution
          LEFT JOIN restaurant_jobs AS job ON job.id = execution."jobId"
         WHERE execution."organizationId" = $1
           AND (job.id IS NULL OR job.type <> $4)) AS executions`,
    identity.organizationId,
    managerStaffProfileId,
    approverStaffProfileId,
    DEMO_RESET_JOB_TYPE
  );
  if (!special || Object.values(special).some((count) => Number(count) !== 0)) {
    throw new Error(
      'Restaurant demo reset failed preserved-identity or demo-job cleanup validation.'
    );
  }
}

export async function resetDemoSeatInTransaction(
  db: ScopedDb,
  input: { organizationId: string; now?: Date }
): Promise<DemoRestaurantSeatResult> {
  const now = input.now ?? new Date();
  assertValidDate(now);
  const identity = identityForOrganization(input.organizationId);
  await lockAndGuardOrganization(db, identity);
  const [managerStaffProfileId, approverStaffProfileId] = await preservedStaffIds(db, identity);

  await db.$queryRawUnsafe(
    `SELECT set_config('app.demo_reset_organization_id', $1, true)`,
    identity.organizationId
  );
  await clearRestaurantData(db, identity, managerStaffProfileId, approverStaffProfileId);
  await db.$queryRawUnsafe(`SELECT set_config('app.demo_reset_organization_id', '', true)`);

  const result = await rebuildDemoRestaurantSeatInTransaction(db, {
    identity,
    now,
    managerStaffProfileId,
    approverStaffProfileId,
  });
  const updated = await db.$executeRawUnsafe(
    `UPDATE organizations SET "lastDemoResetAt" = $2
      WHERE id = $1 AND "isDemo" = true
        AND vertical = 'RESTAURANT' AND "deploymentMode" = 'SHARED'`,
    identity.organizationId,
    now
  );
  if (updated !== 1) throw new Error('Demo reset organization changed before completion.');
  return result;
}
