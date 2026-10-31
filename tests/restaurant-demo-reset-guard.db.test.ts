import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';

import { resolveRestaurantE2eDatabaseUrl } from '../scripts/restaurant-e2e-database';

const optedIn = process.env.RESTAURANT_DEMO_RESET_DB === '1';
if (optedIn && !process.env.RESTAURANT_E2E_DATABASE_URL) {
  throw new Error('RESTAURANT_E2E_DATABASE_URL is required when RESTAURANT_DEMO_RESET_DB=1.');
}

const describeIfOptedIn = optedIn ? describe : describe.skip;

// These tables have no ordinary DELETE/ALL policy. Mutable restaurant CRUD
// tables outside this inventory must not be mistaken for append-only ledgers.
const RESET_POLICY_TABLES = [
  'restaurant_customer_consents',
  'restaurant_customer_interactions',
  'restaurant_daily_close_tender_totals',
  'restaurant_daily_closes',
  'restaurant_drawer_movements',
  'restaurant_job_executions',
  'restaurant_labour_cost_facts',
  'restaurant_loyalty_points_entries',
  'restaurant_notification_deliveries',
  'restaurant_order_events',
  'restaurant_payment_events',
  'restaurant_promotion_application_snapshots',
  'restaurant_promotion_audit_events',
  'restaurant_promotion_bill_application_snapshots',
  'restaurant_promotion_candidate_snapshots',
  'restaurant_promotion_cap_reservations',
  'restaurant_promotion_evaluation_snapshots',
  'restaurant_promotion_unit_allocations',
  'restaurant_refunds',
  'restaurant_service_charge_policy_versions',
  'restaurant_shift_events',
  'restaurant_shift_swap_decisions',
  'restaurant_shift_swap_requests',
  'restaurant_sop_escalation_events',
  'restaurant_sop_evidence',
  'restaurant_sop_verifications',
  'restaurant_staff_capability_audits',
  'restaurant_staff_job_role_audits',
  'restaurant_stock_movements',
  'restaurant_tax_refund_allocations',
  'restaurant_tenders',
  'restaurant_terminal_reconciliations',
  'restaurant_time_adjustments',
  'restaurant_workforce_commands',
] as const;
// 20261018000000_restaurant_demo_reset_compatibility: catering history admits the reset
// DELETE through a narrower predicate, for the canonical synthetic demo seats only.
const COMPATIBILITY_RESET_POLICY_TABLES = [
  'restaurant_catering_branch_capacity',
  'restaurant_catering_commands',
  'restaurant_catering_dispositions',
  'restaurant_catering_events',
  'restaurant_catering_money_evidence',
  'restaurant_catering_quote_approvals',
  'restaurant_catering_quote_revisions',
] as const;

describeIfOptedIn('Restaurant demo reset database guard (real disposable DB)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: resolveRestaurantE2eDatabaseUrl() });
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('permits only same-demo deletes, preserves updates, and rolls deletion back', async () => {
    const client = await pool.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const demoOrganizationId = `demo_reset_${suffix}`;
    const ordinaryOrganizationId = `ordinary_reset_${suffix}`;
    const demoAuditId = `demo_audit_${suffix}`;
    const ordinaryAuditId = `ordinary_audit_${suffix}`;
    const taxSourceId = `demo_tax_source_${suffix}`;
    const tenderId = `demo_tender_${suffix}`;
    const branchId = `demo_branch_${suffix}`;
    const staffId = `demo_staff_${suffix}`;
    const auditedStaffId = `demo_audited_staff_${suffix}`;
    const operatorAuditId = `demo_operator_audit_${suffix}`;
    const deviceId = `demo_device_${suffix}`;
    const orderId = `demo_order_${suffix}`;
    const billId = `demo_bill_${suffix}`;

    const deleteTender = () =>
      client.query('DELETE FROM restaurant_tenders WHERE id = $1', [tenderId]);

    const setTenantScope = async (
      organizationId: string,
      isPlatformAdmin: boolean,
      resetOrganizationId?: string
    ) => {
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.is_platform_admin', $2, true)`,
        [organizationId, String(isPlatformAdmin)]
      );
      if (resetOrganizationId !== undefined) {
        await client.query(`SELECT set_config('app.demo_reset_organization_id', $1, true)`, [
          resetOrganizationId,
        ]);
      }
    };

    const insertOrganization = async (organizationId: string, isDemo: boolean) => {
      await setTenantScope(organizationId, false);
      await client.query(
        `INSERT INTO organizations
           (id, slug, "legalName", "displayName", vertical, "deploymentMode", "isDemo", "updatedAt")
         VALUES ($1, $2, $3, $3, 'RESTAURANT', 'SHARED', $4, clock_timestamp())`,
        [organizationId, organizationId, `Reset guard ${organizationId}`, isDemo]
      );
    };

    try {
      await client.query('BEGIN');

      const role = await client.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }>(
        'SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });

      const policies = await client.query(
        `SELECT p.schemaname, p.tablename, p.policyname, p.cmd, p.permissive,
                p.roles::text[] AS roles, p.qual, p.with_check,
                c.relrowsecurity, c.relforcerowsecurity
         FROM pg_policies p
         JOIN pg_namespace n ON n.nspname = p.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = p.tablename
         WHERE p.policyname = 'restaurant_demo_reset_delete'
            OR (p.schemaname = 'public' AND p.tablename = ANY($1::text[])
                AND p.cmd IN ('DELETE', 'ALL'))
         ORDER BY p.tablename, p.policyname`,
        [[...RESET_POLICY_TABLES, ...COMPATIBILITY_RESET_POLICY_TABLES]]
      );
      expect(RESET_POLICY_TABLES).toHaveLength(34);
      expect(COMPATIBILITY_RESET_POLICY_TABLES).toHaveLength(7);
      expect(
        policies.rows.map((row) => ({
          ...row,
          // pg_get_expr omits the schema when public is on the search path.
          qual: row.qual?.replace(/^public\./, ''),
        }))
      ).toEqual(
        [
          ...RESET_POLICY_TABLES.map((tablename) => [tablename, 'restaurant_demo_reset_allowed']),
          ...COMPATIBILITY_RESET_POLICY_TABLES.map((tablename) => [
            tablename,
            'restaurant_demo_reset_compatibility_allowed',
          ]),
        ]
          // Same order as ORDER BY on the name type (C collation).
          .sort(([a], [b]) => (a! < b! ? -1 : 1))
          .map(([tablename, predicate]) => ({
            schemaname: 'public',
            tablename,
            policyname: 'restaurant_demo_reset_delete',
            cmd: 'DELETE',
            permissive: 'PERMISSIVE',
            roles: ['public'],
            qual: `${predicate}("organizationId")`,
            with_check: null,
            relrowsecurity: true,
            relforcerowsecurity: true,
          }))
      );

      await insertOrganization(demoOrganizationId, true);
      await insertOrganization(ordinaryOrganizationId, false);

      await setTenantScope(demoOrganizationId, false);
      // Minimal synthetic money graph, entirely inside this rolled-back transaction.
      await client.query(
        `INSERT INTO restaurant_branches (id, "organizationId", name, "updatedAt")
         VALUES ($1, $2, 'Reset guard', clock_timestamp())`,
        [branchId, demoOrganizationId]
      );
      await client.query(
        `INSERT INTO restaurant_staff_profiles
           (id, "organizationId", "displayName", "primaryBranchId", "updatedAt")
         VALUES ($1, $2, 'Reset guard', $3, clock_timestamp())`,
        [staffId, demoOrganizationId, branchId]
      );
      await client.query(
        `INSERT INTO restaurant_staff_profiles
           (id, "organizationId", "displayName", "primaryBranchId", "updatedAt")
         VALUES ($1, $2, 'Temporary demo operator', $3, clock_timestamp())`,
        [auditedStaffId, demoOrganizationId, branchId]
      );
      await client.query(
        `INSERT INTO audit_logs
           (id, "organizationId", source, category, action, "actorType",
            "actorStaffProfileId", "actorName", metadata)
         VALUES ($1, $2, 'REST_API', 'TERMINAL', 'restaurant.terminal.unlock',
                 'RESTAURANT_OPERATOR', $3, 'Temporary demo operator', $4::jsonb)`,
        [operatorAuditId, demoOrganizationId, auditedStaffId, JSON.stringify({ deviceId })]
      );
      const operatorAuditBefore = await client.query('SELECT * FROM audit_logs WHERE id = $1', [
        operatorAuditId,
      ]);
      await client.query(
        `INSERT INTO restaurant_registered_devices
           (id, "organizationId", "branchId", name, "deviceSecretHash", "updatedAt")
         VALUES ($1, $2, $3, 'Reset guard', $4, clock_timestamp())`,
        [deviceId, demoOrganizationId, branchId, suffix]
      );
      await client.query(
        `INSERT INTO restaurant_orders
           (id, "organizationId", "branchId", "orderNumber", "businessDate", channel,
            "staffProfileId", "deviceId", "updatedAt")
         VALUES ($1, $2, $3, 1, DATE '2026-09-11', 'DINE_IN', $4, $5, clock_timestamp())`,
        [orderId, demoOrganizationId, branchId, staffId, deviceId]
      );
      await client.query(
        `INSERT INTO restaurant_bills
           (id, "organizationId", "orderId", "branchId", "businessDate", subtotal, "grandTotal",
            "openerStaffProfileId", "deviceId", "updatedAt")
         VALUES ($1, $2, $3, $4, DATE '2026-09-11', 5.00, 5.00, $5, $6, clock_timestamp())`,
        [billId, demoOrganizationId, orderId, branchId, staffId, deviceId]
      );
      await client.query(
        `INSERT INTO restaurant_tenders
           (id, "organizationId", "billId", type, amount, "businessDate", "staffProfileId", "deviceId")
         VALUES ($1, $2, $3, 'OTHER', 5.00, DATE '2026-09-11', $4, $5)`,
        [tenderId, demoOrganizationId, billId, staffId, deviceId]
      );
      await client.query(
        `INSERT INTO restaurant_promotion_audit_events (id, "organizationId", action)
         VALUES ($1, $2, 'EVALUATED')`,
        [demoAuditId, demoOrganizationId]
      );
      await client.query(
        `INSERT INTO restaurant_tax_official_sources
           (id, "organizationId", "authorityCode", "documentTitle", "sourceUrl", "contentHash", "retrievedAt")
         VALUES ($1, $2, 'TEST', 'Reset guard', 'https://example.invalid/reset-guard', $3, clock_timestamp())`,
        [taxSourceId, demoOrganizationId, suffix]
      );

      await setTenantScope(ordinaryOrganizationId, false);
      await client.query(
        `INSERT INTO restaurant_promotion_audit_events (id, "organizationId", action)
         VALUES ($1, $2, 'EVALUATED')`,
        [ordinaryAuditId, ordinaryOrganizationId]
      );

      await setTenantScope(demoOrganizationId, false);
      const missingReset = await client.query<{ reset_scope: string | null; allowed: boolean }>(
        `SELECT current_setting('app.demo_reset_organization_id', true) AS reset_scope,
                public.restaurant_demo_reset_allowed($1) AS allowed`,
        [demoOrganizationId]
      );
      expect(missingReset.rows[0]).toEqual({ reset_scope: null, allowed: false });
      expect((await deleteTender()).rowCount).toBe(0);
      expect(
        (
          await client.query(`DELETE FROM restaurant_promotion_audit_events WHERE id = $1`, [
            demoAuditId,
          ])
        ).rowCount
      ).toBe(0);

      await setTenantScope(ordinaryOrganizationId, false, ordinaryOrganizationId);
      expect((await deleteTender()).rowCount).toBe(0);
      expect(
        (
          await client.query(`SELECT public.restaurant_demo_reset_allowed($1) AS allowed`, [
            ordinaryOrganizationId,
          ])
        ).rows[0]?.allowed
      ).toBe(false);
      expect(
        (
          await client.query(`DELETE FROM restaurant_promotion_audit_events WHERE id = $1`, [
            ordinaryAuditId,
          ])
        ).rowCount
      ).toBe(0);

      await setTenantScope(ordinaryOrganizationId, false, demoOrganizationId);
      expect((await deleteTender()).rowCount).toBe(0);
      expect(
        (
          await client.query(`SELECT public.restaurant_demo_reset_allowed($1) AS allowed`, [
            demoOrganizationId,
          ])
        ).rows[0]?.allowed
      ).toBe(false);
      expect(
        (
          await client.query(`DELETE FROM restaurant_promotion_audit_events WHERE id = $1`, [
            demoAuditId,
          ])
        ).rowCount
      ).toBe(0);

      await setTenantScope(demoOrganizationId, true, demoOrganizationId);
      expect((await deleteTender()).rowCount).toBe(0);
      expect(
        (
          await client.query(`SELECT public.restaurant_demo_reset_allowed($1) AS allowed`, [
            demoOrganizationId,
          ])
        ).rows[0]?.allowed
      ).toBe(false);
      expect(
        (
          await client.query(`DELETE FROM restaurant_promotion_audit_events WHERE id = $1`, [
            demoAuditId,
          ])
        ).rowCount
      ).toBe(0);

      await setTenantScope(demoOrganizationId, false, demoOrganizationId);
      expect(
        (
          await client.query(`SELECT public.restaurant_demo_reset_allowed($1) AS allowed`, [
            demoOrganizationId,
          ])
        ).rows[0]?.allowed
      ).toBe(true);

      await client.query('SAVEPOINT guarded_delete');
      expect((await deleteTender()).rowCount).toBe(1);
      expect(
        (await client.query('SELECT id FROM restaurant_tenders WHERE id = $1', [tenderId])).rows
      ).toEqual([]);
      expect(
        (
          await client.query(`DELETE FROM restaurant_promotion_audit_events WHERE id = $1`, [
            demoAuditId,
          ])
        ).rowCount
      ).toBe(1);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM restaurant_promotion_audit_events WHERE id = $1`,
            [demoAuditId]
          )
        ).rows[0]?.count
      ).toBe(0);
      await client.query('ROLLBACK TO SAVEPOINT guarded_delete');
      expect(
        (
          await client.query('SELECT amount::text FROM restaurant_tenders WHERE id = $1', [
            tenderId,
          ])
        ).rows
      ).toEqual([{ amount: '5.00' }]);
      expect(
        (
          await client.query('UPDATE restaurant_tenders SET amount = 6.00 WHERE id = $1', [
            tenderId,
          ])
        ).rowCount
      ).toBe(0);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS count FROM restaurant_promotion_audit_events WHERE id = $1`,
            [demoAuditId]
          )
        ).rows[0]?.count
      ).toBe(1);

      await client.query('SAVEPOINT immutable_update');
      let updateError: unknown;
      try {
        await client.query(
          `UPDATE restaurant_tax_official_sources SET "documentTitle" = 'changed' WHERE id = $1`,
          [taxSourceId]
        );
      } catch (error) {
        updateError = error;
      }
      await client.query('ROLLBACK TO SAVEPOINT immutable_update');
      expect(updateError).toMatchObject({ code: '55000', message: 'tax record is immutable' });

      // Match reset.ts's deletion of unretained staff in the tenant demo-reset
      // context. Historical terminal audits must survive with only the FK cleared.
      expect(
        (
          await client.query(
            `DELETE FROM restaurant_staff_profiles
             WHERE "organizationId" = $1 AND NOT (id = ANY($2::text[]))`,
            [demoOrganizationId, [staffId]]
          )
        ).rowCount
      ).toBe(1);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(
        (await client.query('SELECT * FROM audit_logs WHERE id = $1', [operatorAuditId])).rows
      ).toEqual([{ ...operatorAuditBefore.rows[0], actorStaffProfileId: null }]);
      expect(
        (await client.query('SELECT id FROM restaurant_staff_profiles WHERE id = $1', [staffId])).rows
      ).toEqual([{ id: staffId }]);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
