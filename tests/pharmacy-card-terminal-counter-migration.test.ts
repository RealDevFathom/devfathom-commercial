import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const NAME = '20261118123600_pharmacy_card_terminal_counter';
const ATTEMPTS = '20261118120100_pharmacy_card_terminal_attempts';
const sql = readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8');

describe('DEV-743 card-terminal counter migration contract', () => {
  it('is one idempotent, additive transaction, ordered after the attempt table', () => {
    expect(
      sql
        .trimStart()
        .split('\n')
        .find((line) => line.trim() && !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(1);
    expect(sql).toContain(
      "SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_daily_closes_card_terminal_guard'"
    );
    expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE|ALTER TABLE)\b/);
    // It builds on the attempt table, so it runs after that migration in both orders.
    const migrations = readdirSync('prisma/migrations')
      .filter((entry) => /^\d{14}_/.test(entry))
      .sort();
    expect(migrations.indexOf(NAME)).toBeGreaterThan(migrations.indexOf(ATTEMPTS));
    const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')
      .trim()
      .split('\n');
    expect(ledger.indexOf(NAME)).toBeGreaterThan(ledger.indexOf(ATTEMPTS));
    expect(ledger.indexOf(ATTEMPTS)).toBeGreaterThanOrEqual(0);
  });

  it('keeps one tender per terminal approval and leaves manual slip references alone', () => {
    expect(sql).toMatch(
      /"pharmacy_tenders_terminal_provider_ref_key"\s+ON "pharmacy_tenders" \("organizationId", "provider", "providerRef"\)\s+WHERE "type" = 'CARD'/
    );
    for (const name of [
      'MOCK',
      'MANUAL_TERMINAL',
      'MANUAL_MERCHANT',
      'LOCAL_TOKEN_SANDBOX',
      'CUSTOMER_PREPAID',
    ])
      expect(sql).toContain(`'${name}'`);
  });

  it('refuses a day close while any open terminal attempt is on that day', () => {
    expect(sql).toContain('BEFORE INSERT ON "pharmacy_daily_closes"');
    expect(sql).toContain(
      `a."status" IN ('CREATED', 'SENT', 'UNKNOWN', 'APPROVED', 'MANUAL_REVIEW')`
    );
    expect(sql).toContain('a."businessDate" = NEW."businessDate"');
    expect(sql).toContain('a card-terminal payment is still open on this business day');
  });
});
