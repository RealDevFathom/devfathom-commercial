import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261116130200_pharmacy_supplier_price_lists/migration.sql',
  'utf8'
);

describe('DEV-681 supplier price-list storage contract', () => {
  it('is one idempotent transaction with forced tenant RLS on both new tables', () => {
    expect(migration.trim().startsWith('-- DEV-681')).toBe(true);
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(migration).toContain(
      "ARRAY['pharmacy_supplier_price_lists', 'pharmacy_supplier_price_list_lines']"
    );
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('DROP POLICY IF EXISTS tenant_isolation');
    expect(migration).toContain('app.current_organization_id');
  });

  it('keeps drafts below MRP and ties every decision and approval to a person and a price', () => {
    expect(migration).toContain('"draftSellingPriceMinor" <= "draftMrpMinor"');
    expect(migration).toContain('"decidedById" IS NOT NULL');
    expect(migration).toContain('("draftStatus" = \'APPROVED\') = ("packPriceId" IS NOT NULL)');
    expect(migration).toContain('"draftStatus" = \'NONE\' OR "matchStatus" = \'MATCHED\'');
  });

  it('lets the same file be compared afresh after a compared price moved', () => {
    expect(migration).not.toMatch(/UNIQUE INDEX[^;]*sourceHash/);
  });

  it('admits an approved supplier draft as a named price-policy source', () => {
    expect(migration).toContain(
      'CHECK ("source" IN (\'drap\', \'manual\', \'supplier\'))'
    );
  });
});
