import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const registry = readFileSync(
  'prisma/migrations/20261117090100_uploaded_file_registry/migration.sql',
  'utf8'
);
const proof = readFileSync(
  'prisma/migrations/20261117090000_restaurant_sop_evidence_server_captured/migration.sql',
  'utf8'
);

describe('DEV-837 upload registry and SOP proof provenance migrations', () => {
  it.each([
    ['registry', registry],
    ['SOP proof', proof],
  ])('%s migration is transactional and idempotent', (_label, sql) => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
  });

  it('puts the registry under forced tenant RLS with no DELETE policy', () => {
    expect(registry).toContain('ENABLE ROW LEVEL SECURITY');
    expect(registry).toContain('FORCE ROW LEVEL SECURITY');
    expect(registry).toContain("current_setting('app.current_organization_id', true)");
    expect(registry).toMatch(/FOR SELECT/);
    expect(registry).toMatch(/FOR INSERT/);
    expect(registry).toMatch(/FOR UPDATE/);
    expect(registry).not.toMatch(/FOR (?:DELETE|ALL)/);
    expect(registry).toContain('DROP POLICY IF EXISTS');
  });

  it('makes identity and bindings write-once in the database', () => {
    expect(registry).toContain('BEFORE UPDATE ON "uploaded_files"');
    expect(registry).toContain('An uploaded file binding cannot change');
    expect(registry).toContain('An uploaded file record cannot change its identity');
    expect(registry).toContain(
      `CHECK ("ownerType" IS NULL OR "ownerType" IN ('PROJECT_FILE', 'TASK_ATTACHMENT', 'CONTRACT'))`
    );
    expect(registry).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uploaded_files_org_name_key"');
  });

  it('backfills existing references, binding protected owners ahead of any other reference', () => {
    for (const table of [
      'project_files',
      'task_attachments',
      'contracts',
      'pharmacy_branch_regulatory_profiles',
      'clients',
      'message_attachments',
    ]) {
      expect(registry).toContain(`FROM "${table}"`);
    }
    expect(registry).toContain(
      'ORDER BY ref."organizationId", ref."name", ref."ownerType" IS NULL, ref."createdAt", ref."rank"'
    );
    expect(registry).toContain('ON CONFLICT ("organizationId", "name") DO NOTHING');
    // The backfill runs before RLS is forced on the new table.
    expect(registry.indexOf('INSERT INTO "uploaded_files"')).toBeLessThan(
      registry.indexOf('FORCE ROW LEVEL SECURITY')
    );
  });

  it('adds the SOP proof flag with a safe default', () => {
    expect(proof).toContain(
      'ADD COLUMN IF NOT EXISTS "serverCaptured" BOOLEAN NOT NULL DEFAULT false'
    );
  });
});
