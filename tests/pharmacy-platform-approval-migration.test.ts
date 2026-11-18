import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEV-905: the super admin's approval of a pharmacy is one fact on the organization,
 * written only by the platform control plane.
 */
const sql = readFileSync(
  'prisma/migrations/20261118120000_pharmacy_platform_approval/migration.sql',
  'utf8'
);

describe('pharmacy platform approval migration', () => {
  it('is transactional and safe to re-run', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    for (const column of [
      '"platformApprovedAt" TIMESTAMP(3)',
      '"platformApprovedById" TEXT',
      '"platformApprovalNote" TEXT',
      '"platformApprovalUnmetChecks" JSONB',
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS organizations_platform_approval_guard ON "organizations"'
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION organizations_guard_platform_approval()');
  });

  it('lets only a platform transaction set, change or clear the approval', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "organizations"');
    expect(sql).toContain("current_setting('app.is_platform_admin', true) = 'true'");
    for (const column of [
      'platformApprovedAt',
      'platformApprovedById',
      'platformApprovalNote',
      'platformApprovalUnmetChecks',
    ]) {
      expect(sql).toContain(`NEW."${column}" IS DISTINCT FROM OLD."${column}"`);
      expect(sql).toContain(`NEW."${column}" IS NOT NULL`);
    }
    expect(sql).toContain("USING ERRCODE = '42501'");
    // It never loosens the organization row's own isolation policy.
    expect(sql).not.toMatch(/DROP POLICY|DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY/i);
  });
});

/**
 * No tenant route, router, page or library writes the approval: the columns appear only
 * in the platform command that sets and withdraws it, the platform pages that show it
 * and the read-only gate helpers.
 */
describe('only the platform control plane writes the approval', () => {
  const ALLOWED = new Set([
    'src/lib/platform/commands.ts',
    'src/lib/pharmacy/platform-approval.ts',
    'src/lib/pharmacy/regulatory.ts',
    'src/lib/pharmacy/onboarding.ts',
    'src/app/platform/(console)/organizations/[id]/page.tsx',
  ]);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('names the approval columns nowhere else in the application', () => {
    const offenders = sources('src').filter(
      (path) => !ALLOWED.has(path) && /platformApprov/.test(readFileSync(path, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('writes them only in the platform command module', () => {
    for (const path of ALLOWED) {
      if (path === 'src/lib/platform/commands.ts') continue;
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(
        /organization\.(?:update|updateMany|upsert|create|createMany)\(/
      );
      expect(source, path).not.toMatch(/\$executeRaw|\$queryRawUnsafe[^;]*UPDATE/);
    }
  });
});
