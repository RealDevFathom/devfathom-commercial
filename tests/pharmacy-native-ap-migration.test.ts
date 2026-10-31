import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('prisma/migrations/20261026000000_pharmacy_native_ap/migration.sql'),
  'utf8'
);

const schema = readFileSync(resolve('prisma/schema.prisma'), 'utf8');
const guards = readFileSync(resolve('prisma/migrations/20261031150000_pharmacy_native_ap_guards/migration.sql'), 'utf8');
const actorMigration = readFileSync(
  resolve('prisma/migrations/20261031140000_pharmacy_native_ap_settlement_actor/migration.sql'), 'utf8'
);

describe('native AP durable accounting migration', () => {
  it('maps every native AP index to its shipped PostgreSQL name without truncation collisions', () => {
    const indices = [...migration.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"/g)].map(match => match[1]!);
    expect(indices).toHaveLength(15);
    for (const name of indices) {
      expect(name.length).toBeLessThanOrEqual(63);
      if (name === 'pharmacy_supplier_expense_invoices_identity_key') {
        const invoiceModel = schema.match(/model PharmacySupplierExpenseInvoice \{([\s\S]*?)\n\}/)?.[1];
        expect(invoiceModel).toBeDefined();
        expect(invoiceModel).not.toContain('@@unique([organizationId, supplierId, supplierInvoiceRef]');
        expect(guards).toContain(`DROP INDEX ${name}`);
        expect(guards).toMatch(/CREATE UNIQUE INDEX pharmacy_supplier_expense_invoices_identity_key[\s\S]*?WHERE status <> 'VOID'/);
      } else {
        expect(schema).toContain(`map: "${name}"`);
      }
    }
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('matches foreign-key names and update actions to the shipped DDL', () => {
    const foreignKeys = [...migration.matchAll(/CONSTRAINT "([^"]+)" FOREIGN KEY [^\n]+/g)];
    expect(foreignKeys).toHaveLength(8);
    for (const [ddl, name] of foreignKeys) {
      const relation = schema.split('\n').find(line => line.includes(`map: "${name}"`));
      expect(relation).toBeDefined();
      expect(relation).toContain('onDelete: Restrict');
      expect(relation).toContain(`onUpdate: ${ddl.includes('ON UPDATE CASCADE') ? 'Cascade' : ddl.includes('ON UPDATE RESTRICT') ? 'Restrict' : 'NoAction'}`);
    }
  });

  it('backfills actors from the tenant-matched canonical payment before requiring them', () => {
    expect(actorMigration).toContain(`set_config('app.is_platform_admin', 'true', true)`);
    expect(actorMigration).toContain('t."organizationId" = s."organizationId"');
    expect(actorMigration).toContain('t.id = s."bookkeepingTransactionId"');
    expect(actorMigration.indexOf('SET "createdByUserId" = t."createdByUserId"')).toBeLessThan(actorMigration.indexOf('SET NOT NULL'));
    expect(actorMigration).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/);
  });

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
