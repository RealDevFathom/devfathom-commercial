import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261115220800_pharmacy_customer_churn_scores/migration.sql'
  ),
  'utf8'
);

describe('pharmacy churn scoring migration', () => {
  it('is transactional and idempotent', () => {
    expect(sql.trim()).toMatch(/^--[^\n]*\nBEGIN;/);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).toMatch(
      /DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_customer_churn_scores"/
    );
    expect(sql).toMatch(/DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_churn_scoring_runs"/);
  });

  it('forces row-level security on both new tenant tables', () => {
    for (const table of ['pharmacy_customer_churn_scores', 'pharmacy_churn_scoring_runs']) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    }
    expect(sql).toMatch(/"branchId" = current_setting\('app\.current_branch_id', true\)/);
  });

  it('keeps scores within the documented ranges and one run per organization day', () => {
    expect(sql).toContain('"score" BETWEEN 0 AND 100');
    expect(sql).toContain('"recencyScore" BETWEEN 1 AND 5');
    expect(sql).toContain('PRIMARY KEY ("organizationId", "branchId", "customerId")');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "[^"]+"\s+ON "pharmacy_churn_scoring_runs"\("organizationId", "businessDate"\)/
    );
  });
});
