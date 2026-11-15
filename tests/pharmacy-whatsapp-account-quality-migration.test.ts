import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261115220500_pharmacy_whatsapp_account_quality/migration.sql',
  'utf8'
);

describe('DEV-22 WhatsApp account-quality storage contract', () => {
  it('is transactional and idempotent', () => {
    expect(migration.trim().startsWith('--')).toBe(true);
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_whatsapp_account_events"');
    expect(migration).toContain('DROP POLICY IF EXISTS tenant_isolation');
  });

  it('forces tenant row-level security and keeps evidence immutable', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_whatsapp_account_events" ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_whatsapp_account_events" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain("current_setting('app.current_organization_id', true)");
    expect(migration).toContain('pharmacy_reject_append_only_change()');
    expect(migration).toContain('"organizationId", "eventKey"');
  });
});
