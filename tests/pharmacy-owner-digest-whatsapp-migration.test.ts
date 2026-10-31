import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261029120000_owner_digest_whatsapp_audit/migration.sql',
  'utf8'
);

describe('owner digest WhatsApp audit migration', () => {
  it('preserves every existing message kind while adding the owner digest kind', () => {
    for (const kind of [
      'REFILL_REMINDER',
      'KHATA_REMINDER',
      'ORDER_REQUEST',
      'ORDER_CONFIRMATION',
      'ORDER_FALLBACK',
      'OPT_OUT',
      'OPT_IN',
      'CONSENT_ACK',
      'OWNER_DIGEST',
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
  });

  it('changes only the enum-like kind check, retaining the existing table and RLS policy', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check"'
    );
    expect(migration).not.toMatch(/\b(?:CREATE TABLE|DROP TABLE|DISABLE ROW LEVEL SECURITY)\b/);
  });
});

describe('owner digest WhatsApp consent migration', () => {
  const consentMigration = readFileSync(
    'prisma/migrations/20261031235900_owner_digest_whatsapp_consent/migration.sql',
    'utf8'
  );

  it('defaults every existing owner to no consent without backfilling from capture opt-in', () => {
    expect(consentMigration).toContain(
      'ALTER TABLE "pharmacy_owner_digest_settings" ADD COLUMN "whatsappPhoneHash" TEXT'
    );
    expect(consentMigration).not.toMatch(/\b(?:UPDATE|DEFAULT|NOT NULL|DROP|DISABLE)\b/);
  });
});
