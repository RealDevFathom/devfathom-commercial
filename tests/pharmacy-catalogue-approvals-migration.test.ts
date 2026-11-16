import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const name = '20261117090600_pharmacy_catalogue_edit_approvals';
const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
describe('DEV-766 durable catalogue queue migration', () => {
  it('is ordered, transactional, additive and rerunnable', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "editorId"');
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/i);
    expect(
      readFileSync('tests/fixtures/new-migration-order.txt', 'utf8').trim().split('\n').at(-1)
    ).toBe(name);
  });
  it('forces tenant isolation and composite tenant references', () => {
    expect(sql).toContain('ALTER TABLE "pharmacy_catalogue_edits" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "pharmacy_catalogue_edits" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      'WITH CHECK ("organizationId" = current_setting(\'app.current_organization_id\', true))'
    );
    expect(sql).toContain('FOREIGN KEY ("organizationId", "medicineId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "reviewerId")');
  });
  it('retains immutable proposals and requires PIN evidence for self approval', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('catalogue proposal is immutable');
    expect(sql).toContain('app.pharmacy_catalogue_solo_pin_user_id');
    expect(sql).toContain('"soloPinVerifiedAt" IS NOT NULL');
    expect(sql).toContain('catalogue proposals are retained');
  });
});
