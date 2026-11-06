/** @vitest-environment node */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const local = url && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
const describeDatabase = local ? describe : describe.skip;
let client: pg.Client;

describeDatabase('pharmacy general-journal database contract', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it('pins both ledger links to an entry in the same organization', async () => {
    const result = await client.query<{ name: string }>(`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = 'pharmacy_general_journal_documents'::regclass AND contype = 'f'`);
    expect(result.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'pharmacy_general_journal_documents_entry_fkey',
        'pharmacy_general_journal_documents_reversal_fkey',
      ])
    );
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

    await expect(
      client.query(
        `UPDATE journal_immutability_test SET status = 'DRAFT' WHERE reference = 'posted'`
      )
    ).rejects.toThrow(/status cannot regress/);
    await expect(
      client.query(
        `UPDATE journal_immutability_test SET "journalEntryId" = 'entry-other' WHERE reference = 'posted'`
      )
    ).rejects.toThrow(/immutable/);
    await expect(
      client.query(
        `UPDATE journal_immutability_test SET status = 'REVERSED' WHERE reference = 'posted'`
      )
    ).rejects.toThrow(/canonical reversal/);
    for (const reversalEntryId of ['unrelated-reversal', 'not-a-reversal']) {
      await expect(
        client.query(
          `UPDATE journal_immutability_test SET status = 'REVERSED', "reversalEntryId" = $1,
        "reversedAt" = now(), "reverseKey" = 'reverse-key', "reversePayloadHash" = 'reverse-hash' WHERE reference = 'posted'`,
          [reversalEntryId]
        )
      ).rejects.toThrow(/canonical reversal/);
    }
    await expect(
      client.query(
        `UPDATE journal_immutability_test SET "reversalEntryId" = 'canonical-reversal' WHERE reference = 'posted'`
      )
    ).rejects.toThrow(/immutable/);
    await expect(
      client.query(`UPDATE journal_immutability_test SET status = 'REVERSED', "reversalEntryId" = 'canonical-reversal',
      "reversedAt" = now(), "reverseKey" = 'reverse-key', "reversePayloadHash" = 'reverse-hash' WHERE reference = 'posted'`)
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      client.query(
        `UPDATE journal_immutability_test SET status = 'DRAFT' WHERE reference = 'posted'`
      )
    ).rejects.toThrow(/status cannot regress/);
    await expect(
      client.query(
        `UPDATE journal_immutability_test SET "reversalEntryId" = 'unrelated-reversal' WHERE reference = 'posted'`
      )
    ).rejects.toThrow(/immutable/);
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
      await expect(
        client.query(`INSERT INTO journal_lifecycle_test (id, status) VALUES ('forged', $1)`, [
          status,
        ])
      ).rejects.toThrow(/unposted drafts/);
    }
    await expect(
      client.query(
        `INSERT INTO journal_lifecycle_test (id, "journalEntryId") VALUES ('forged', 'entry-1')`
      )
    ).rejects.toThrow(/unposted drafts/);
    await client.query(
      `INSERT INTO journal_lifecycle_test (id) VALUES ('draft'), ('posted'), ('reversed')`
    );
    // Isolate the INSERT/DELETE guard; canonical UPDATE linkage is tested above.
    await client.query(`UPDATE journal_lifecycle_test SET status = 'POSTED' WHERE id = 'posted'`);
    await client.query(
      `UPDATE journal_lifecycle_test SET status = 'REVERSED' WHERE id = 'reversed'`
    );
    for (const id of ['posted', 'reversed']) {
      await expect(
        client.query(`DELETE FROM journal_lifecycle_test WHERE id = $1`, [id])
      ).rejects.toThrow(/cannot be deleted/);
    }
    await expect(
      client.query(`DELETE FROM journal_lifecycle_test WHERE id = 'draft'`)
    ).resolves.toMatchObject({ rowCount: 1 });
    const trigger = await client.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'pharmacy_general_journal_documents'::regclass AND tgname = 'pharmacy_general_journal_lifecycle_guard'`);
    expect(trigger.rows[0]?.definition).toMatch(/BEFORE INSERT OR DELETE/);
  });

  it('rejects ledger lines appended to a voucher posting or reversal', async () => {
    await client.query(
      'DROP TABLE IF EXISTS pg_temp.finance_journal_lines, pg_temp.finance_journal_entries, pg_temp.pharmacy_general_journal_documents'
    );
    await client.query(
      `CREATE TEMP TABLE finance_journal_entries (id text, "organizationId" text, "sourceKind" "FinanceSourceKind")`
    );
    await client.query(
      `CREATE TEMP TABLE finance_journal_lines ("organizationId" text, "entryId" text, side "FinanceJournalSide", "amountMinor" integer)`
    );
    await client.query(
      `CREATE TEMP TABLE pharmacy_general_journal_documents ("organizationId" text, "journalEntryId" text, "reversalEntryId" text)`
    );
    await client.query(`CREATE TRIGGER voucher_shape_test_trigger BEFORE INSERT ON finance_journal_lines
      FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_journal_voucher_line_append()`);
    await client.query(`INSERT INTO finance_journal_entries VALUES
      ('voucher', 'org', 'PHARMACY_JOURNAL_VOUCHER'), ('linked', 'org', 'PHARMACY_JOURNAL_VOUCHER'),
      ('other', 'org', (SELECT e FROM unnest(enum_range(NULL::"FinanceSourceKind")) e WHERE e <> 'PHARMACY_JOURNAL_VOUCHER' LIMIT 1))`);
    await client.query(
      `INSERT INTO finance_journal_lines VALUES ('org', 'voucher', 'DEBIT', 100), ('org', 'voucher', 'CREDIT', 100)`
    );
    await expect(
      client.query(`INSERT INTO finance_journal_lines VALUES ('org', 'voucher', 'DEBIT', 50)`)
    ).rejects.toThrow(/fixed two-line shape/);
    await client.query(
      `INSERT INTO pharmacy_general_journal_documents VALUES ('org', NULL, 'linked')`
    );
    await expect(
      client.query(`INSERT INTO finance_journal_lines VALUES ('org', 'linked', 'DEBIT', 50)`)
    ).rejects.toThrow(/fixed two-line shape/);
    await expect(
      client.query(
        `INSERT INTO finance_journal_lines VALUES ('org', 'other', 'DEBIT', 50), ('org', 'other', 'CREDIT', 50), ('org', 'other', 'DEBIT', 5)`
      )
    ).resolves.toMatchObject({ rowCount: 3 });
    const trigger = await client.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'public.finance_journal_lines'::regclass AND tgname = 'finance_journal_lines_pharmacy_voucher_shape'`);
    expect(trigger.rows[0]?.definition).toMatch(/BEFORE INSERT/);
  });

  it('prevents cancelled vouchers from returning to any other state through SQL', async () => {
    await client.query(
      `CREATE TEMP TABLE journal_cancelled_test (id text, status "PharmacyGeneralJournalStatus")`
    );
    await client.query(`CREATE TRIGGER journal_cancelled_test_trigger BEFORE UPDATE ON journal_cancelled_test
      FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_cancelled_reopen()`);
    await client.query(`INSERT INTO journal_cancelled_test VALUES ('cancelled', 'CANCELLED')`);
    for (const status of ['DRAFT', 'POSTED', 'REVERSED']) {
      await expect(
        client.query(`UPDATE journal_cancelled_test SET status = $1 WHERE id = 'cancelled'`, [
          status,
        ])
      ).rejects.toThrow(/cancelled.*status cannot change/);
    }
    await expect(
      client.query(`UPDATE journal_cancelled_test SET status = 'CANCELLED' WHERE id = 'cancelled'`)
    ).resolves.toMatchObject({ rowCount: 1 });
    const trigger = await client.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = 'public.pharmacy_general_journal_documents'::regclass AND tgname = 'pharmacy_general_journal_cancelled_guard'`);
    expect(trigger.rows[0]?.definition).toMatch(/BEFORE UPDATE/);
  });

  it('enforces closed periods for voucher postings, reversals, and their ledger entries through SQL', async () => {
    await client.query(
      'DROP TABLE IF EXISTS pg_temp.finance_journal_lines, pg_temp.finance_journal_entries, pg_temp.pharmacy_general_journal_documents, pg_temp.pharmacy_accounting_periods'
    );
    await client.query(`CREATE TEMP TABLE pharmacy_accounting_periods (
      "organizationId" text, "branchId" text, "startsAt" timestamp(3), "endsAt" timestamp(3), status "PharmacyAccountingPeriodStatus"
    )`);
    await client.query(`CREATE TEMP TABLE finance_journal_entries (
      id text, "organizationId" text, "branchId" text, "sourceKind" "FinanceSourceKind", currency "Currency", "occurredAt" timestamp(3)
    )`);
    await client.query(`CREATE TRIGGER period_entry_test_trigger BEFORE INSERT ON finance_journal_entries
      FOR EACH ROW EXECUTE FUNCTION pharmacy_journal_voucher_entry_period_open()`);
    await client.query(`CREATE TEMP TABLE journal_period_test (
      id text, status "PharmacyGeneralJournalStatus", "organizationId" text, "branchId" text, currency "Currency",
      "occurredAt" timestamp(3), "reversedAt" timestamp(3), "reversalEntryId" text
    )`);
    await client.query(`CREATE TRIGGER journal_period_test_trigger BEFORE UPDATE ON journal_period_test
      FOR EACH ROW EXECUTE FUNCTION pharmacy_general_journal_period_and_reversal_date()`);
    await client.query(`INSERT INTO pharmacy_accounting_periods VALUES
      ('org', 'branch', '2026-01-01', '2026-02-01', 'CLOSED'),
      ('org', 'branch', '2026-03-01', '2026-04-01', 'REOPENED')`);

    // Ledger entries for vouchers cannot be dated in a closed period; reopened periods and other sources are unaffected.
    await expect(
      client.query(
        `INSERT INTO finance_journal_entries VALUES ('closed', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'PKR', '2026-01-15 12:00')`
      )
    ).rejects.toThrow(/PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
    await expect(
      client.query(
        `INSERT INTO finance_journal_entries VALUES ('unbranched', 'org', NULL, 'PHARMACY_JOURNAL_VOUCHER', 'PKR', '2026-02-15 12:00')`
      )
    ).rejects.toThrow(/must name a branch/);
    await expect(
      client.query(`INSERT INTO finance_journal_entries VALUES
      ('other-source', 'org', 'branch', (SELECT e FROM unnest(enum_range(NULL::"FinanceSourceKind")) e WHERE e <> 'PHARMACY_JOURNAL_VOUCHER' LIMIT 1), 'PKR', '2026-01-15 12:00'),
      ('reopened', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'PKR', '2026-03-15 12:00'),
      ('reversal-ok', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'PKR', '2026-02-20 12:00'),
      ('reversal-early', 'org', 'branch', 'PHARMACY_JOURNAL_VOUCHER', 'PKR', '2026-02-05 12:00')`)
    ).resolves.toMatchObject({ rowCount: 4 });

    await client.query(`INSERT INTO journal_period_test VALUES
      ('closed-draft', 'DRAFT', 'org', 'branch', 'PKR', '2026-01-15 12:00', NULL, NULL),
      ('open-draft', 'DRAFT', 'org', 'branch', 'PKR', '2026-02-10 12:00', NULL, NULL),
      ('posted', 'POSTED', 'org', 'branch', 'PKR', '2026-02-10 12:00', NULL, NULL)`);
    await expect(
      client.query(`UPDATE journal_period_test SET status = 'POSTED' WHERE id = 'closed-draft'`)
    ).rejects.toThrow(/PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
    await expect(
      client.query(`UPDATE journal_period_test SET status = 'POSTED' WHERE id = 'open-draft'`)
    ).resolves.toMatchObject({ rowCount: 1 });

    // Reversal dated in a closed period.
    await expect(
      client.query(
        `UPDATE journal_period_test SET status = 'REVERSED', "reversedAt" = '2026-01-20 12:00', "reversalEntryId" = 'reversal-ok' WHERE id = 'posted'`
      )
    ).rejects.toThrow(/precede|PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
    // The linked ledger entry must carry the recorded reversal date, not an earlier one.
    await expect(
      client.query(
        `UPDATE journal_period_test SET status = 'REVERSED', "reversedAt" = '2026-02-20 12:00', "reversalEntryId" = 'reversal-early' WHERE id = 'posted'`
      )
    ).rejects.toThrow(/recorded reversal date/);
    await expect(
      client.query(
        `UPDATE journal_period_test SET status = 'REVERSED', "reversedAt" = '2026-02-20 12:00', "reversalEntryId" = 'reversal-ok' WHERE id = 'posted'`
      )
    ).resolves.toMatchObject({ rowCount: 1 });

    const triggers = await client.query<{
      name: string;
    }>(`SELECT tgname AS name FROM pg_trigger WHERE tgname IN (
      'pharmacy_general_journal_period_and_reversal_date', 'finance_journal_entries_pharmacy_voucher_period_open', 'pharmacy_accounting_periods_scope_lock')`);
    expect(triggers.rows.map((row) => row.name).sort()).toEqual([
      'finance_journal_entries_pharmacy_voucher_period_open',
      'pharmacy_accounting_periods_scope_lock',
      'pharmacy_general_journal_period_and_reversal_date',
    ]);
  });

  it('rejects a reversal dated in a closed period even when it follows the voucher date', async () => {
    await client.query(`CREATE TEMP TABLE journal_period_reversal_test (
      id text, status "PharmacyGeneralJournalStatus", "organizationId" text, "branchId" text, currency "Currency",
      "occurredAt" timestamp(3), "reversedAt" timestamp(3), "reversalEntryId" text
    )`);
    await client.query(`CREATE TRIGGER journal_period_reversal_test_trigger BEFORE UPDATE ON journal_period_reversal_test
      FOR EACH ROW EXECUTE FUNCTION pharmacy_general_journal_period_and_reversal_date()`);
    await client.query(
      `INSERT INTO pharmacy_accounting_periods VALUES ('org', 'branch', '2026-05-01', '2026-06-01', 'CLOSED')`
    );
    await client.query(
      `INSERT INTO journal_period_reversal_test VALUES ('posted', 'POSTED', 'org', 'branch', 'PKR', '2026-04-10 12:00', NULL, NULL)`
    );
    await expect(
      client.query(
        `UPDATE journal_period_reversal_test SET status = 'REVERSED', "reversedAt" = '2026-05-10 12:00', "reversalEntryId" = 'reversal-ok' WHERE id = 'posted'`
      )
    ).rejects.toThrow(/PHARMACY_ACCOUNTING_PERIOD_CLOSED/);
  });
});
