import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261115093000_controlled_register_solo_self_witness/migration.sql',
  'utf8'
);

describe('controlled register solo self-witness migration', () => {
  it('is transactional and idempotent', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('IF NOT EXISTS');
  });

  it('keeps the independent witness for every row except a PIN-signed solo restoration', () => {
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT'));
    expect(check).toContain('"recordedByUserId" <> "witnessedByUserId"');
    expect(check).toContain(`"entryKind" = 'CORRECTION'`);
    expect(check).toContain('"restorationMovementId" IS NOT NULL');
    expect(check).toContain(`COALESCE("signatureRef", '') LIKE 'solo-pin:%'`);
  });

  it('does not touch row-level security or the append-only trigger', () => {
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/DROP TRIGGER/i);
    expect(sql).not.toMatch(/DROP POLICY/i);
  });
});
