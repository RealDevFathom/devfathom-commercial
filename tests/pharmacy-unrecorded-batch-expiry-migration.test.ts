import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const name = '20261118121600_pharmacy_unrecorded_batch_expiry';
const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');

/** DEV-853 — legacy opening stock with no batch number and/or no expiry. */
describe('unrecorded batch and expiry storage', () => {
  it('is transactional, ordered and repeatable', () => {
    expect(sql.trim().startsWith('-- DEV-853')).toBe(true);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "pharmacy_inventory_lots_received_expiry_pair_check"'
    );
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "pharmacy_opening_stock_lines_complete_before_post_check"'
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION pharmacy_validate_restock_reservation()');
    const ledger = readFileSync('tests/fixtures/new-migration-order.txt', 'utf8')
      .trim()
      .split('\n');
    // Recorded once, in its place: every earlier entry is stamped before it and
    // every later entry after it (migration-timestamp-order.test.ts enforces both).
    expect(ledger.filter((entry) => entry === name)).toHaveLength(1);
    const position = ledger.indexOf(name);
    for (const earlier of ledger.slice(0, position))
      expect(earlier.slice(0, 14) < name.slice(0, 14)).toBe(true);
    for (const later of ledger.slice(position + 1))
      expect(later.slice(0, 14) > name.slice(0, 14)).toBe(true);
  });

  it('stores an unrecorded batch number and expiry as NULL, never a default', () => {
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_manufacturing_batches" ALTER COLUMN "batchNumber" DROP NOT NULL'
    );
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_manufacturing_batches" ALTER COLUMN "expiresAt" DROP NOT NULL'
    );
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_inventory_lots" ALTER COLUMN "receivedExpiresAt" DROP NOT NULL'
    );
    expect(sql).not.toMatch(/SET DEFAULT/i);
    expect(sql).not.toMatch(/UPDATE\s+"?pharmacy_(manufacturing_batches|inventory_lots)/i);
    expect(sql).toContain(
      'CHECK (("receivedExpiresAt" IS NULL) = ("receivedExpiryPrecision" IS NULL))'
    );
  });

  it('still requires everything else before an opening line posts', () => {
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT "pharmacy_opening_stock_lines_complete'));
    for (const column of [
      'sourceRef',
      'manufacturingBatchId',
      'printedMrpMinor',
      'unitCostMinor',
      'stockLocationId',
      'packLevelId',
      'unitsPerPack',
      'countedUnits',
      'postedLotId',
      'postedMovementId',
    ]) {
      expect(check).toContain(`"${column}" IS NOT NULL`);
    }
    expect(check).toContain('("expiryDate" IS NULL) = ("expiryPrecision" IS NULL)');
  });

  it('records a controlled sale of an unrecorded batch as NULL, never a label', () => {
    expect(sql).toContain(
      'ALTER TABLE "pharmacy_controlled_register_entries" ALTER COLUMN "batchNumber" DROP NOT NULL'
    );
    expect(sql).not.toContain("'Batch not recorded'");
  });

  it('lets a restock reservation hold unrecorded-expiry stock but never expired stock', () => {
    expect(sql).toContain(
      'AND (batch."expiresAt" IS NULL OR batch."expiresAt" > CURRENT_TIMESTAMP)'
    );
    expect(sql).toContain('batch."state" = \'ACTIVE\'');
    expect(sql).toContain('restock reservation exceeds safe available stock');
  });
});
