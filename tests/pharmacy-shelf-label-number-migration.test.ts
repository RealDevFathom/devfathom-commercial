import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261115140000_pharmacy_shelf_label_number/migration.sql',
  'utf8'
);
const schema = readFileSync('prisma/schema.prisma', 'utf8');

describe('DEV-90 shelf-label lot number migration', () => {
  it('is one idempotent transaction', () => {
    expect(
      migration
        .trim()
        .split('\n')
        .find((line) => !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('CREATE SEQUENCE IF NOT EXISTS');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "shelfLabelNumber"');
    expect(migration).toContain('WHERE "shelfLabelNumber" IS NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(migration).toContain('DROP TRIGGER IF EXISTS pharmacy_shelf_label_number_immutable');
  });

  it('numbers existing lots under transaction-local admin scope and keeps RLS intact', () => {
    expect(migration).toContain("set_config('app.is_platform_admin', 'true', true)");
    expect(migration).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/);
    expect(migration).not.toMatch(/DROP POLICY/);
  });

  it('keeps a printed sticker pointing at the same lot forever', () => {
    expect(migration).toContain('BEFORE UPDATE OF "shelfLabelNumber"');
    expect(migration).toContain('shelf label number is immutable');
  });

  it('matches the Prisma model', () => {
    expect(schema).toMatch(/shelfLabelNumber\s+Int\s+@unique @default\(autoincrement\(\)\)/);
  });
});
