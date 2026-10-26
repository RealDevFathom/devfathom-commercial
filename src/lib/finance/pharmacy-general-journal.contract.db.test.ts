/** @vitest-environment node */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const local = url && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
const describeDatabase = local ? describe : describe.skip;
let client: pg.Client;

describeDatabase('pharmacy voucher canonical-ledger contract', () => {
  beforeAll(async () => { client = new pg.Client({ connectionString: url }); await client.connect(); });
  afterAll(async () => { await client?.end(); });

  it('retains the append-only and balanced-journal database guards', async () => {
    const result = await client.query<{ name: string }>(`
      SELECT tgname AS name FROM pg_trigger
      WHERE tgrelid IN ('finance_journal_entries'::regclass, 'finance_journal_lines'::regclass)
        AND NOT tgisinternal`);
    const names = result.rows.map((row) => row.name).join(' ');
    expect(names).toMatch(/append|immutable/i);
    expect(names).toMatch(/balance/i);
  });

  it('allows at most one canonical reversal per organization and entry', async () => {
    const result = await client.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'finance_journal_entries'`);
    expect(result.rows.map((row) => row.indexdef).join('\n')).toContain('(\"organizationId\", \"reversesEntryId\")');
  });
});
