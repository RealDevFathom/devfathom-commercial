import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261116130000_pharmacy_loyalty_console/migration.sql',
  'utf8'
);
const code = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('pharmacy loyalty console migration (DEV-764)', () => {
  it('runs as one idempotent transaction', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    for (const kind of ['ADJUSTMENT', 'EXPIRY', 'REDEMPTION_RELEASE'])
      expect(code).toContain(`ADD VALUE IF NOT EXISTS '${kind}'`);
    for (const column of [
      'redemptionValueMinor',
      'expiryDays',
      'khataEarns',
      'reason',
      'expiresAt',
      'reversesEntryId',
    ])
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS "${column}"`);
    expect(code).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_points_entries_expiry_lot_key"/
    );
    expect(code).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_points_entries_release_tender_key"/
    );
  });

  it("keeps today's behaviour for every existing program version", () => {
    expect(code).toContain('"redemptionValueMinor" INTEGER NOT NULL DEFAULT 100');
    expect(code).toMatch(/"expiryDays" INTEGER,/);
    expect(code).toContain('"khataEarns" BOOLEAN NOT NULL DEFAULT true');
  });

  it("caps a rate at paying back what was spent, at the version's own redemption value", () => {
    expect(code).toContain(
      '"earnPoints"::bigint * "redemptionValueMinor"::bigint <= "perSpendMinor"::bigint'
    );
    expect(code).toContain('"redemptionValueMinor" BETWEEN 1 AND 100000');
    expect(code).toContain('"expiryDays" IS NULL OR "expiryDays" BETWEEN 1 AND 3650');
  });

  it('preserves every existing balance and ledger row: additive only', () => {
    expect(code).not.toMatch(/\bUPDATE\s+"?pharmacy_loyalty/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/DISABLE TRIGGER/i);
    expect(code).not.toMatch(/DROP TRIGGER/i);
    expect(code).not.toMatch(/DROP POLICY|DISABLE ROW LEVEL SECURITY/i);
  });

  it('keeps every earlier entry shape, now also requiring its sale', () => {
    for (const kind of ['EARN', 'REDEEM', 'REFUND', 'EARN_REVERSAL', 'KHATA_EARN'])
      expect(code).toMatch(new RegExp(`\\("kind"::text = '${kind}' AND "saleId" IS NOT NULL`));
  });

  it('constrains the new shapes: reasoned adjustments, lot-closing expiries, tender releases', () => {
    expect(code).toMatch(
      /'ADJUSTMENT' AND "saleId" IS NULL AND "points" <> 0[^\n]*length\(btrim\("reason"\)\) BETWEEN 3 AND 500/
    );
    expect(code).toMatch(
      /'EXPIRY' AND "saleId" IS NULL AND "points" <= 0[^\n]*"reversesEntryId" IS NOT NULL/
    );
    expect(code).toMatch(
      /'REDEMPTION_RELEASE' AND "saleId" IS NOT NULL AND "points" > 0[^\n]*"tenderId" IS NOT NULL AND "refundId" IS NULL/
    );
  });
});
