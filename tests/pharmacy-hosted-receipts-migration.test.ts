import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261116120600_pharmacy_hosted_receipts/migration.sql',
  'utf8'
);

describe('DEV-16 hosted receipt migration contract', () => {
  it('is one idempotent transaction', () => {
    expect(
      sql
        .trimStart()
        .split('\n')
        .find((line) => !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_hosted_receipts"');
    expect(sql).toContain('DROP POLICY IF EXISTS');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "pharmacy_message_logs_kind_check"');
  });

  it('puts the new tenant table under forced tenant and branch RLS', () => {
    expect(sql).toContain('ALTER TABLE "pharmacy_hosted_receipts" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "pharmacy_hosted_receipts" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
  });

  it('stores only a token digest and binds the link to a sale and customer of the tenant', () => {
    expect(sql).toContain('"tokenHash" TEXT NOT NULL');
    expect(sql).toContain('CHECK ("tokenHash" ~ \'^[0-9a-f]{64}$\')');
    expect(sql).not.toMatch(/"token" TEXT/);
    expect(sql).toContain('"expiresAt" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain('REFERENCES "pharmacy_sales"("organizationId", "branchId", "id")');
    expect(sql).toContain('REFERENCES "pharmacy_customers"("organizationId", "id")');
  });

  it('keeps every existing WhatsApp kind while adding the receipt link kind', () => {
    for (const kind of [
      'REFILL_REMINDER',
      'KHATA_REMINDER',
      'ORDER_READY',
      'ORDER_REQUEST',
      'ORDER_CONFIRMATION',
      'ORDER_FALLBACK',
      'OPT_OUT',
      'OPT_IN',
      'CONSENT_ACK',
      'RECEIPT_LINK',
    ])
      expect(sql).toContain(`'${kind}'`);
  });

  it('keeps no one-time code state: the token alone opens the receipt', () => {
    expect(sql).not.toMatch(/otp/i);
  });
});
