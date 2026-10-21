import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260831180000_restaurant_delivery_money_contract/migration.sql'
  ),
  'utf8'
);

describe('restaurant delivery money migration', () => {
  it('adds separate nonnegative delivery fee and refund columns', () => {
    expect(sql).toContain('ADD COLUMN "deliveryFeeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN "deliveryFeeRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0');
    expect(sql).toContain('CHECK ("deliveryFeeTotal" >= 0)');
    expect(sql).toContain('CHECK ("deliveryFeeRefundAmount" >= 0)');
  });

  it('updates the grand-total invariant without folding fee into service charge', () => {
    expect(sql).toContain(
      '"grandTotal" = "subtotal" + "taxTotal" + "serviceChargeTotal" + "deliveryFeeTotal" - "compTotal" - "discountTotal" + "roundingAdjustment"'
    );
  });

  it('replaces the function used by the existing immutable-snapshot trigger', () => {
    expect(sql).toContain('WHERE "status" = \'PENDING\' AND "paymentMode" IS NOT NULL');
    expect(sql).toContain('DISABLE TRIGGER "restaurant_delivery_fulfillment_snapshot_immutable"');
    expect(sql).toContain('ENABLE TRIGGER "restaurant_delivery_fulfillment_snapshot_immutable"');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION prevent_restaurant_delivery_snapshot_mutation()'
    );
    expect(sql).toContain(
      'OLD."paymentMode" IS NULL AND NEW."paymentMode" IS NOT NULL AND NEW."status" <> \'DISPATCHED\''
    );
    expect(sql).toContain(
      "RAISE EXCEPTION 'delivery fulfillment snapshots are immutable' USING ERRCODE = '55000'"
    );
    expect(sql).toContain(
      "CHECK ((\"status\" IN ('PENDING', 'CANCELLED', 'FAILED')) OR \"paymentMode\" IS NOT NULL)"
    );
  });

  it('replaces the refund component constraint with all three frozen components', () => {
    expect(sql).toContain('DROP CONSTRAINT "restaurant_refunds_frozen_refund_amounts_check"');
    expect(sql).toContain(
      '"serviceChargeRefundAmount" + "deliveryFeeRefundAmount" + "taxRefundAmount" <= "amount"'
    );
  });
});
