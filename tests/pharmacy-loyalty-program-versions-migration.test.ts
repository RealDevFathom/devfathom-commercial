import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261116100100_pharmacy_loyalty_program_versions/migration.sql',
  'utf8'
);
const code = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('pharmacy loyalty program versions migration (DEV-746)', () => {
  it('runs as one idempotent transaction', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_loyalty_program_versions"');
    expect(code).toContain("ADD VALUE IF NOT EXISTS 'KHATA_EARN'");
    expect(code).toContain('ADD COLUMN IF NOT EXISTS "programVersionId"');
    expect(code).toContain('ADD COLUMN IF NOT EXISTS "earnStartMinor"');
  });

  it('isolates program versions per tenant and keeps them immutable', () => {
    expect(code).toContain(
      'ALTER TABLE "pharmacy_loyalty_program_versions" ENABLE ROW LEVEL SECURITY'
    );
    expect(code).toContain(
      'ALTER TABLE "pharmacy_loyalty_program_versions" FORCE ROW LEVEL SECURITY'
    );
    expect(code).toMatch(
      /CREATE POLICY tenant_isolation ON "pharmacy_loyalty_program_versions"[\s\S]*"organizationId" = NULLIF\(current_setting\('app\.current_organization_id', true\), ''\)/
    );
    expect(code).toMatch(
      /BEFORE UPDATE OR DELETE ON "pharmacy_loyalty_program_versions"\s+FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change\(\)/
    );
  });

  it('caps a rate at paying back what was spent, at the database too', () => {
    expect(code).toContain('"earnPoints"::bigint * 100 <= "perSpendMinor"::bigint');
  });

  it('preserves every existing balance: no entry is rewritten and no rate is seeded', () => {
    expect(code).not.toMatch(/\bUPDATE\s+"?pharmacy_loyalty_points_entries/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/DISABLE TRIGGER/i);
  });

  it('keeps every earlier entry shape and adds the khata collection earn', () => {
    for (const kind of ['EARN', 'REDEEM', 'REFUND', 'EARN_REVERSAL', 'KHATA_EARN'])
      expect(code).toContain(`("kind"::text = '${kind}'`);
    expect(code).toMatch(
      /'KHATA_EARN' AND "points" > 0[^\n]*"tenderId" IS NOT NULL[^\n]*"programVersionId" IS NOT NULL/
    );
  });
});
