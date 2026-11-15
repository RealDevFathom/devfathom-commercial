import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// QA-12 / DEV-813. Migrations that existed when this rule was adopted are
// frozen in the fixture (never rename or re-stamp them: they may already be
// applied). Every migration added afterwards must be stamped later than the
// newest legacy one, have a unique timestamp, and be wrapped in BEGIN/COMMIT.
const MIGRATIONS_DIR = 'prisma/migrations';
const legacy = readFileSync('tests/fixtures/legacy-migration-names.txt', 'utf8')
  .split('\n')
  .filter(Boolean);
const legacySet = new Set(legacy);
const newestLegacy = legacy.map((n) => n.slice(0, 14)).sort().at(-1)!;

const all = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const added = all.filter((n) => !legacySet.has(n));

describe('migration timestamp order and wrapping rules', () => {
  it('keeps every legacy migration in place (no rename or re-stamp)', () => {
    expect(all.filter((n) => legacySet.has(n))).toEqual(legacy.slice().sort());
  });

  it('names every migration with a 14-digit timestamp prefix', () => {
    for (const name of all) expect(name).toMatch(/^\d{14}(_[a-z0-9_]+)?$/);
  });

  it('stamps new migrations after every existing migration', () => {
    for (const name of added) {
      expect(name.slice(0, 14) > newestLegacy, `${name} must be later than ${newestLegacy}`).toBe(true);
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
});
