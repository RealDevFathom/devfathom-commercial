import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260905060000_pharmacy_customer_ordering/migration.sql',
  'utf8'
);
const anonymousAccess = readFileSync('src/lib/auth/anonymous-access.ts', 'utf8');

const ORDER_TABLES = [
  'pharmacy_customer_orders',
  'pharmacy_customer_order_lines',
  'pharmacy_customer_order_events',
] as const;

describe('MKT-03/MKT-05 database contract', () => {
  it('uses the DEM-03 reservation chain instead of a second reservation table', () => {
    expect(migration).toContain(
      'ALTER TABLE "pharmacy_restock_interests" ADD COLUMN "orderLineId"'
    );
    expect(migration).toContain('"pharmacy_restock_reservations"');
    expect(migration).not.toContain('pharmacy_customer_order_reservations');
  });

  it.each(ORDER_TABLES)('enables and forces RLS for %s', (table) => {
    expect(migration).toContain(`ALTER TABLE %I ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain(`ALTER TABLE %I FORCE ROW LEVEL SECURITY`);
    expect(migration).toContain(table);
  });

  it('keeps fulfillment transitions audited and terminal rows immutable', () => {
    expect(migration).toContain('pharmacy_customer_order_event_append_only');
    expect(migration).toContain('illegal customer order transition');
    expect(migration).toContain("'READY_FOR_COLLECTION'");
    expect(migration).toContain("'OUT_FOR_DELIVERY'");
  });

  it('does not extend anonymous procedure access', () => {
    expect(anonymousAccess).not.toContain('pharmacyOrdering');
    expect(anonymousAccess).not.toContain('pharmacy_customer_orders');
  });
});
