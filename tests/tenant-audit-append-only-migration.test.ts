import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261023020200_tenant_audit_append_only/migration.sql',
  'utf8'
);
const triggerFunctionMigration = readFileSync(
  'prisma/migrations/20261019212000_platform_audit_append_only/migration.sql',
  'utf8'
);

describe('tenant audit append-only migration', () => {
  it('guards updates and deletes with a tenant-specific immutable-history trigger', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER audit_logs_append_only\s+BEFORE UPDATE OR DELETE ON audit_logs\s+FOR EACH ROW EXECUTE FUNCTION refuse_tenant_audit_mutation\(\);/i
    );
  });

  it('allows only deletion in the exact platform purge context', () => {
    expect(migration).toMatch(
      /IF TG_OP = 'DELETE'\s+AND current_setting\('app.is_platform_admin', true\) = 'true'\s+AND NULLIF\(current_setting\('app.purging_organization_id', true\), ''\) = OLD\."organizationId" THEN\s+RETURN OLD;\s+END IF;/i
    );
    expect(migration).toMatch(
      /RAISE EXCEPTION '% is append-only: % is forbidden'[\s\S]*ERRCODE = '55000'/i
    );
  });

  it('keeps the platform-history trigger unconditional with a stable append-only error', () => {
    expect(triggerFunctionMigration).toMatch(
      /CREATE FUNCTION refuse_platform_history_mutation\(\) RETURNS trigger[\s\S]*RAISE EXCEPTION '% is append-only: % is forbidden'[\s\S]*ERRCODE = '55000'/i
    );
    expect(triggerFunctionMigration).not.toContain('app.purging_organization_id');
  });

  it('limits actor cleanup to nested FK updates without changing any other audit facts', () => {
    expect(migration).toContain('pg_trigger_depth() > 1');
    expect(migration).toMatch(
      /to_jsonb\(NEW\) - 'actorId' - 'actorStaffProfileId'\s*= to_jsonb\(OLD\) - 'actorId' - 'actorStaffProfileId'/
    );
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM users WHERE id = OLD."actorId")');
    expect(migration).toMatch(
      /NOT EXISTS \(SELECT 1 FROM restaurant_staff_profiles\s+WHERE id = OLD\."actorStaffProfileId"\)/
    );
    expect(migration).toMatch(
      /CREATE TRIGGER audit_logs_actor_on_insert\s+BEFORE INSERT ON audit_logs\s+FOR EACH ROW EXECUTE FUNCTION refuse_tenant_audit_mutation\(\);/
    );
    expect(migration).toContain("CONSTRAINT = 'audit_logs_operator_actor_ck'");
  });

  it('guards TRUNCATE on tenant and platform ledgers at statement level', () => {
    for (const table of ['audit_logs', 'platform_audit_logs', 'organization_lifecycle_events']) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TRIGGER ${table}_no_truncate\\s+BEFORE TRUNCATE ON ${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION refuse_platform_history_mutation\\(\\);`
        )
      );
    }
  });
});
