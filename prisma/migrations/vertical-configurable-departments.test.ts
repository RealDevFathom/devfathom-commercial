import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260828060000_vertical_configurable_departments/migration.sql'
  ),
  'utf8'
);

describe('vertical-configurable departments migration', () => {
  it('casts the enum losslessly and backfills values in use before adding the foreign key', () => {
    const cast = sql.indexOf('TYPE TEXT USING "department"::TEXT');
    const legacyBackfill = sql.indexOf('SELECT DISTINCT "organizationId", "department"');
    const foreignKey = sql.indexOf('tenant_users_department_organization_departments_fk');

    expect(cast).toBeGreaterThan(-1);
    expect(legacyBackfill).toBeGreaterThan(cast);
    expect(foreignKey).toBeGreaterThan(legacyBackfill);
  });

  it('contains restaurant defaults and no restaurant agency leakage', () => {
    const restaurantRows = [...sql.matchAll(/\('RESTAURANT'::"OrganizationVertical", '([^']+)'/g)].map(
      (match) => match[1]
    );
    expect(restaurantRows).toEqual(['LEADERSHIP', 'KITCHEN', 'FRONT_OF_HOUSE']);
    expect(restaurantRows).not.toContain('ENGINEERING');
  });

  it('forces tenant RLS and enforces a composite tenant foreign key', () => {
    expect(sql).toContain('ALTER TABLE "organization_departments" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "department")');
    expect(sql).toContain('REFERENCES "organization_departments"("organizationId", "key")');
  });
});
