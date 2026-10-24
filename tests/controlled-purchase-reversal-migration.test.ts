import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261024190000_controlled_purchase_reversal/migration.sql',
  'utf8'
);
const caller = readFileSync('src/lib/pharmacy/goods-receipt.ts', 'utf8');

describe('additive controlled purchase reversal migration', () => {
  it('keeps the strongest existence and exact branch/medicine/lot/batch identity checks', () => {
    expect(sql).toContain('IF NOT FOUND OR lot_batch IS DISTINCT FROM NEW."batchNumber"');
    expect(sql).toContain('lot_medicine IS DISTINCT FROM NEW."medicineId"');
    expect(sql).toContain('lot_branch IS DISTINCT FROM NEW."branchId"');
    expect(sql.indexOf('SELECT b."batchNumber", b."medicineId", l."branchId"')).toBeLessThan(
      sql.indexOf(`IF NEW."entryKind" = 'CORRECTION'`)
    );
    expect(sql).toContain(`IF NOT FOUND OR movement."kind"<>'RECEIPT'`);
    expect(sql).toContain(`IF NOT FOUND OR movement."kind"<>'SALE'`);
    for (const field of ['branchId', 'inventoryLotId', 'medicineId', 'batchNumber']) {
      expect(sql).toContain(`original."${field}" IS DISTINCT FROM NEW."${field}"`);
    }
  });

  it('permits only positive, exact, correctly directed stock-backed quantities with cumulative caps', () => {
    expect(sql).toContain(`original."entryKind" NOT IN ('SALE','PURCHASE')`);
    expect(sql).toContain(
      'abs(movement."quantityUnits"::bigint) IS DISTINCT FROM NEW."quantityCanonicalUnits"'
    );
    expect(sql).toContain('OR NEW."quantityCanonicalUnits" <= 0');
    expect(sql).toContain(`original."entryKind"='SALE' AND movement."quantityUnits">0`);
    expect(sql).toContain(`original."entryKind"='PURCHASE' AND movement."quantityUnits"<0`);
    expect(sql).toContain('movement."reversesMovementId"=original."stockMovementId"');
    expect(sql).toContain(
      'restored + NEW."quantityCanonicalUnits" > original."quantityCanonicalUnits"'
    );
    expect(sql).toContain(
      `original."entryKind"='SALE' AND movement."kind"='RETURN' AND movement."quantityUnits">0 AND EXISTS`
    );
    expect(sql).toContain('a."stockMovementId"=original."stockMovementId"');
  });

  it('retains manual caps, both balance checks, quarantine zero, serial/incident locks and immutability', () => {
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('controlled register serial must be consecutive');
    expect(sql).toContain('controlled dispensing blocked by open register incident');
    expect(sql).toContain('abs(derived_delta)>original."quantityCanonicalUnits"');
    expect(sql).toContain('NEW."balanceDelta"::bigint IS DISTINCT FROM derived_delta');
    expect(sql).toContain(
      `CASE WHEN movement."disposition"='QUARANTINE' THEN 0 ELSE movement."quantityUnits" END`
    );
    expect(sql).toContain('previous_balance + NEW."balanceDelta"');
    expect(sql).toContain('NEW."runningBalance" IS DISTINCT FROM actual');
    expect(sql).toContain('INSERT INTO "pharmacy_register_incidents"');
    expect(sql).not.toMatch(
      /DROP |ALTER TABLE|DISABLE|DELETE FROM|UPDATE "pharmacy_controlled_register_entries"/i
    );
  });

  it('appends the correction inside the same caller transaction before REVERSED', () => {
    const reverse = caller.slice(
      caller.indexOf('export async function reverseGoodsReceipt('),
      caller.indexOf('export async function resolveReceivingException(')
    );
    expect(reverse.indexOf('await reverseMovements(db')).toBeLessThan(
      reverse.indexOf('await appendControlledPurchaseReversals(db')
    );
    expect(reverse.indexOf('await appendControlledPurchaseReversals(db')).toBeLessThan(
      reverse.indexOf("status: 'REVERSED'")
    );
    expect(reverse).toContain('sourceMovementId: movement.reversesMovementId!');
    expect(reverse).not.toMatch(/withTenantDb|withPlatformDb|\$transaction/);
  });
});
