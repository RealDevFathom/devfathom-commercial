import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260831210000_restaurant_delivery_fee_finance_visibility/migration.sql'
  ),
  'utf8'
);

describe('restaurant delivery fee finance visibility migration', () => {
  it('adds separate nonnegative close and insight facts without changing RLS policies', () => {
    for (const table of ['restaurant_daily_closes', 'restaurant_insight_daily_rollups']) {
      expect(sql).toContain(`ALTER TABLE "${table}"`);
    }
    expect(
      sql.match(/ADD COLUMN "deliveryFeeSales" DECIMAL\(12,2\) NOT NULL DEFAULT 0/g)
    ).toHaveLength(2);
    expect(
      sql.match(/ADD COLUMN "deliveryFeeRefunds" DECIMAL\(12,2\) NOT NULL DEFAULT 0/g)
    ).toHaveLength(2);
    expect(sql).toContain('CHECK ("deliveryFeeSales" >= 0 AND "deliveryFeeRefunds" >= 0)');
    expect(sql).not.toContain('POLICY');
  });
});
