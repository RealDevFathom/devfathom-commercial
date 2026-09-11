import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pg from 'pg';

import { resolveRestaurantE2eDatabaseUrl } from '../scripts/restaurant-e2e-database';

const optedIn = process.env.RESTAURANT_DEMO_RESET_DB === '1';
if (optedIn && !process.env.RESTAURANT_E2E_DATABASE_URL) {
  throw new Error('RESTAURANT_E2E_DATABASE_URL is required when RESTAURANT_DEMO_RESET_DB=1.');
}

const describeIfOptedIn = optedIn ? describe : describe.skip;

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
      }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      await insertOrganization(demoOrganizationId, true);
      await insertOrganization(ordinaryOrganizationId, false);

      await setTenantScope(demoOrganizationId, false);
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
      expect(
        (
          await client.query(`DELETE FROM restaurant_promotion_audit_events WHERE id = $1`, [
            demoAuditId,
          ])
        ).rowCount
      ).toBe(0);

      await setTenantScope(ordinaryOrganizationId, false, ordinaryOrganizationId);
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
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30_000);
});
