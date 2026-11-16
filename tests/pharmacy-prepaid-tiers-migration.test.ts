import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'prisma/migrations/20261117090600_pharmacy_prepaid_tiers/migration.sql',
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
});
