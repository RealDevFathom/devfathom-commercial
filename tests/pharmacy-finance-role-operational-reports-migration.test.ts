import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const migration = readFileSync(
  'prisma/migrations/20261115140000_pharmacy_finance_role_operational_reports/migration.sql',
  'utf8'
);

describe('pharmacy Finance role operational reports backfill (DEV-519)', () => {
  it('grants existing Finance roles exactly what the catalog template now grants', () => {
    const finance = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'finance')!;
    expect(finance.capabilities).toContain('reports:operational');
    expect(migration).toContain("'reports:operational',\n  'ALLOW'::\"PermissionEffect\"");
  });

  it('touches only pharmacy Finance system roles and never overrides an existing rule', () => {
    expect(migration).toContain("organization.vertical = 'PHARMACY'");
    expect(migration).toContain('role."isSystem" = true');
    expect(migration).toContain("role.key = 'finance'");
    expect(migration).toContain('ON CONFLICT ("organizationRoleId", "capability") DO NOTHING');
    expect(migration).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it('runs in one transaction with cross-tenant RLS scope', () => {
    expect(migration.trim()).toMatch(/^(--.*\n)*BEGIN;[\s\S]*COMMIT;$/);
    expect(migration).toContain(`set_config('app.is_platform_admin', 'true', true)`);
  });
});
