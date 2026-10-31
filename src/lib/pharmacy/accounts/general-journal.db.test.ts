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
    await client.query(`CREATE TEMP TABLE finance_journal_entries (
      id text, "organizationId" text, "branchId" text, "sourceKind" "FinanceSourceKind",
      "sourceId" text, currency "Currency", "occurredAt" timestamp, "reversesEntryId" text
    )`);
    await client.query(`CREATE TEMP TABLE finance_journal_lines (
      "organizationId" text, "entryId" text, "accountCode" "FinanceAccountCode",
      side "FinanceJournalSide", "amountMinor" integer, "branchId" text
    )`);
    await client.query(`CREATE TEMP TABLE journal_immutability_test (
      id text, status "PharmacyGeneralJournalStatus" NOT NULL,
      "organizationId" text, "branchId" text, reference text,
      purpose "PharmacyGeneralJournalPurpose", "amountMinor" integer, currency "Currency",
      "occurredAt" timestamp, evidence text, reason text,
      "journalEntryId" text, "reversalEntryId" text, "postedAt" timestamp,
      "postKey" text, "postPayloadHash" text, "reversedAt" timestamp,
      "reverseKey" text, "reversePayloadHash" text
    )`);
    await client.query(`CREATE TRIGGER journal_immutability_test_trigger BEFORE UPDATE ON journal_immutability_test
      FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_posted_mutation()`);
    await client.query(`INSERT INTO journal_immutability_test
      (id, status, "organizationId", "branchId", reference, purpose, "amountMinor", currency, "occurredAt", evidence, reason, "journalEntryId", "postedAt", "postKey", "postPayloadHash") VALUES
      ('document-1', 'POSTED', 'org', 'branch', 'posted', 'NONTRADE_OPERATING_ACCRUAL', 100, 'PKR', '2026-01-01', 'evidence', 'reason', 'entry-1', now(), 'post-key', 'post-hash')`);
    await client.query(`INSERT INTO finance_journal_entries VALUES
      ('entry-1', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'document-1', 'PKR', '2026-01-01', NULL),
      ('canonical-reversal', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'document-1', 'PKR', '2026-01-02', 'entry-1'),
      ('unrelated-reversal', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'document-1', 'PKR', '2026-01-02', 'other-entry'),
      ('not-a-reversal', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'document-1', 'PKR', '2026-01-02', NULL)`);
    await client.query(`INSERT INTO finance_journal_lines VALUES
      ('org', 'entry-1', 'OPERATING_EXPENSE', 'DEBIT', 100, 'branch'),
      ('org', 'entry-1', 'MANUAL_NONTRADE_ACCRUAL', 'CREDIT', 100, 'branch')`);

    await expect(client.query(`UPDATE journal_immutability_test SET status = 'DRAFT' WHERE reference = 'posted'`)).rejects.toThrow(/status cannot regress/);
    await expect(client.query(`UPDATE journal_immutability_test SET "journalEntryId" = 'entry-other' WHERE reference = 'posted'`)).rejects.toThrow(/immutable/);
    await expect(client.query(`UPDATE journal_immutability_test SET status = 'REVERSED' WHERE reference = 'posted'`)).rejects.toThrow(/canonical reversal/);
    for (const reversalEntryId of ['unrelated-reversal', 'not-a-reversal']) {
      await expect(client.query(`UPDATE journal_immutability_test SET status = 'REVERSED', "reversalEntryId" = $1,
        "reversedAt" = now(), "reverseKey" = 'reverse-key', "reversePayloadHash" = 'reverse-hash' WHERE reference = 'posted'`, [reversalEntryId])).rejects.toThrow(/canonical reversal/);
    }
    await expect(client.query(`UPDATE journal_immutability_test SET "reversalEntryId" = 'canonical-reversal' WHERE reference = 'posted'`)).rejects.toThrow(/immutable/);
    await expect(client.query(`UPDATE journal_immutability_test SET status = 'REVERSED', "reversalEntryId" = 'canonical-reversal',
      "reversedAt" = now(), "reverseKey" = 'reverse-key', "reversePayloadHash" = 'reverse-hash' WHERE reference = 'posted'`)).resolves.toMatchObject({ rowCount: 1 });
    await expect(client.query(`UPDATE journal_immutability_test SET status = 'DRAFT' WHERE reference = 'posted'`)).rejects.toThrow(/status cannot regress/);
    await expect(client.query(`UPDATE journal_immutability_test SET "reversalEntryId" = 'unrelated-reversal' WHERE reference = 'posted'`)).rejects.toThrow(/immutable/);
  });

  it('rejects forged lifecycle inserts and preserves posted and reversed evidence on delete', async () => {
    await client.query(`CREATE TEMP TABLE journal_lifecycle_test (
      id text, status "PharmacyGeneralJournalStatus" NOT NULL DEFAULT 'DRAFT',
      "journalEntryId" text, "reversalEntryId" text, "postedAt" timestamp,
      "cancelledAt" timestamp, "reversedAt" timestamp, "postKey" text,
      "postPayloadHash" text, "reverseKey" text, "reversePayloadHash" text
    )`);
    await client.query(`CREATE TRIGGER journal_lifecycle_test_trigger BEFORE INSERT OR DELETE ON journal_lifecycle_test
      FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_lifecycle_bypass()`);
    for (const status of ['POSTED', 'REVERSED', 'CANCELLED']) {
      await expect(client.query(`INSERT INTO journal_lifecycle_test (id, status) VALUES ('forged', $1)`, [status]))
        .rejects.toThrow(/unposted drafts/);
    }
    await expect(client.query(`INSERT INTO journal_lifecycle_test (id, "journalEntryId") VALUES ('forged', 'entry-1')`))
      .rejects.toThrow(/unposted drafts/);
    await client.query(`INSERT INTO journal_lifecycle_test (id) VALUES ('draft'), ('posted'), ('reversed')`);
    // Isolate the INSERT/DELETE guard; canonical UPDATE linkage is tested above.
    await client.query(`UPDATE journal_lifecycle_test SET status = 'POSTED' WHERE id = 'posted'`);
    await client.query(`UPDATE journal_lifecycle_test SET status = 'REVERSED' WHERE id = 'reversed'`);
    for (const id of ['posted', 'reversed']) {
      await expect(client.query(`DELETE FROM journal_lifecycle_test WHERE id = $1`, [id]))
        .rejects.toThrow(/cannot be deleted/);
    }
    await expect(client.query(`DELETE FROM journal_lifecycle_test WHERE id = 'draft'`)).resolves.toMatchObject({ rowCount: 1 });
    const trigger = await client.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'pharmacy_general_journal_documents'::regclass AND tgname = 'pharmacy_general_journal_lifecycle_guard'`);
    expect(trigger.rows[0]?.definition).toMatch(/BEFORE INSERT OR DELETE/);
  });
});
