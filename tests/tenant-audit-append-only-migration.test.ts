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
});
