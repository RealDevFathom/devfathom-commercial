import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261026090000_pharmacy_cashier_prescription_capture/migration.sql'
  ),
  'utf8'
);

describe('pharmacy cashier prescription capture capability repair', () => {
  it('repairs only persisted Pharmacy Cashier system templates', () => {
    expect(sql).toContain("organization.vertical = 'PHARMACY'");
    expect(sql).toContain('role."isSystem" = true');
    expect(sql).toContain("role.key = 'cashier'");
    expect(sql).toContain("'pharmacy:prescriptions'");
  });

  it('is elevated and idempotent without replacing an explicit DENY', () => {
    const elevate = sql.indexOf("SELECT set_config('app.is_platform_admin', 'true', true);");
    const insert = sql.indexOf('INSERT INTO "organization_role_permissions"');

    expect(elevate).toBeGreaterThan(-1);
    expect(elevate).toBeLessThan(insert);
    expect(sql).toContain('ON CONFLICT ("organizationRoleId", "capability") DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
  });
});
