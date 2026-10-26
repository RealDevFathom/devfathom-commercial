import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261023020200_tenant_audit_append_only/migration.sql',
  'utf8'
);

describe('tenant audit append-only migration', () => {
  it('rejects updates and deletes with the shared immutable-history trigger', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER audit_logs_append_only\s+BEFORE UPDATE OR DELETE ON audit_logs\s+FOR EACH ROW EXECUTE FUNCTION refuse_platform_history_mutation\(\);/i
    );
  });
});
