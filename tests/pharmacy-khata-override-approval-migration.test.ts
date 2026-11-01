import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261101000000_khata_bound_override_approval/migration.sql',
  'utf8'
);

describe('Khata override approval evidence migration', () => {
  it('binds evidence to the tenant sale and approver identities', () => {
    expect(sql).toContain('FOREIGN KEY ("organizationId", "branchId", "saleId")');
    expect(sql).toContain('FOREIGN KEY ("organizationId", "approverId")');
    expect(sql).toContain('ON DELETE RESTRICT');
  });

  it('allows only the first consumedAt transition and rejects deletion or evidence rewrites', () => {
    expect(sql).toContain("IF TG_OP = 'DELETE'");
    expect(sql).toContain('OLD."consumedAt" IS NOT NULL');
    expect(sql).toContain('NEW."consumedAt" IS NULL');
    expect(sql).toContain('NEW."consumedAt" IS NOT DISTINCT FROM OLD."consumedAt"');
    expect(sql).toContain('ROW(NEW."id", NEW."organizationId", NEW."branchId", NEW."approverId", NEW."saleId"');
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
  });

  it('keeps every quoted identifier within the PostgreSQL 63-byte limit', () => {
    const identifiers = [...sql.matchAll(/"([^"]+)"/g)].map(([, name]) => name!);
    expect(identifiers.filter((name) => Buffer.byteLength(name) > 63)).toEqual([]);
    expect(sql).toContain('"pharmacy_khata_override_approvals_sale_idx"');
    expect(sql).toContain('"pharmacy_khata_override_approvals_account_idx"');
    expect(sql).toContain('"pharmacy_khata_override_approvals_approver_idx"');
  });

  it('forces tenant and branch row-level isolation', () => {
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
  });
});
