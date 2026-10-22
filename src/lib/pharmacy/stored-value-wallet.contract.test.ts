import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync('prisma/schema.prisma', 'utf8');
const migration = readFileSync('prisma/migrations/20261023136001_pharmacy_stored_value_wallet/migration.sql', 'utf8');
const ledger = readFileSync('src/lib/stored-value/ledger.ts', 'utf8');

describe('stored-value persistence contract', () => {
  it('stores no full CNIC or image and tenants every wallet table', () => {
    const account = schema.slice(schema.indexOf('model StoredValueAccount'), schema.indexOf('model StoredValueJournal'));
    expect(account).not.toMatch(/cnic(Full|Image|Number)/i);
    expect(account).toContain('cnicLast4');
    expect(account).toContain('cnicHmac');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('app.current_organization_id', true)");
  });

  it('makes the double-entry ledger immutable and balanced', () => {
    expect(migration).toContain('stored_value_entries_immutable');
    expect(migration).toContain('stored_value_journals_immutable');
    expect(migration).toContain('stored_value_entries_balanced');
    expect(migration).toContain('sum("amountMinor")');
  });

  it('requires top-up attribution and adjustment reasons in the database', () => {
    expect(migration).toContain('stored_value_journals_topup_attribution_check');
    expect(migration).toContain('stored_value_journals_adjustment_reason_check');
  });

  it('serializes spends and conditionally prevents concurrent overdraft', () => {
    expect(ledger).toContain('FOR UPDATE');
    expect(ledger).toContain('"balanceMinor" + ${delta} >= 0');
    expect(ledger).toContain("StoredValueError('INSUFFICIENT_BALANCE')");
  });

  it('isolates idempotency and reads by tenant', () => {
    expect(migration).toContain('stored_value_journals_org_idempotency_key');
    expect(ledger).toContain('WHERE "organizationId"=${organizationId} AND "accountId"=${accountId}');
  });
});
