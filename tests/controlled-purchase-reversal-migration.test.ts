import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'prisma/migrations/20261022090000_controlled_purchase_reversals/migration.sql',
  'utf8'
);

describe('controlled purchase reversal migration', () => {
  it('accepts only a linked, oppositely signed movement for a purchase correction', () => {
    expect(sql).toContain(`original."entryKind" NOT IN ('SALE', 'PURCHASE')`);
    expect(sql).toContain(`movement."reversesMovementId"=original."stockMovementId"`);
    expect(sql).toContain(
      `sign(movement."quantityUnits") = CASE WHEN original."entryKind"='SALE' THEN 1 ELSE -1 END`
    );
    expect(sql).toContain(
      `NEW."balanceDelta" IS DISTINCT FROM (CASE WHEN movement."disposition"='QUARANTINE' THEN 0 ELSE movement."quantityUnits" END)`
    );
  });
});
