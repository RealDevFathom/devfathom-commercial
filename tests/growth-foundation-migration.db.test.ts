// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('prisma/migrations/20261101170700_growth_foundation/migration.sql'),
  'utf8'
);
// A disposable database with CREATE SCHEMA permission, using a restricted role.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('growth foundation migration under FORCE RLS', () => {
  it('adds growth tables without rewriting tenant rows or consent state', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const schema = `growth_migration_${randomUUID().replaceAll('-', '')}`;
    try {
      const role = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        SELECT set_config('app.is_platform_admin', 'false', false);
        SELECT set_config('app.current_organization_id', '', false);
        CREATE TABLE organizations (id TEXT PRIMARY KEY);
        CREATE TABLE users (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
          UNIQUE ("organizationId", id)
        );
        CREATE TABLE pharmacy_patients (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, phone TEXT
        );
        CREATE TABLE pharmacy_customers (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
          "patientId" TEXT, "whatsappOptIn" BOOLEAN,
          UNIQUE ("organizationId", id)
        );
        CREATE TABLE pharmacy_sales (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL,
          UNIQUE ("organizationId", id)
        );
        CREATE TABLE pharmacy_message_logs (
          id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, direction TEXT
        );
        INSERT INTO organizations VALUES ('a'), ('b');
        INSERT INTO users VALUES ('ua', 'a'), ('ub', 'b');
        INSERT INTO pharmacy_sales VALUES ('sa', 'a'), ('sa2', 'a');
        INSERT INTO pharmacy_patients VALUES
          ('pa', 'a', '0300-1234567'), ('pb', 'b', '0311 7654321');
        INSERT INTO pharmacy_customers VALUES
          ('ca', 'a', 'pa', NULL), ('cb', 'b', 'pb', NULL),
          ('consented', 'a', NULL, true), ('unlinked', 'b', NULL, false);
      `);
      for (const table of ['pharmacy_customers', 'pharmacy_patients']) {
        await client.query(`
          ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
          ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON "${table}"
          USING (
            current_setting('app.is_platform_admin', true) = 'true'
            OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
          );
        `);
      }
      // Confirm the owner cannot see the fixture before the migration elevates.
      expect((await client.query('SELECT * FROM pharmacy_customers')).rows).toEqual([]);
      // This migration has no procedural blocks or semicolons in SQL literals.
      // Send each statement separately, with no test-owned outer transaction:
      // only the migration's explicit BEGIN/COMMIT may retain local settings.
      const statements = sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .filter((s) => s.trim());
      for (const statement of statements) {
        const result = await client.query(statement);
        // No data rewrite: consent and contact data are never changed here.
        expect(['UPDATE', 'INSERT', 'DELETE']).not.toContain(result.command);
      }
      expect(sql).not.toMatch(/is_platform_admin',\s*'true'/);
      const context = await client.query(
        "SELECT current_setting('app.is_platform_admin', true) AS admin"
      );
      expect(context.rows[0].admin).not.toBe('true');
      expect((await client.query('SELECT * FROM pharmacy_customers')).rows).toEqual([]);
      // Elevate separately for inspection after confirming migration scope ended.
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
      const customers = await client.query(`
        SELECT id, "whatsappOptIn" FROM pharmacy_customers ORDER BY id
      `);
      expect(customers.rows).toEqual([
        { id: 'ca', whatsappOptIn: null },
        { id: 'cb', whatsappOptIn: null },
        { id: 'consented', whatsappOptIn: true },
        { id: 'unlinked', whatsappOptIn: false },
      ]);
      // No second consent/contact store, no message body, no duplicate provider id.
      const added = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = $1 AND (
           (table_name = 'pharmacy_customers' AND column_name IN
             ('whatsappE164', 'whatsappOptInAt', 'whatsappOptOutAt')) OR
           (table_name = 'pharmacy_message_logs' AND column_name IN ('body', 'waMessageId')) OR
           (table_name = 'pharmacy_sales' AND column_name = 'discountCode')
         )`,
        [schema]
      );
      expect(added.rows).toEqual([]);
      const column = await client.query(
        `
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'pharmacy_customers'
          AND column_name = 'whatsappOptIn'
      `,
        [schema]
      );
      expect(column.rows[0].is_nullable).toBe('YES');
      const metrics = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND
         ((table_name = 'customer_metrics' AND column_name = 'spend90dMinor')
         OR (table_name = 'growth_settings' AND column_name = 'lastMetricsRunAt'))
         ORDER BY column_name`,
        [schema]
      );
      expect(metrics.rows).toEqual([
        { column_name: 'lastMetricsRunAt', data_type: 'timestamp without time zone' },
        { column_name: 'spend90dMinor', data_type: 'bigint' },
      ]);
      const constraints = await client.query(
        `SELECT conname FROM pg_constraint
         WHERE connamespace = $1::regnamespace
           AND conname IN (
             'customer_metrics_nonnegative_check', 'customer_metrics_churn_check',
             'growth_settings_money_check', 'growth_settings_limits_check',
             'campaigns_money_check', 'campaigns_reach_check', 'campaigns_discount_check',
             'campaigns_kind_check', 'campaigns_status_check', 'campaigns_origin_check',
             'campaigns_approval_check', 'campaign_recipients_status_check',
             'campaign_recipients_redemption_check',
             'campaigns_organizationId_createdByUserId_fkey',
             'campaigns_organizationId_approvedByUserId_fkey',
             'growth_settings_wa_api_key_enc_check'
           ) ORDER BY conname`,
        [schema]
      );
      expect(constraints.rows.map((row) => row.conname)).toEqual([
        'campaign_recipients_redemption_check',
        'campaign_recipients_status_check',
        'campaigns_approval_check',
        'campaigns_discount_check',
        'campaigns_kind_check',
        'campaigns_money_check',
        'campaigns_organizationId_approvedByUserId_fkey',
        'campaigns_organizationId_createdByUserId_fkey',
        'campaigns_origin_check',
        'campaigns_reach_check',
        'campaigns_status_check',
        'customer_metrics_churn_check',
        'customer_metrics_nonnegative_check',
        'growth_settings_limits_check',
        'growth_settings_money_check',
        'growth_settings_wa_api_key_enc_check',
      ]);
      // A plaintext WhatsApp API key is rejected; only a secret-crypto v1 envelope fits.
      await client.query("SELECT set_config('app.current_organization_id', 'a', true)");
      await client.query('SAVEPOINT plaintext_key');
      await expect(
        client.query(
          `INSERT INTO growth_settings ("organizationId", "waApiKeyEnc", "updatedAt")
           VALUES ('a', 'plain-api-key', now())`
        )
      ).rejects.toThrow(/growth_settings_wa_api_key_enc_check/);
      await client.query('ROLLBACK TO SAVEPOINT plaintext_key');
      await client.query(
        `INSERT INTO growth_settings ("organizationId", "waApiKeyEnc", "updatedAt")
         VALUES ('a', 'v1.aXY.dGFn.Y2lwaGVy', now())`
      );
      const codeIndex = await client.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = 'campaign_recipients_organizationId_code_key'`,
        [schema]
      );
      expect(codeIndex.rows[0].indexdef).toContain('("organizationId", code)');

      // Campaign and redemption integrity is enforced by the database.
      const rejects = async (statement: string, constraint: RegExp) => {
        await client.query('SAVEPOINT growth_reject');
        await expect(client.query(statement)).rejects.toThrow(constraint);
        await client.query('ROLLBACK TO SAVEPOINT growth_reject');
      };
      await client.query(
        `INSERT INTO message_templates (id, "organizationId", key, body, "updatedAt")
         VALUES ('ta', 'a', 'winback', 'Hi {{name}}', now())`
      );
      const campaign = (values: string) =>
        `INSERT INTO campaigns (id, "organizationId", kind, status, name, segment, "sendAt",
           "discountType", "discountValue", "budgetCapMinor", "templateId", origin,
           "createdByUserId", "approvedByUserId", "approvedAt", "updatedAt")
         VALUES (${values}, now())`;
      await rejects(
        campaign(`'x', 'a', 'winback', 'proposed', 'n', '{}', now(), 'percent', 101, 0, 'ta', 'ai', NULL, NULL, NULL`),
        /campaigns_discount_check/
      );
      await rejects(
        campaign(`'x', 'a', 'spam', 'proposed', 'n', '{}', now(), NULL, NULL, 0, 'ta', 'ai', NULL, NULL, NULL`),
        /campaigns_kind_check/
      );
      await rejects(
        campaign(`'x', 'a', 'winback', 'bogus', 'n', '{}', now(), NULL, NULL, 0, 'ta', 'ai', NULL, NULL, NULL`),
        /campaigns_status_check/
      );
      await rejects(
        campaign(`'x', 'a', 'winback', 'proposed', 'n', '{}', now(), NULL, NULL, 0, 'ta', 'staff', NULL, NULL, NULL`),
        /campaigns_origin_check/
      );
      await rejects(
        campaign(`'x', 'a', 'winback', 'sent', 'n', '{}', now(), NULL, NULL, 0, 'ta', 'ai', NULL, NULL, NULL`),
        /campaigns_approval_check/
      );
      await rejects(
        campaign(`'x', 'a', 'winback', 'proposed', 'n', '{}', now(), NULL, NULL, 0, 'ta', 'ai', NULL, 'ua', NULL`),
        /campaigns_approval_check/
      );
      // Another tenant's user cannot create or approve this tenant's campaign.
      await rejects(
        campaign(`'x', 'a', 'winback', 'proposed', 'n', '{}', now(), NULL, NULL, 0, 'ta', 'staff', 'ub', NULL, NULL`),
        /campaigns_organizationId_createdByUserId_fkey/
      );
      await client.query(
        campaign(`'ka', 'a', 'winback', 'approved', 'n', '{}', now(), 'percent', 10, 0, 'ta', 'staff', 'ua', 'ua', now()`)
      );
      const recipient = (values: string) =>
        `INSERT INTO campaign_recipients (id, "organizationId", "campaignId", "customerId",
           code, status, "redeemedAt", "saleId", "updatedAt")
         VALUES (${values}, now())`;
      await rejects(
        recipient(`'rx', 'a', 'ka', 'ca', 'C1', 'redeemed', now(), NULL`),
        /campaign_recipients_redemption_check/
      );
      await rejects(
        recipient(`'rx', 'a', 'ka', 'ca', 'C1', 'sent', NULL, 'sa'`),
        /campaign_recipients_redemption_check/
      );
      await rejects(
        recipient(`'rx', 'a', 'ka', 'ca', 'C1', 'unknown', NULL, NULL`),
        /campaign_recipients_status_check/
      );
      await client.query(recipient(`'r1', 'a', 'ka', 'ca', 'C1', 'redeemed', now(), 'sa'`));
      // One sale redeems at most one code.
      await rejects(
        recipient(`'r2', 'a', 'ka', 'consented', 'C2', 'redeemed', now(), 'sa'`),
        /campaign_recipients_organizationId_saleId_key/
      );
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
