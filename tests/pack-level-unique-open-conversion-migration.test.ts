import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261115100000_pack_level_unique_open_conversion/migration.sql',
  'utf8'
);
const identity = readFileSync(
  'prisma/migrations/20260902120000_pharmacy_medicine_identity/migration.sql',
  'utf8'
);

describe('pack level open-conversion uniqueness migration', () => {
  it('closes duplicates with an interval the effective-range CHECK accepts', () => {
    expect(identity).toContain('CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")');
    expect(sql).toContain(`SET "effectiveTo" = p."effectiveFrom" + INTERVAL '1 millisecond'`);
  });

  it('is transactional and builds an idempotent partial unique index over open packs', () => {
    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql).toContain('WHERE "effectiveTo" IS NULL');
  });
});
