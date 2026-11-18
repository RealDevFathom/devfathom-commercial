import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261118120100_pharmacy_card_terminal_attempts/migration.sql',
  'utf8'
);
const schema = readFileSync('prisma/schema.prisma', 'utf8');

describe('DEV-743 card-terminal attempt migration contract', () => {
  it('is one idempotent transaction', () => {
    expect(
      sql
        .trimStart()
        .split('\n')
        .find((line) => line.trim() && !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "pharmacy_card_terminal_attempts"');
    expect(sql).toContain('EXCEPTION WHEN duplicate_object THEN NULL');
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    // Every trigger is created only when it does not already exist.
    expect(sql.match(/CREATE TRIGGER/g)).toHaveLength(2);
    expect(sql.match(/SELECT 1 FROM pg_trigger WHERE tgname = /g)).toHaveLength(2);
    expect(sql).toContain('DROP POLICY IF EXISTS');
  });

  it('puts the new tenant table under forced tenant and branch RLS', () => {
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_card_terminal_attempts" ENABLE ROW LEVEL SECURITY'
    );
    expect(sql).toContain('ALTER TABLE "pharmacy_card_terminal_attempts" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.current_organization_id', true)");
    expect(sql).toContain("current_setting('app.current_branch_id', true)");
  });

  it('keeps one open terminal operation per sale and one tender per approval', () => {
    expect(sql).toMatch(
      /"pharmacy_card_terminal_attempts_one_open_key"\s+ON "pharmacy_card_terminal_attempts" \("organizationId", "saleId"\)\s+WHERE "status" IN \('CREATED', 'SENT', 'UNKNOWN', 'APPROVED', 'MANUAL_REVIEW'\)/
    );
    expect(sql).toContain('"pharmacy_card_terminal_attempts_provider_ref_key"');
    expect(sql).toContain('"pharmacy_card_terminal_attempts_tender_key"');
    expect(sql).toContain('pharmacy_tenders_card_terminal_guard');
  });

  it('stores no card number and never a manual, sandbox, prepaid or mock provider name', () => {
    expect(sql).toContain(`"cardLast4" ~ '^[0-9]{4}$'`);
    // Tenders post in PKR with no conversion: no other charge currency is ever stored.
    expect(sql).toContain(`CHECK ("currency" = 'PKR')`);
    expect(sql).toContain(`!~ '[0-9]{13,}'`);
    for (const name of [
      'MOCK',
      'MANUAL_TERMINAL',
      'MANUAL_MERCHANT',
      'LOCAL_TOKEN_SANDBOX',
      'CUSTOMER_PREPAID',
    ])
      expect(sql).toContain(`'${name}'`);
    expect(sql).not.toMatch(/"(pan|cvv|track\d?|expiry|pin)" TEXT/i);
  });

  it('never deletes an attempt and only moves it forward along the lifecycle', () => {
    expect(sql).toContain('pharmacy card-terminal attempts are never deleted');
    expect(sql).toContain(
      "(OLD.\"status\" = 'CREATED' AND NEW.\"status\" IN ('SENT', 'ABANDONED'))"
    );
    expect(sql).toContain('an approved pharmacy card-terminal charge cannot be marked declined');
    expect(sql).toContain('a settled pharmacy card-terminal attempt must match its tender');
  });

  it('matches the Prisma model and its enum', () => {
    expect(schema).toContain('model PharmacyCardTerminalAttempt {');
    expect(schema).toContain('@@map("pharmacy_card_terminal_attempts")');
    const enumBlock = schema.match(/enum PharmacyCardTerminalAttemptStatus \{([\s\S]*?)\}/)![1];
    const values = enumBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('///'));
    for (const value of values) expect(sql).toContain(`'${value}'`);
    expect(values).toEqual([
      'CREATED',
      'SENT',
      'UNKNOWN',
      'APPROVED',
      'SETTLED',
      'DECLINED',
      'ABANDONED',
      'MANUAL_REVIEW',
      'REVERSED',
    ]);
  });
});
