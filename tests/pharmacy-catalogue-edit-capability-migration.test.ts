import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const name = '20261118121400_pharmacy_catalogue_edit_capability';
const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');

describe('DEV-19 pharmacy:catalogue-edit backfill migration', () => {
  it('is ordered, transactional and rerunnable', () => {
    expect(sql.trim().startsWith('-- DEV-19')).toBe(true);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('ON CONFLICT ("organizationRoleId", "capability") DO NOTHING');
    expect(sql).not.toMatch(/DELETE|UPDATE |DROP |TRUNCATE/i);
    expect(
      readFileSync('tests/fixtures/new-migration-order.txt', 'utf8').trim().split('\n')
    ).toContain(name);
  });

  it('grants the edit capability only to pharmacy Owner / Operator system roles', () => {
    expect(sql).toContain("'pharmacy:catalogue-edit'");
    expect(sql).toContain("organization.vertical = 'PHARMACY'");
    expect(sql).toContain('role."isSystem" = true');
    expect(sql).toContain("role.key = 'owner-operator'");
    expect(sql).toContain('\'ALLOW\'::"PermissionEffect"');
  });
});
