import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260828100000_vertical_configurable_departments/migration.sql'
  ),
  'utf8'
);

describe('WHA-278 department migration contract', () => {
  it('backfills every legacy user value before converting the enum', () => {
    const backfill = migration.indexOf('SELECT concat(\'dept_\', md5(u."organizationId"');
    const conversion = migration.indexOf('ALTER TABLE "users" ALTER COLUMN "department" TYPE TEXT');
    expect(backfill).toBeGreaterThan(-1);
    expect(conversion).toBeGreaterThan(backfill);
    expect(migration).toContain('ON CONFLICT ("organizationId", "key") DO NOTHING');
  });

  it('seeds vertical-specific restaurant defaults without agency defaults', () => {
    expect(migration).toContain("('KITCHEN', 'Kitchen', 0, 'RESTAURANT'");
    expect(migration).toContain("('FRONT_OF_HOUSE', 'Front of House', 1, 'RESTAURANT'");
    expect(migration).not.toContain("('ENGINEERING', 'Engineering', 1, 'RESTAURANT'");
  });

  it('pins tenant-composite integrity and forced RLS', () => {
    expect(migration).toContain('FOREIGN KEY ("organizationId", "department")');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY "tenant_isolation" ON "organization_departments"');
  });
});
