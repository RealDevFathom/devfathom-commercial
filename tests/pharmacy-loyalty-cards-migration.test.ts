import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261117090600_pharmacy_loyalty_cards/migration.sql',
  'utf8'
);
const code = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('pharmacy loyalty cards migration (DEV-748)', () => {
  it('runs as one idempotent transaction and is listed in the migration order', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_loyalty_cards"');
    for (const index of code.match(/CREATE (?:UNIQUE )?INDEX[^;]*;/g) ?? [])
      expect(index).toContain('IF NOT EXISTS');
    expect(code).toContain('DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_loyalty_cards"');
    expect(readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')).toContain(
      '20261117090600_pharmacy_loyalty_cards'
    );
  });

  it('enables and forces tenant row-level security', () => {
    expect(code).toContain('ALTER TABLE "pharmacy_loyalty_cards" ENABLE ROW LEVEL SECURITY;');
    expect(code).toContain('ALTER TABLE "pharmacy_loyalty_cards" FORCE ROW LEVEL SECURITY;');
    expect(code).toMatch(
      /CREATE POLICY tenant_isolation ON "pharmacy_loyalty_cards"\s+USING \([^;]*"organizationId" = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)\)\s+WITH CHECK/
    );
  });

  it('stores only a hash, unique within the organization, never a plaintext code', () => {
    expect(code).toContain('"codeHash" TEXT NOT NULL');
    expect(code).toContain(`CHECK ("codeHash" ~ '^[0-9a-f]{64}$')`);
    expect(code).toMatch(/ON "pharmacy_loyalty_cards" \("organizationId", "codeHash"\);/);
    expect(code).not.toMatch(/"code" TEXT/);
  });

  it('allows one working card per customer and never revives a revoked one', () => {
    expect(code).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_cards_one_active_key"\s+ON "pharmacy_loyalty_cards" \("organizationId", "customerId"\)\s+WHERE "revokedAt" IS NULL;/
    );
    expect(code).toContain('length(btrim("revokedReason")) BETWEEN 3 AND 200');
    expect(code).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_loyalty_cards"');
    expect(code).toContain('OR OLD."revokedAt" IS NOT NULL THEN');
    expect(code).toMatch(
      /REFERENCES "pharmacy_customers" \("organizationId", "id"\) ON DELETE RESTRICT/
    );
  });
});
