import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('./20261023000399_invoice_number_sequences/migration.sql', import.meta.url),
  'utf8'
);

describe('invoice number sequence migration', () => {
  it('backfills tenant/year maxima and replaces the global invoice-number constraint', () => {
    expect(migration).toContain('MAX(substring("invoiceNumber"');
    expect(migration).toContain('DROP INDEX "invoices_invoiceNumber_key"');
    expect(migration).toContain('ON "invoices"("organizationId", "invoiceNumber")');
  });

  it('keeps the high-water mark current for old writers during rollout', () => {
    expect(migration.trimStart()).toStartWith('BEGIN;');
    expect(migration).toContain('LOCK TABLE "invoices" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain('CREATE TRIGGER invoices_sync_number_sequence');
    expect(migration).toContain('AFTER INSERT OR UPDATE OF "invoiceNumber", "organizationId"');
    expect(migration).toContain('GREATEST(');
    expect(migration).toContain('EXCLUDED."nextNumber"');
    expect(migration.trimEnd()).toEndWith('COMMIT;');
  });
});
