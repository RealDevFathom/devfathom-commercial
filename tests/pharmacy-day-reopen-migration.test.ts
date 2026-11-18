import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261118011553_pharmacy_day_reopen/migration.sql',
  'utf8'
);

describe('day-reopen storage boundaries', () => {
  it('is transactional and repeatable without rewriting financial history', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_day_reopens"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql).not.toMatch(
      /(?:UPDATE|DELETE FROM|TRUNCATE|DROP TABLE)\s+"?pharmacy_daily_closes/i
    );
  });
  it('forces tenant and branch RLS for both reads and writes', () => {
    expect(sql).toContain('ALTER TABLE "pharmacy_day_reopens" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "pharmacy_day_reopens" FORCE ROW LEVEL SECURITY');
    expect(sql).toMatch(/USING \(.*app.current_organization_id.*app.current_branch_id/);
    expect(sql).toMatch(/WITH CHECK \(.*app.current_organization_id.*app.current_branch_id/);
  });
  it('binds a reopen to the same tenant, branch and date as the immutable close', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("organizationId", "branchId", "businessDate", "closeId") REFERENCES "pharmacy_daily_closes"("organizationId", "branchId", "businessDate", "id") ON DELETE RESTRICT ON UPDATE RESTRICT'
    );
    expect(sql).toContain('"pharmacy_day_reopens_organizationId_closeId_key"');
  });
  it('keeps who, when and why append-only, with a nonblank reason', () => {
    expect(sql).toContain('"actorId" TEXT NOT NULL');
    expect(sql).toContain('"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain('CHECK (length(btrim("reason")) > 0)');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_day_reopens"');
    expect(sql).toContain('EXECUTE FUNCTION pharmacy_reject_money_mutation()');
  });
});
