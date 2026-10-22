import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261023000592_tenant_audit_logs_append_only/migration.sql',
  'utf8'
);
const schema = readFileSync('prisma/schema.prisma', 'utf8');

describe('tenant audit append-only migration', () => {
  it('rejects updates and deletes of every tenant audit row', () => {
    expect(sql).toMatch(
      /CREATE TRIGGER tenant_audit_logs_append_only\s+BEFORE UPDATE OR DELETE ON audit_logs\s+FOR EACH ROW EXECUTE FUNCTION refuse_tenant_audit_log_mutation\(\);/i
    );
    expect(sql).toMatch(
      /CREATE FUNCTION refuse_tenant_audit_log_mutation\(\) RETURNS trigger[\s\S]*RAISE EXCEPTION[\s\S]*TG_OP[\s\S]*ERRCODE = '55000'/i
    );
  });

  it('does not weaken tenant isolation or grant a mutation bypass', () => {
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/current_organization_id|is_platform_admin|purging_organization_id/i);
  });

  it('keeps actor deletion compatible without allowing cross-tenant attribution', () => {
    for (const constraint of [
      'audit_logs_actorId_fkey',
      'tenant_audit_logs_actorId_users_fk',
      'audit_logs_actorStaffProfileId_fkey',
      'tenant_audit_actorStaffProfileId_fk',
    ]) {
      expect(sql).toContain(`DROP CONSTRAINT "${constraint}"`);
    }
    expect(sql).toMatch(/BEFORE INSERT ON audit_logs[\s\S]*validate_tenant_audit_log_actor/i);
    expect(sql).toMatch(
      /users[\s\S]*id = NEW\."actorId"[\s\S]*"organizationId" = NEW\."organizationId"/i
    );
    expect(sql).toMatch(
      /restaurant_staff_profiles[\s\S]*id = NEW\."actorStaffProfileId"[\s\S]*"organizationId" = NEW\."organizationId"/i
    );
  });

  it('models actor identifiers as immutable snapshots rather than SetNull relations', () => {
    const auditModel = schema.match(/model AuditLog \{[\s\S]*?\n\}/)?.[0];
    expect(auditModel).toBeTruthy();
    expect(auditModel).not.toMatch(/@relation|onDelete:\s*SetNull/);
    expect(auditModel).toMatch(/actorId\s+String\?/);
    expect(auditModel).toMatch(/actorStaffProfileId\s+String\?/);
  });
});
