import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261031190000_pharmacy_shelf_label_identity/migration.sql',
  'utf8'
);
const schema = readFileSync('prisma/schema.prisma', 'utf8');

describe('#719 pharmacy shelf-label lot identity migration', () => {
  it('adds a backfilled, unique, positive lot alias without touching existing columns', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_inventory_lots" ADD COLUMN "shelfLabelNumber" SERIAL NOT NULL;'
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "pharmacy_inventory_lots_shelfLabelNumber_key"');
    expect(migration).toContain('CHECK ("shelfLabelNumber" > 0)');
    expect(migration).not.toMatch(/DROP|ALTER COLUMN|DISABLE ROW LEVEL SECURITY|DROP POLICY/i);
  });

  it('keeps a printed label pointing at the same lot forever', () => {
    expect(migration).toContain('BEFORE UPDATE ON "pharmacy_inventory_lots"');
    expect(migration).toContain('Shelf label lot identity is immutable');
  });

  it('is mirrored in the Prisma model', () => {
    expect(schema).toMatch(/shelfLabelNumber\s+Int\s+@unique @default\(autoincrement\(\)\)/);
  });
});
