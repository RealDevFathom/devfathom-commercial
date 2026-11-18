import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const name = '20261118000000_pharmacy_catalogue_ingredient_edits';
const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');

describe('DEV-19 queued new-ingredient catalogue edits migration', () => {
  it('is ordered, transactional and rerunnable', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "pharmacy_catalogue_edits_medicine_scope_check"'
    );
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DISABLE ROW LEVEL SECURITY/i);
    expect(
      readFileSync('tests/fixtures/new-migration-order.txt', 'utf8').trim().split('\n')
    ).toContain(name);
  });

  it('lets only a new-ingredient edit omit its medicine', () => {
    expect(sql).toContain('ALTER COLUMN "medicineId" DROP NOT NULL');
    expect(sql).toContain(`CHECK (("operation" = 'createIngredient') = ("medicineId" IS NULL))`);
  });
});
