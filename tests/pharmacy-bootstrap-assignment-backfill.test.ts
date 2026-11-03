import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261103023000_pharmacy_bootstrap_branch_assignment/migration.sql'
  ),
  'utf8'
);

// A security boundary: this repair must not become a repeat of the all-member backfill.
describe('pharmacy bootstrap assignment repair', () => {
  it('requires the sole original administrator and an audited creation transaction', () => {
    for (const predicate of [
      `u."createdAt" = o."createdAt"`,
      `u."role" = 'ADMIN'::"Role"`,
      `r."isSystem" = true`,
      `r."createdAt" = o."createdAt"`,
      `r."key" IN ('owner', 'owner-operator')`,
      `r."key" = 'admin'`,
      `p."capability" = '*'`,
      `p."effect" = 'ALLOW'::"PermissionEffect"`,
      `other."createdAt" = o."createdAt"`,
      `other."id" <> u."id"`,
      `audit."action" IN ('organization.create', 'crm.opportunity.convert')`,
      `audit."targetType" = 'Organization'`,
      `audit."success" = true`,
      `audit."createdAt" = o."createdAt"`,
    ])
      expect(sql).toContain(predicate);
    expect(sql).toMatch(/AND NOT EXISTS\s*\(\s*SELECT 1 FROM "users" other/);
    expect(sql).not.toMatch(/'cashier'|'pharmacist'|'manager'|'procurement'/);
  });

  it('restricts every joined identity to the same tenant and the original active MAIN branch', () => {
    for (const predicate of [
      `o."vertical" = 'PHARMACY'::"OrganizationVertical"`,
      `o."status" IN ('ONBOARDING'::"OrganizationStatus", 'ACTIVE'::"OrganizationStatus")`,
      `o."isDemo" = false`,
      `u."organizationId" = o."id"`,
      `b."organizationId" = o."id"`,
      `r."organizationId" = o."id"`,
      `p."organizationId" = o."id"`,
      `other."organizationId" = o."id"`,
      `audit."organizationId" = o."id"`,
      `audit."targetId" = o."id"`,
      `b."createdAt" = o."createdAt"`,
      `b."code" = 'MAIN'`,
      `b."active" = true`,
      `u."status" IN ('ACTIVE'::"UserStatus", 'ON_LEAVE'::"UserStatus")`,
    ])
      expect(sql).toContain(predicate);
  });

  it('is insert-only and idempotent, preserving revocations and sensitive capability separation', () => {
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).toContain('ON CONFLICT ("organizationId", "branchId", "userId") DO NOTHING');
    expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|ALTER)\b/i);
    expect(statements.match(/\bINSERT INTO\b/g)).toHaveLength(1);
    expect(statements).toContain('INSERT INTO "pharmacy_branch_assignments"');
    expect(statements).not.toContain('pharmacy:safety');
    expect(statements.trim()).toMatch(/^BEGIN;/);
    expect(statements.trim()).toMatch(/COMMIT;$/);
    const elevated = statements.indexOf(
      "SELECT set_config('app.is_platform_admin', 'true', true);"
    );
    expect(elevated).toBeGreaterThan(-1);
    expect(elevated).toBeLessThan(statements.indexOf('INSERT INTO'));
  });
});
