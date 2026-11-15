import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HOW_TO_FIX,
  isAppendOnly,
  isUnchanged,
  LEDGER_FILE,
  LEGACY_FILE,
  readBaseLedger,
  readBaseList,
  readList,
} from '../scripts/qa/migration-rules';

// QA-12 / DEV-813. Migrations that existed when this rule was adopted are
// frozen in tests/fixtures/legacy-migration-names.txt (never rename or re-stamp
// them: they may already be applied). Every migration added afterwards is
// appended to the ordered ledger tests/fixtures/new-migration-order.txt. It
// must be stamped later than the newest legacy migration AND later than every
// migration before it in the ledger, have a unique timestamp, be wrapped in
// BEGIN/COMMIT, and be written to be safe to re-run.
const MIGRATIONS_DIR = 'prisma/migrations';
const legacy = readList(LEGACY_FILE);
const ledger = readList(LEDGER_FILE);
const legacySet = new Set(legacy);
const newestLegacy = legacy
  .map((n) => n.slice(0, 14))
  .sort()
  .at(-1)!;

const all = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const added = all.filter((n) => !legacySet.has(n));

describe('migration timestamp order and wrapping rules', () => {
  it('keeps the legacy list identical to origin/develop (no additions, removal or reorder)', (ctx) => {
    const base = readBaseList(LEGACY_FILE);
    if (base === null) {
      ctx.skip('origin/develop legacy list is unavailable locally; fetch origin develop');
      return;
    }
    expect(isUnchanged(base, legacy), `legacy list changed. ${HOW_TO_FIX}`).toBe(true);
  });

  it('keeps every legacy migration in place (no rename or re-stamp)', () => {
    expect(all.filter((n) => legacySet.has(n))).toEqual(legacy.slice().sort());
  });

  it('names every migration with a 14-digit timestamp prefix', () => {
    for (const name of all) expect(name).toMatch(/^\d{14}(_[a-z0-9_]+)?$/);
  });

  it('lists every new migration in the ordered ledger, and nothing else', () => {
    expect(new Set(ledger).size, `duplicate ledger entry. ${HOW_TO_FIX}`).toBe(ledger.length);
    expect(ledger.slice().sort(), `ledger and directory disagree. ${HOW_TO_FIX}`).toEqual(added);
  });

  it('only appends to the ledger on origin/develop (no insert, reorder or removal)', (ctx) => {
    const base = readBaseLedger();
    if (base === null) {
      ctx.skip('origin/develop ledger is unavailable locally; fetch origin develop');
      return;
    }
    expect(isAppendOnly(base, ledger), `ledger is not append-only. ${HOW_TO_FIX}`).toBe(true);
  });

  it('detects a middle insertion, reorder or removal as not append-only', () => {
    const base = ['20261120000000_a', '20261121000000_b'];
    expect(isAppendOnly(base, [...base, '20261122000000_c'])).toBe(true);
    expect(isAppendOnly(base, ['20261120000000_a', '20261120500000_m', '20261121000000_b'])).toBe(
      false
    );
    expect(isAppendOnly(base, ['20261121000000_b', '20261120000000_a'])).toBe(false);
    expect(isAppendOnly(base, ['20261120000000_a'])).toBe(false);
    expect(isAppendOnly([], base)).toBe(true);
  });

  it('stamps new migrations strictly later than all legacy and earlier ledger entries', () => {
    let previous = newestLegacy;
    for (const name of ledger) {
      const ts = name.slice(0, 14);
      expect(ts > previous, `${name} must be later than ${previous}. ${HOW_TO_FIX}`).toBe(true);
      previous = ts;
    }
  });

  it('gives new migrations unique timestamps', () => {
    const seen = new Set<string>();
    for (const name of added) {
      const ts = name.slice(0, 14);
      expect(seen.has(ts), `duplicate migration timestamp ${ts}`).toBe(false);
      seen.add(ts);
    }
  });

  it('wraps new migrations in BEGIN; ... COMMIT;', () => {
    for (const name of added) {
      const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      const body = sql.replace(/^(\s*--[^\n]*\n)+/, '').trim();
      expect(body, `${name} must start with BEGIN;`).toMatch(/^BEGIN;/);
      expect(body, `${name} must end with COMMIT;`).toMatch(/COMMIT;$/);
    }
  });

  it('writes new migrations to be safe to re-run', () => {
    for (const name of added) {
      const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')
        // guarded DO blocks and comments handle their own idempotency
        .replace(/DO\s+(\$[a-z_]*\$)[\s\S]*?\1/gi, '')
        .replace(/--[^\n]*/g, '');
      expect(sql, `${name}: CREATE TABLE/INDEX/SEQUENCE needs IF NOT EXISTS`).not.toMatch(
        /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|SEQUENCE)\s+(?!IF\s+NOT\s+EXISTS)/i
      );
      expect(sql, `${name}: ADD COLUMN needs IF NOT EXISTS`).not.toMatch(
        /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i
      );
      for (const m of sql.matchAll(/CREATE\s+POLICY\s+("?[\w]+"?)/gi)) {
        expect(
          new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+${m[1]}`, 'i').test(sql),
          `${name}: CREATE POLICY ${m[1]} needs a matching DROP POLICY IF EXISTS`
        ).toBe(true);
      }
    }
  });
});
