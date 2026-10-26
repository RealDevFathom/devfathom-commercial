/** @vitest-environment node */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const local = url && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
const describeDatabase = local ? describe : describe.skip;
let client: pg.Client;

describeDatabase('pharmacy general-journal database contract', () => {
  beforeAll(async () => { client = new pg.Client({ connectionString: url }); await client.connect(); });
  afterAll(async () => { await client?.end(); });

  it('pins both ledger links to an entry in the same organization', async () => {
    const result = await client.query<{ name: string }>(`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = 'pharmacy_general_journal_documents'::regclass AND contype = 'f'`);
    expect(result.rows.map((row) => row.name)).toEqual(expect.arrayContaining([
      'pharmacy_general_journal_documents_entry_fkey',
      'pharmacy_general_journal_documents_reversal_fkey',
    ]));
  });

  it('forces tenant row-level security', async () => {
    const result = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'pharmacy_general_journal_documents'::regclass`);
    expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('makes original and reversal linkage immutable after posting', async () => {
    const result = await client.query<{ definition: string }>(`
      SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      WHERE p.proname = 'prevent_pharmacy_general_journal_posted_mutation'`);
    expect(result.rows[0]?.definition).toContain('NEW."journalEntryId"');
    expect(result.rows[0]?.definition).toContain('NEW."reversalEntryId"');
  });
});
