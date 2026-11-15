import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20261115160000_pharmacy_retention_window_enforcement/migration.sql'
  ),
  'utf8'
);

describe('DEV-96 retention window migration contract', () => {
  it('is one transaction', () => {
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('resolves the period from the branch rule set and never lets a tenant shorten it', () => {
    expect(migration).toContain(`r."recordRetentionByClass" -> 'values' -> (p_record_class::text)`);
    expect(migration).toContain(`r."prescriptionRetentionDays" -> 'values'`);
    expect(migration).toContain('FROM "pharmacy_retention_classes" rc');
    expect(migration).toContain('RETURN GREATEST(tenant_days, rule_days, default_days);');
  });

  it('gives the pharmacy-only classes a 10-year default floor and AUDIT none', () => {
    expect(migration).toMatch(
      /default_days integer := CASE p_record_class\s+WHEN 'PRESCRIPTION' THEN 3653\s+WHEN 'CONTROLLED_REGISTER' THEN 3653\s+WHEN 'FISCAL' THEN 3653\s+END;/
    );
    expect(migration).not.toMatch(/WHEN 'AUDIT' THEN \d+/);
    expect(migration).toContain('RETURN GREATEST(tenant_days, rule_days, default_days);');
  });

  it('takes the longest tenant retention class, so a later shorter row never shortens it', () => {
    expect(migration).toMatch(
      /SELECT max\(rc\."retentionDays"\) INTO tenant_days\s+FROM "pharmacy_retention_classes" rc\s+WHERE rc\."organizationId" = p_organization_id\s+AND rc\."recordClass" = p_record_class;/
    );
    expect(migration).not.toContain('ORDER BY rc."effectiveFrom" DESC');
  });

  it('refuses deletes inside the window on every pharmacy record class', () => {
    for (const table of [
      'pharmacy_prescriptions',
      'pharmacy_controlled_register_entries',
      'pharmacy_sales',
      'audit_logs',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TRIGGER \\w+ BEFORE DELETE ON "${table}"\\s+FOR EACH ROW EXECUTE FUNCTION pharmacy_retention_refuse_early_delete\\(\\);`
        )
      );
    }
    expect(migration).toContain(
      `IF anchor + make_interval(days => days) > timezone('UTC', now()) THEN`
    );
    // Pharmacy records with no configured period fail closed.
    expect(migration).toContain(
      "RAISE EXCEPTION 'deletion refused: no retention period is configured for % records'"
    );
  });

  it('admits a purge delete past append-only guards only for the named, expired, unheld record', () => {
    expect(migration).toContain("current_setting('app.retention_purge_record', true)");
    expect(migration).toContain(
      "current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true'"
    );
    expect(migration).toContain(
      "target IS DISTINCT FROM organization_id || ':' || record_class::text || ':' || root_id"
    );
    expect(migration).toContain("ends <= timezone('UTC', now())");
    expect(migration).toContain(
      'pharmacy_retention_active_hold(record_class, organization_id, root_id) IS NULL'
    );
    for (const guard of ['pharmacy_rx_reject_append_only_change', 'pharmacy_rx_append_only']) {
      const body = migration.slice(migration.indexOf(`CREATE OR REPLACE FUNCTION ${guard}()`));
      expect(body).toMatch(
        /IF TG_OP = 'DELETE' AND pharmacy_retention_purge_authorised\(TG_TABLE_NAME, to_jsonb\(OLD\)\) THEN\s+RETURN OLD;\s+END IF;\s+RAISE EXCEPTION '% is append-only'/
      );
    }
  });

  it('purges a register entry only as the oldest survivor of a chain that has a newer entry', () => {
    const guard = migration.slice(
      migration.indexOf("IF p_table = 'pharmacy_controlled_register_entries' AND (")
    );
    expect(guard).toMatch(
      /NOT EXISTS \(SELECT 1 FROM "pharmacy_controlled_register_entries" later[\s\S]*?later\."inventoryLotId" = p_old ->> 'inventoryLotId'\s+AND later\."serial" > \(p_old ->> 'serial'\)::integer\)/
    );
    expect(guard).toMatch(
      /OR EXISTS \(SELECT 1 FROM "pharmacy_controlled_register_entries" earlier[\s\S]*?earlier\."inventoryLotId" = p_old ->> 'inventoryLotId'\s+AND earlier\."serial" < \(p_old ->> 'serial'\)::integer\)\s+\) THEN\s+RETURN false;/
    );
  });

  it('adds the hourly retention purge job type without using it in the migration', () => {
    expect(migration).toContain(
      `ALTER TYPE "PlatformJobType" ADD VALUE IF NOT EXISTS 'pharmacy.record.retention.v1';`
    );
    expect(migration.match(/pharmacy\.record\.retention\.v1/g)).toHaveLength(1);
  });

  it('keeps the tenant purge exception behind the platform flag', () => {
    expect(migration).toMatch(
      /NULLIF\(current_setting\('app\.purging_organization_id', true\), ''\) = OLD\."organizationId"\s+AND current_setting\('app\.is_platform_admin', true\) = 'true'/
    );
  });
});
