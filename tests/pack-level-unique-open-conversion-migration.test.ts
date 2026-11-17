import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261117200451_pack_level_unique_open_conversion/migration.sql',
  'utf8'
);

describe('pack level open-conversion uniqueness migration (static)', () => {
  it('is transactional, non-destructive and keyed on the full pack identity', () => {
    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE)\b\s+(FROM\s+)?"?pharmacy_pack_levels/i);
    expect(sql).toContain("set_config('app.is_platform_admin', 'true', true)");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql).toContain(
      '("organizationId", "presentationId", COALESCE("parentPackLevelId", \'\'), "level", "unitsPerParent")'
    );
    expect(sql).toContain('WHERE "effectiveTo" IS NULL');
  });
});
