import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261116090000_pharmacy_drap_price_alerts/migration.sql',
  'utf8'
);

describe('DEV-693 DRAP price alert storage', () => {
  it('is transactional, idempotent and tenant isolated under forced RLS', () => {
    expect(migration.trim().startsWith('BEGIN;')).toBe(true);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_drap_price_alerts"');
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_drap_price_alerts" ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_drap_price_alerts" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_drap_price_alerts"'
    );
    expect(migration).toContain(
      `"organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')`
    );
  });

  it('keeps alerts as evidence: no deletes, one alert per notice, recorded dismissal', () => {
    expect(migration).toContain('FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete()');
    expect(migration).toContain('UNIQUE ("organizationId", "ingestId")');
    expect(migration).toContain('"dismissedAt" IS NOT NULL AND length(btrim("dismissedById")) > 0');
    expect(migration).not.toMatch(/pharmacy_pack_prices|pharmacy_price_change_proposals/);
  });
});
