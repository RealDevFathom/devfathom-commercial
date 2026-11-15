import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sourceKind = readFileSync(
  'prisma/migrations/20261116090000_pharmacy_ap_invoice_source_kind/migration.sql',
  'utf8'
);
const migration = readFileSync(
  'prisma/migrations/20261116090200_pharmacy_ap_invoices/migration.sql',
  'utf8'
);

describe('DEV-103 native AP invoice storage contract', () => {
  it('is transactional and idempotent', () => {
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
      `ALTER TYPE "FinanceSourceKind" ADD VALUE IF NOT EXISTS 'PHARMACY_AP_INVOICE'`
    );
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
  });

  it('forces tenant and branch RLS on both new tables', () => {
    expect(migration).toContain(
      "FOREACH table_name IN ARRAY ARRAY['pharmacy_ap_invoices', 'pharmacy_ap_invoice_settlements']"
    );
    expect(migration).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
  });

  it('keeps one live invoice per payee and supplier invoice reference', () => {
    expect(migration).toMatch(
      /"pharmacy_ap_invoices_org_identity_live_key"\s+ON "pharmacy_ap_invoices"\("organizationId", "payeeKey", "supplierInvoiceRef"\)\s+WHERE "status" = 'POSTED'/
    );
  });

  it('links each settlement to exactly one canonical bookkeeping transaction', () => {
    expect(migration).toContain(
      'REFERENCES "pharmacy_bookkeeping_transactions"("organizationId", "id")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_ap_settlements_org_transaction_key"'
    );
  });

  it('never deletes invoices or settlements and freezes their financial fields', () => {
    expect(migration).toContain('pharmacy AP invoices cannot be deleted');
    expect(migration).toContain('pharmacy AP settlements cannot be deleted');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_ap_invoices"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "pharmacy_ap_invoice_settlements"');
    expect(migration).toContain('OLD."amountMinor" IS DISTINCT FROM NEW."amountMinor"');
    expect(migration).toContain('CHECK ("amountMinor" > 0)');
  });
});
