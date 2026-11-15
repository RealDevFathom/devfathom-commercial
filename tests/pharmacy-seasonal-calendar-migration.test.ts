import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261116090000_pharmacy_seasonal_calendar/migration.sql',
  'utf8'
);

describe('DEV-74 seasonal calendar migration contract', () => {
  it('is transactional and idempotent', () => {
    expect(sql.trimStart()).toMatch(/^--[^\n]*\nBEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_seasonal_windows"');
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_branch_isolation');
    expect(sql).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/);
  });

  it('puts the branch calendar under forced tenant and branch RLS', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
    expect(sql).toContain('REFERENCES "pharmacy_branches"("organizationId", "id")');
  });

  it('constrains kinds and spans in the database, not only the UI', () => {
    expect(sql).toContain("CHECK (\"kind\" IN ('DENGUE', 'FLU', 'RAMADAN', 'MONSOON', 'CUSTOM'))");
    expect(sql).toContain('"endDate" > "startDate"');
  });
});
