import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supplierExpenseAging } from '@/lib/pharmacy/native-ap';

const url = process.env.DATABASE_URL;
const describeIfDatabase = url ? describe : describe.skip;
const client = url ? new pg.Client({ connectionString: url }) : null;

describeIfDatabase('native AP historical aging in PostgreSQL', () => {
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url!).hostname))
      throw new Error('Refusing to run the native AP history probe against a non-local database.');
    await client!.connect();
    await client!.query('BEGIN');
    await client!.query(`
      CREATE TEMP TABLE pharmacy_supplier_expense_invoices (
        id text PRIMARY KEY, "organizationId" text, "branchId" text, "supplierInvoiceRef" text,
        description text, "issuedAt" timestamptz, "dueAt" timestamptz,
        "amountMinor" integer, "createdAt" timestamptz
      );
      CREATE TEMP TABLE pharmacy_supplier_expense_settlements (
        id text, "organizationId" text, "invoiceId" text, "amountMinor" integer,
        "occurredAt" timestamptz, "createdAt" timestamptz
      );
      CREATE TEMP TABLE pharmacy_supplier_expense_settlement_reversals (
        id text, "organizationId" text, "settlementId" text,
        "reversedAt" timestamptz, "createdAt" timestamptz
      );
      CREATE TEMP TABLE pharmacy_supplier_expense_invoice_events (
        id text, "organizationId" text, "invoiceId" text, kind text,
        "occurredAt" timestamptz, "createdAt" timestamptz
      );
      INSERT INTO pharmacy_supplier_expense_invoices VALUES
        ('invoice', 'org', 'branch', 'REF', 'Utilities', '2026-01-01Z', '2026-01-15Z', 100, '2026-01-01Z'),
        ('old-invoice', 'org', 'branch', 'OLD', 'Old utilities', '2024-01-01Z', '2024-02-01Z', 500, '2024-01-01Z');
      INSERT INTO pharmacy_supplier_expense_invoice_events VALUES
        ('void', 'org', 'invoice', 'VOID', '2026-01-15Z', '2026-03-02Z');
    `);
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    await client?.end();
  });

  it('keeps a backdated void that was recorded later out of an earlier as-of report', async () => {
    const database = {
      $queryRaw: async (statement: { strings: readonly string[]; values: readonly unknown[] }) => {
        const text = statement.strings.reduce(
          (sql, part, index) => sql + part + (index < statement.values.length ? `$${index + 1}` : ''),
          ''
        );
        return (await client!.query(text, [...statement.values])).rows;
      },
    } as never;
    const report = await supplierExpenseAging(
      database,
      { organizationId: 'org', branchId: 'branch' },
      { from: new Date('2026-01-01Z'), asOf: new Date('2026-02-01Z') }
    );
    expect(report.rows).toEqual([
      expect.objectContaining({ id: 'old-invoice', outstandingMinor: 500 }),
      expect.objectContaining({ id: 'invoice', outstandingMinor: 100 }),
    ]);
  });
});
