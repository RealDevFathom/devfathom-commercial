import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261021190000_backfill_explicit_pharmacy_dispense/migration.sql',
  'utf8'
);

describe('explicit pharmacy dispense wildcard backfill migration', () => {
  it('runs transactionally and backfills role and user wildcard grants', () => {
    expect(sql.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(sql).toContain('INSERT INTO organization_role_permissions');
    expect(sql).toContain('INSERT INTO user_permission_overrides');
    expect(sql.match(/'pharmacy:dispense'/g)).toHaveLength(2);
    expect(sql.match(/p\.capability IN \('\*', 'pharmacy:\*'\)/g)).toHaveLength(2);
    expect(sql.match(/p\.effect = 'ALLOW'/g)).toHaveLength(2);
  });

  it('does not replace an existing explicit grant or denial', () => {
    expect(sql).toContain('ON CONFLICT ("organizationRoleId", capability) DO NOTHING');
    expect(sql).toContain('ON CONFLICT ("userId", capability) DO NOTHING');
    expect(sql).not.toMatch(/DO UPDATE/i);
  });
});
