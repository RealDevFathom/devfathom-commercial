import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261102140500_pharmacy_catalogue_change_review/migration.sql',
  'utf8'
);
const schema = readFileSync('prisma/schema.prisma', 'utf8');

describe('catalogue change review persistence contract', () => {
  it('forces organization RLS on the review queue', () => {
    expect(migration).toContain('CREATE TABLE "pharmacy_catalogue_changes"');
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_catalogue_changes" ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_catalogue_changes" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain("current_setting('app.current_organization_id', true)");
    expect(schema).toContain('@@map("pharmacy_catalogue_changes")');
  });

  it('pins separation of duties and one decision per change in the database', () => {
    expect(migration).toContain('pharmacy_catalogue_changes_reviewer_check');
    expect(migration).toContain(
      `"reviewedBy" IS NULL OR "reviewedBy" <> "proposedBy" OR "reviewMode" = 'SOLO_OWNER'`
    );
    expect(migration).toContain('pharmacy_catalogue_changes_guard');
    expect(migration).toContain("OLD.status <> 'PENDING'");
    expect(migration).toContain('NEW.payload IS DISTINCT FROM OLD.payload');
  });

  it('admits deletes only for the platform purge of the row tenant', () => {
    expect(migration).toContain("current_setting('app.purging_organization_id', true)");
    expect(migration).toContain("current_setting('app.is_platform_admin', true) = 'true' THEN");
  });

  it('changes no tenant data or role grants', () => {
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+"/i);
    expect(migration).not.toContain('organization_role_permissions');
  });
});
