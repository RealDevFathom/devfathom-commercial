import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261021200000_restaurant_manager_staff_capability/migration.sql'
  ),
  'utf8'
);

describe('restaurant manager staff capability repair', () => {
  it('repairs only persisted Restaurant GM and Branch Manager system templates', () => {
    expect(sql).toContain("organization.vertical = 'RESTAURANT'");
    expect(sql).toContain('role."isSystem" = true');
    expect(sql).toContain("role.key IN ('general-manager', 'branch-manager')");
    expect(sql).toContain("'staff:manage'");
    expect(sql).toContain('ON CONFLICT ("organizationRoleId", "capability") DO NOTHING');
  });

  it('elevates the migration for the cross-tenant repair before inserting', () => {
    const elevate = sql.indexOf("SELECT set_config('app.is_platform_admin', 'true', true);");
    const insert = sql.indexOf('INSERT INTO "organization_role_permissions"');

    expect(elevate).toBeGreaterThan(-1);
    expect(elevate).toBeLessThan(insert);
  });
});
