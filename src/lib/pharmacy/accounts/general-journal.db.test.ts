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

  it('prevents posted and reversed vouchers from regressing or being relinked', async () => {
    await client.query(`CREATE TEMP TABLE journal_immutability_test (
      status "PharmacyGeneralJournalStatus" NOT NULL,
      "organizationId" text, "branchId" text, reference text,
      purpose "PharmacyGeneralJournalPurpose", "amountMinor" integer, currency "Currency",
      "occurredAt" timestamp, evidence text, reason text,
      "journalEntryId" text, "reversalEntryId" text
    )`);
    await client.query(`CREATE TRIGGER journal_immutability_test_trigger BEFORE UPDATE ON journal_immutability_test
      FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_posted_mutation()`);
    await client.query(`INSERT INTO journal_immutability_test
      (status, "organizationId", "branchId", reference, purpose, "amountMinor", currency, "occurredAt", evidence, reason, "journalEntryId", "reversalEntryId") VALUES
      ('POSTED', 'org', 'branch', 'posted', 'NONTRADE_OPERATING_ACCRUAL', 100, 'PKR', now(), 'evidence', 'reason', 'entry-1', NULL),
      ('REVERSED', 'org', 'branch', 'reversed', 'NONTRADE_OPERATING_ACCRUAL', 100, 'PKR', now(), 'evidence', 'reason', 'entry-2', 'reversal-1')`);

    await expect(client.query(`UPDATE journal_immutability_test SET status = 'DRAFT' WHERE reference = 'posted'`)).rejects.toThrow(/status cannot regress/);
    await expect(client.query(`UPDATE journal_immutability_test SET "journalEntryId" = 'entry-other' WHERE reference = 'posted'`)).rejects.toThrow(/immutable/);
    await expect(client.query(`UPDATE journal_immutability_test SET status = 'DRAFT' WHERE reference = 'reversed'`)).rejects.toThrow(/status cannot regress/);
    await expect(client.query(`UPDATE journal_immutability_test SET "reversalEntryId" = 'reversal-other' WHERE reference = 'reversed'`)).rejects.toThrow(/immutable/);
  });
});
