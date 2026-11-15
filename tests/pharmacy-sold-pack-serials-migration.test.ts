import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261115120000_pharmacy_sold_pack_serials/migration.sql',
  'utf8'
);

describe('DEV-92 sold pack serial storage contract', () => {
  it('is one idempotent transaction', () => {
    expect(
      migration
        .trimStart()
        .split('\n')
        .find((line) => !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_sold_pack_serials"');
    expect(migration).toContain('DROP POLICY IF EXISTS tenant_branch_isolation');
    expect(migration).toContain('DROP TRIGGER IF EXISTS pharmacy_sold_pack_serials_guard');
  });

  it('forces tenant and branch row-level security', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_sold_pack_serials" ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_sold_pack_serials" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
  });

  it('allows one live sale per GTIN and serial across the organization', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_sold_pack_serials_live_key" ON "pharmacy_sold_pack_serials"("organizationId", "gtin", "serialKey") WHERE "releasedAt" IS NULL'
    );
  });

  it('keeps claims undeletable and only lets a release be stamped once', () => {
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_sold_pack_serials"');
    expect(migration).toContain('rows are never deleted');
    expect(migration).toContain('OLD."releasedAt" IS NOT NULL');
  });
});
