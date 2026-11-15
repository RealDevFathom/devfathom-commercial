import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261115220100_pharmacy_counter_search_trgm/migration.sql',
  'utf8'
);

describe('pharmacy counter search trigram migration (DEV-575)', () => {
  it('runs as one idempotent transaction without creating the extension', () => {
    expect(
      migration
        .trimStart()
        .split('\n')
        .find((line) => !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).not.toMatch(/^\s*CREATE EXTENSION\b/im);
    expect(migration).toContain("extname = 'pg_trgm'");
    for (const statement of migration.match(/CREATE INDEX[^\n]*/g) ?? []) {
      expect(statement).toContain('IF NOT EXISTS');
    }
  });

  it.each([
    ['pharmacy_medicines', 'productName'],
    ['pharmacy_medicines', 'brandName'],
    ['pharmacy_medicines', 'manufacturer'],
    ['pharmacy_medicines', 'drapRegistrationNumber'],
    ['pharmacy_presentations', 'presentation'],
    ['pharmacy_presentations', 'dosageForm'],
    ['pharmacy_presentations', 'route'],
  ])('indexes %s.%s for substring search', (table, column) => {
    expect(migration).toContain(`ON "${table}" USING GIN ("${column}" gin_trgm_ops)`);
  });
});
