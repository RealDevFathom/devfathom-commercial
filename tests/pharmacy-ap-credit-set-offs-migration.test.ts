import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sourceKind = readFileSync(
  'prisma/migrations/20261118122000_pharmacy_ap_credit_set_off_source_kind/migration.sql',
  'utf8'
);
const migration = readFileSync(
  'prisma/migrations/20261118122100_pharmacy_ap_credit_set_offs/migration.sql',
  'utf8'
);
const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8').trim().split('\n');

describe('DEV-694 AP credit-note set-off storage contract', () => {
  it('is transactional, idempotent and last in the migration ledger', () => {
    for (const sql of [sourceKind, migration]) {
      expect(
        sql
          .trimStart()
          .split('\n')
          .find((line) => !line.startsWith('--'))
      ).toBe('BEGIN;');
      expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    }
    expect(sourceKind).toContain(
      `ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_AP_CREDIT_SET_OFF'`
    );
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(ledger.indexOf('20261118122000_pharmacy_ap_credit_set_off_source_kind')).toBeLessThan(
      ledger.indexOf('20261118122100_pharmacy_ap_credit_set_offs')
    );
    expect(ledger.indexOf('20261118122100_pharmacy_ap_credit_set_offs')).toBeGreaterThan(0);
  });

  it('forces tenant and branch row-level security on the new table', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_ap_credit_set_offs" ENABLE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_ap_credit_set_offs" FORCE ROW LEVEL SECURITY'
    );
    expect(migration).toContain(
      'CREATE POLICY tenant_branch_isolation ON "pharmacy_ap_credit_set_offs"'
    );
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
  });

  it('ties every set-off to a same-branch bill, a credit and, once approved, one ledger entry', () => {
    expect(migration).toContain(
      'REFERENCES "pharmacy_ap_invoices"("organizationId", "branchId", "id")'
    );
    expect(migration).toContain('REFERENCES "pharmacy_supplier_credits"("organizationId", "id")');
    expect(migration).toContain('REFERENCES "finance_journal_entries"("organizationId", "id")');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_credit_set_offs_org_entry_key"'
    );
    expect(migration).toMatch(
      /"status" = 'APPROVED' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL\s+AND "decisionKey" IS NOT NULL AND "journalEntryId" IS NOT NULL/
    );
    expect(migration).toMatch(/"status" = 'PENDING'[^)]*"journalEntryId" IS NULL/);
  });

  it('keeps money positive and in PKR, never deletes a row and freezes the request', () => {
    expect(migration).toContain('CHECK ("amountMinor" > 0)');
    expect(migration).toContain(`CHECK ("currency" = 'PKR')`);
    expect(migration).toContain('pharmacy AP credit set-offs cannot be deleted');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_ap_credit_set_offs"');
    expect(migration).toContain(`IF OLD."status" <> 'PENDING' THEN`);
    expect(migration).toContain('OLD."amountMinor" IS DISTINCT FROM NEW."amountMinor"');
    expect(migration).toContain('OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId"');
    expect(migration).toContain('OLD."supplierCreditId" IS DISTINCT FROM NEW."supplierCreditId"');
  });
});
