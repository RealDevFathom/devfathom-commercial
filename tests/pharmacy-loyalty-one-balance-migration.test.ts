import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261117200504_pharmacy_loyalty_one_balance/migration.sql',
  'utf8'
);
const code = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('pharmacy loyalty one balance across branches migration (DEV-764)', () => {
  it('runs as one idempotent transaction', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const column of [
      'branchLocal',
      'loyaltyActive',
      'loyaltyStatusChangedAt',
      'loyaltyStatusReason',
    ])
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    expect(code).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_loyalty_balance_reconciliations"');
    expect(code).toContain('ON CONFLICT ("organizationId", "customerId", "branchId") DO NOTHING');
  });

  it('marks every existing entry as posted per branch, and every later one as organization-wide', () => {
    expect(code).toMatch(
      /ADD COLUMN IF NOT EXISTS "branchLocal" BOOLEAN NOT NULL DEFAULT true;\s*ALTER TABLE "pharmacy_loyalty_points_entries"\s*ALTER COLUMN "branchLocal" SET DEFAULT false;/
    );
  });

  it('records only pre-merge per-branch balances of customers with more than one branch', () => {
    const insert = code.slice(
      code.indexOf('INSERT INTO "pharmacy_loyalty_balance_reconciliations"')
    );
    expect(insert).toContain('e."branchLocal" = true');
    expect(insert).toContain('other."branchLocal" = true');
    expect(insert).toContain('other."organizationId" = e."organizationId"');
    expect(insert).toContain('other."branchId" <> e."branchId"');
    expect(insert).toContain('GROUP BY e."organizationId", e."customerId", e."branchId"');
  });

  it('keeps the reconciliation tenant-isolated and append-only', () => {
    expect(code).toContain(
      'ALTER TABLE "pharmacy_loyalty_balance_reconciliations" ENABLE ROW LEVEL SECURITY;'
    );
    expect(code).toContain(
      'ALTER TABLE "pharmacy_loyalty_balance_reconciliations" FORCE ROW LEVEL SECURITY;'
    );
    expect(code).toMatch(
      /CREATE POLICY tenant_isolation ON "pharmacy_loyalty_balance_reconciliations"\s+USING \(current_setting\('app.is_platform_admin', true\) = 'true' OR\s+"organizationId" = NULLIF\(current_setting\('app.current_organization_id', true\), ''\)\)/
    );
    expect(code).toContain('EXECUTE FUNCTION pharmacy_reject_append_only_change()');
    expect(code).toContain('REFERENCES "pharmacy_customers" ("organizationId", "id")');
  });

  it('preserves every balance, ledger row and existing policy: additive only', () => {
    expect(code).not.toMatch(/\bUPDATE\s+"?pharmacy_/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+"pharmacy_loyalty_points_entries"/i);
    expect(code).not.toMatch(/DISABLE TRIGGER|DROP TRIGGER/i);
    expect(code).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    // The only policy dropped is the new table's own, so a re-run can recreate it.
    for (const drop of code.match(/DROP POLICY[^;]*;/gi) ?? [])
      expect(drop).toContain('"pharmacy_loyalty_balance_reconciliations"');
    expect(code).not.toMatch(/pharmacy_loyalty_points_entries[^;]*POLICY/i);
  });

  it('keeps every existing customer an enrolled member', () => {
    expect(code).toContain('"loyaltyActive" BOOLEAN NOT NULL DEFAULT true');
    expect(code).toContain('length(btrim("loyaltyStatusReason")) BETWEEN 3 AND 500');
  });
});
