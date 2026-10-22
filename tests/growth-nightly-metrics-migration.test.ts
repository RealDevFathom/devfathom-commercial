import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'prisma/migrations/20261022170000_growth_nightly_metrics/migration.sql';

describe('growth nightly metrics migration', () => {
  it('forces exact organization and branch RLS on settings and snapshots', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain('ALTER TABLE growth_settings FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE growth_metric_snapshots FORCE ROW LEVEL SECURITY');
    expect(sql.match(/current_branch_id/g)?.length).toBe(4);
    expect(sql).not.toContain("current_setting('app.is_platform_admin'");
  });

  it('constrains effects and makes a daily scope idempotent', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    expect(sql).toContain("effect IN ('ALLOW', 'DENY')");
    expect(sql).toContain('UNIQUE ("organizationId", "branchId", vertical, "metricDate")');
  });
});
