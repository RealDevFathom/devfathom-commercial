import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261116130000_pharmacy_write_off_solo_self_witness/migration.sql',
  'utf8'
);

describe('DEV-628 write-off custody solo self-witness migration', () => {
  it('is transactional and idempotent', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS pharmacy_custody_records_independent_witness ON "pharmacy_custody_records"'
    );
  });

  it('keeps an independent witness unless the PIN-verified solo marker names the actor', () => {
    const trigger = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(trigger).toContain('NEW."actorId" = NEW."witnessId"');
    expect(trigger).toContain(
      `COALESCE(current_setting('app.pharmacy_write_off_solo_witness_user_id', true), '') <> NEW."actorId"`
    );
    expect(trigger).toContain('RAISE EXCEPTION');
    expect(trigger).toContain('BEFORE INSERT ON "pharmacy_custody_records"');
  });

  it('keeps the reason and evidence requirements', () => {
    expect(sql).toContain('length(btrim("reason")) > 0 AND length(btrim("evidenceRef")) > 0');
  });

  it('does not touch row-level security or the append-only trigger', () => {
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/DROP POLICY/i);
    expect(sql).not.toContain('pharmacy_custody_records_append_only');
  });
});
