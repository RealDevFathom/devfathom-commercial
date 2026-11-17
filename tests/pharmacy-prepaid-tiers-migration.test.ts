import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'prisma/migrations/20261117221611_pharmacy_prepaid_tiers/migration.sql',
  'utf8'
);
describe('DEV-863 prepaid migration', () => {
  it('is transactional, idempotent and seeds no tier or balance', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/INSERT INTO|DISABLE TRIGGER|DISABLE ROW LEVEL SECURITY/);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS pharmacy_prepaid_accounts');
  });
  it('isolates all new tenant tables and keeps money evidence immutable', () => {
    for (const table of [
      'pharmacy_prepaid_accounts',
      'pharmacy_prepaid_entries',
      'pharmacy_prepaid_tier_versions',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY tenant_isolation ON ${table}`);
    }
    for (const table of ['pharmacy_prepaid_entries', 'pharmacy_prepaid_tier_versions'])
      expect(sql).toContain(`BEFORE UPDATE OR DELETE ON ${table}`);
    expect(sql).toContain('CHECK ("balanceMinor" >= 0)');
    expect(sql).toContain('CHECK ("refundableMinor" BETWEEN 0 AND "balanceMinor")');
  });
  it('requires balances to reconcile to immutable ledger entries at commit', () => {
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('SUM("amountMinor")');
    expect(sql).toContain("RAISE EXCEPTION 'Prepaid account must reconcile to its ledger'");
  });
  it('ties tier state and every post-movement snapshot to the ledger, not only the sums', () => {
    expect(sql).toContain('UNIQUE ("organizationId", "accountId", sequence)');
    expect(sql).toContain("RAISE EXCEPTION 'Prepaid tier change requires a ledger entry'");
    expect(sql).toContain("RAISE EXCEPTION 'Prepaid entry balance must match its ledger position'");
    expect(sql).toContain('SUM(e."amountMinor") OVER w AS running_balance');
    expect(sql).toContain('LAG(e."tierAfter") OVER w AS previous_tier');
  });
  it('checks tier price evidence on inserted lines as well as updated ones, at commit', () => {
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER pharmacy_prepaid_line_evidence AFTER INSERT OR UPDATE ON pharmacy_sale_lines\s+DEFERRABLE INITIALLY DEFERRED/
    );
    expect(sql).toContain('("tierDiscountMinor" = 0) = ("tierName" IS NULL)');
    // Only allocations that take a tier share are held to the cost floor.
    expect(sql).toContain('OR (d.value::bigint > 0 AND');
    expect(sql).toContain(
      'CREATE TRIGGER pharmacy_prepaid_freeze_line BEFORE UPDATE ON pharmacy_sale_lines'
    );
  });
  it('stores only a hash of the customer spend PIN', () => {
    expect(sql).toContain('"spendPinHash" TEXT');
    expect(sql).not.toMatch(/"spendPin"\s/);
  });
});
