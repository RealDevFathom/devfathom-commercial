import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('prisma/migrations/20261026000000_pharmacy_native_ap/migration.sql'),
  'utf8'
);

describe('native AP durable accounting migration', () => {
  it('tenant-binds invoices to their canonical journal entries', () => {
    expect(migration).toMatch(
      /invoices_journal_fkey[\s\S]*FOREIGN KEY \("organizationId","journalEntryId"\)[\s\S]*REFERENCES "finance_journal_entries"\("organizationId","id"\)/
    );
  });

  it('tenant-binds settlements to their canonical bookkeeping transactions', () => {
    expect(migration).toMatch(
      /settlements_transaction_fkey[\s\S]*FOREIGN KEY \("organizationId","bookkeepingTransactionId"\)[\s\S]*REFERENCES "pharmacy_bookkeeping_transactions"\("organizationId","id"\)/
    );
  });

  it('records both effective and durable invoice-event clocks', () => {
    const eventTable = migration.match(
      /CREATE TABLE "pharmacy_supplier_expense_invoice_events" \(([\s\S]*?)\n\);/
    )?.[1];
    expect(eventTable).toContain('"occurredAt" TIMESTAMP(3) NOT NULL');
    expect(eventTable).toContain('"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
  });
});
