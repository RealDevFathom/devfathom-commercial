// @vitest-environment node
/**
 * #398 backfill: an invoice set PAID without a payment showed its whole total as
 * owed. The migration reconciles exactly the unrecorded shortfall of PAID invoices
 * with one labelled payment, touches nothing else, and is a no-op on re-run.
 *
 * Runs the migration's statements inside one transaction that is rolled back, as
 * the restricted runtime role under forced row-level security.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATION = '20261023090000_invoice_paid_payment_backfill';
const sql = readFileSync(`prisma/migrations/${MIGRATION}/migration.sql`, 'utf8');

// Statements without comments; the test owns the transaction, so BEGIN/COMMIT go.
function migrationStatements(source: string): string[] {
  const statements: string[] = [];
  let statement = '';
  const tokens = source.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|;|[^'";-]+|./g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('--')) statement += ' ';
    else if (token === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
    } else statement += token;
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements.filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
}

(databaseUrl ? describe : describe.skip)('PAID invoice payment backfill (#398)', () => {
  it('records only the unrecorded shortfall of PAID invoices, labelled and dated when paid', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    const suffix = randomBytes(6).toString('hex');
    const org = `bf398_${suffix}`;
    const id = (name: string) => `bf398_${name}_${suffix}`;
    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await client.query(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
         VALUES ($1, $1, $1, $1, now())`,
        [org]
      );
      await client.query(
        `INSERT INTO clients (id, "organizationId", name, "updatedAt") VALUES ($1, $2, 'Acme', now())`,
        [id('client'), org]
      );
      const paidAt = new Date('2026-03-14T10:00:00.000Z');
      const updatedAt = new Date('2026-04-01T08:00:00.000Z');
      const invoices: Array<[string, string, number, Date | null]> = [
        ['unrecorded', 'PAID', 1000, paidAt],
        ['partial', 'PAID', 1000, paidAt],
        ['covered', 'PAID', 500, paidAt],
        ['no_paid_at', 'PAID', 80.5, null],
        ['sent', 'SENT', 800, null],
        ['cancelled', 'CANCELLED', 300, null],
      ];
      for (const [name, status, total, invoicePaidAt] of invoices) {
        await client.query(
          `INSERT INTO invoices (id, "organizationId", "invoiceNumber", "clientId", items,
             subtotal, total, currency, status, "dueDate", "paidAt", "updatedAt")
           VALUES ($1, $2, $3, $4, '[]', $5, $5, 'PKR', $6::"InvoiceStatus", now(), $7, $8)`,
          [id(name), org, `INV-${id(name)}`, id('client'), total, status, invoicePaidAt, updatedAt]
        );
      }
      await client.query(
        `INSERT INTO payments (id, "organizationId", "invoiceId", amount, currency)
         VALUES ($1, $3, $4, 300, 'PKR'), ($2, $3, $5, 500, 'PKR')`,
        [id('pay_partial'), id('pay_covered'), org, id('partial'), id('covered')]
      );

      const statements = migrationStatements(sql);
      for (const statement of statements) await client.query(statement);

      const payments = async () =>
        (
          await client.query<{
            invoice: string;
            amount: string;
            currency: string;
            method: string | null;
            paidAt: Date;
          }>(
            `SELECT p."invoiceId" AS invoice, p.amount, p.currency, p.method, p."paidAt"
               FROM payments p JOIN invoices i ON i.id = p."invoiceId"
              WHERE i."organizationId" = $1
              ORDER BY p."invoiceId", p.amount`,
            [org]
          )
        ).rows.map((row) => ({ ...row, amount: Number(row.amount) }));

      const backfilled = (await payments()).filter(
        (row) => row.method === 'Marked paid (no payment recorded)'
      );
      expect(backfilled).toEqual([
        {
          invoice: id('no_paid_at'),
          amount: 80.5,
          currency: 'PKR',
          method: expect.any(String),
          paidAt: updatedAt,
        },
        {
          invoice: id('partial'),
          amount: 700,
          currency: 'PKR',
          method: expect.any(String),
          paidAt,
        },
        {
          invoice: id('unrecorded'),
          amount: 1000,
          currency: 'PKR',
          method: expect.any(String),
          paidAt,
        },
      ]);

      // Every PAID invoice now has payments covering its total; nothing else changed.
      const { rows: balances } = await client.query<{ id: string; balance: string }>(
        `SELECT i.id, i.total - COALESCE(SUM(p.amount), 0) AS balance
           FROM invoices i LEFT JOIN payments p ON p."invoiceId" = i.id
          WHERE i."organizationId" = $1 GROUP BY i.id ORDER BY i.id`,
        [org]
      );
      expect(Object.fromEntries(balances.map((b) => [b.id, Number(b.balance)]))).toEqual({
        [id('cancelled')]: 300,
        [id('covered')]: 0,
        [id('no_paid_at')]: 0,
        [id('partial')]: 0,
        [id('sent')]: 800,
        [id('unrecorded')]: 0,
      });

      // Re-running is a no-op.
      const before = (await payments()).length;
      for (const statement of statements) await client.query(statement);
      expect(await payments()).toHaveLength(before);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});
