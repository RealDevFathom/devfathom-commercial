import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261116140000_pharmacy_drawer_operating_cashier/migration.sql',
  'utf8'
);

describe('DEV-821 drawer operating-cashier storage contract', () => {
  it('is one idempotent transaction', () => {
    expect(migration.trim().startsWith('-- DEV-821')).toBe(true);
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "operatingCashierId"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_drawer_handovers"');
    expect(migration).toContain('DROP TRIGGER IF EXISTS');
    expect(migration).toContain('DROP POLICY IF EXISTS tenant_isolation');
  });

  it('backfills existing drawers to their opener', () => {
    expect(migration).toContain(
      'SET "operatingCashierId" = "openedByActorId" WHERE "operatingCashierId" IS NULL'
    );
  });

  it('forces tenant row-level security on the handover table', () => {
    expect(migration).toContain('ALTER TABLE "pharmacy_drawer_handovers" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "pharmacy_drawer_handovers" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_organization_id', true)");
  });

  it('keeps every handover as append-only evidence with a reason and a real change', () => {
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_drawer_handovers"');
    expect(migration).toContain('CHECK (length(btrim("reason")) > 0)');
    expect(migration).toContain('CHECK ("fromCashierId" <> "toCashierId")');
    expect(migration).toContain(
      'REFERENCES "pharmacy_drawer_sessions"("organizationId", "id") ON DELETE RESTRICT'
    );
  });
});
