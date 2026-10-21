import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261021150000_pharmacy_register_branch_scope/migration.sql',
  'utf8'
);

describe('pharmacy register branch scope migration', () => {
  it('adds the assignment table under forced tenant RLS and leaves the register append-only', () => {
    expect(sql).toContain('CREATE TABLE "pharmacy_branch_assignments"');
    expect(sql).toContain('ALTER TABLE "pharmacy_branch_assignments" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('tenant_isolation');
    expect(sql).not.toMatch(/DROP TRIGGER[\s\S]*pharmacy_controlled_register_entries_append_only/i);
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/NO FORCE ROW LEVEL SECURITY/i);
    expect(sql).toContain('pharmacy_controlled_register_entries_append_only');
  });
});
