import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const NAME = '20261118124100_pharmacy_card_terminal_review_resolution';
const ATTEMPTS = '20261118120100_pharmacy_card_terminal_attempts';
const COUNTER = '20261118123600_pharmacy_card_terminal_counter';
const sql = readFileSync(`prisma/migrations/${NAME}/migration.sql`, 'utf8');
const original = readFileSync(`prisma/migrations/${ATTEMPTS}/migration.sql`, 'utf8');

const guardBody = (text: string) => {
  const start = text.indexOf('CREATE OR REPLACE FUNCTION pharmacy_card_terminal_attempt_guard()');
  return text.slice(start, text.indexOf('END $$;', start));
};

describe('DEV-743 card-terminal review resolution migration contract', () => {
  it('is one idempotent, additive transaction, ordered after the terminal migrations', () => {
    expect(
      sql
        .trimStart()
        .split('\n')
        .find((line) => line.trim() && !line.startsWith('--'))
    ).toBe('BEGIN;');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(2);
    expect(sql).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
    for (const constraint of [
      'pharmacy_card_terminal_attempts_resolution_no_pan_check',
      'pharmacy_card_terminal_attempts_resolution_check',
    ])
      expect(sql).toContain(`WHERE conname = '${constraint}'`);
    // Nothing is dropped, deleted, truncated or switched off (the guard still refuses DELETE).
    expect(sql).not.toMatch(/\bDROP\b|DELETE FROM|\bTRUNCATE\b|\bDISABLE\b/);
    const migrations = readdirSync('prisma/migrations')
      .filter((entry) => /^\d{14}_/.test(entry))
      .sort();
    expect(migrations.at(-1)).toBe(NAME);
    const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')
      .trim()
      .split('\n');
    expect(ledger.at(-1)).toBe(NAME);
    expect(ledger.indexOf(NAME)).toBeGreaterThan(ledger.indexOf(COUNTER));
  });

  it('keeps every rule of the attempt guard it replaces', () => {
    const before = guardBody(original);
    const after = guardBody(sql);
    const rules = before.match(/RAISE EXCEPTION '[^']+'/g) ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(7);
    for (const rule of rules) expect(after).toContain(rule);
    // The allowed lifecycle is unchanged, line for line.
    const lifecycle = (text: string) =>
      text.slice(text.indexOf('IF NOT ('), text.indexOf('THEN', text.indexOf('IF NOT (')));
    expect(lifecycle(after)).toBe(lifecycle(before));
  });

  it('requires who, why and the slip reference to resolve a review, written once', () => {
    const after = guardBody(sql);
    expect(after).toContain('a pharmacy card-terminal review is resolved once');
    expect(after).toContain(
      'a pharmacy card-terminal review needs its resolver, reason and slip reference'
    );
    expect(after).toContain(
      'a reversed pharmacy card-terminal charge must match its slip reference'
    );
    expect(sql).toContain(`concat_ws(' ', "resolutionReason", "resolutionRef") !~ '[0-9]{13,}'`);
  });
});
