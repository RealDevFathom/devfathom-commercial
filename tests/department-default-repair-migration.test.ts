import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261021180500_repair_default_departments/migration.sql',
  'utf8'
);

describe('default department repair migration', () => {
  it('ignores only the intended tenant department-key conflict', () => {
    expect(migration).toContain('ON CONFLICT ("organizationId", "key") DO NOTHING');
    expect(migration).not.toMatch(/ON CONFLICT\s+DO NOTHING/i);
  });

  it('repairs every vertical catalog with cross-tenant RLS scope', () => {
    expect(migration).toContain(`set_config('app.is_platform_admin', 'true', true)`);
    expect(migration).toContain("('LEADERSHIP', 'Leadership', 0, 'AGENCY'");
    expect(migration).toContain("('FRONT_OF_HOUSE', 'Front of House', 1, 'RESTAURANT'");
    expect(migration).toContain("('DISPENSARY', 'Dispensary', 1, 'PHARMACY'");
    expect(migration).toContain("('FRONT_OFFICE', 'Front Office', 0, 'HOSPITALITY'");
    expect(migration).toContain('WHERE defaults.vertical = o."vertical"');
  });
});
