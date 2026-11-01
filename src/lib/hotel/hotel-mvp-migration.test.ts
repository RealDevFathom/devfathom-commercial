import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * SQL-contract checks for the Hotel MVP migration. The behaviour is proven by
 * the database; these pin the invariants the review depends on so a later
 * edit cannot quietly drop them.
 */
const root = process.cwd();
const sql = readFileSync(
  join(root, 'prisma/migrations/20261101000000_hotel_mvp_reservations_folio/migration.sql'),
  'utf8'
);
const fixes = readFileSync(
  join(root, 'prisma/migrations/20261101000100_hotel_mvp_review_fixes/migration.sql'),
  'utf8'
);
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');

const TABLES = [
  'hotel_guests',
  'hotel_confirmation_sequences',
  'hotel_rate_plans',
  'hotel_rate_plan_prices',
  'hotel_reservations',
  'hotel_reservation_stay_units',
  'hotel_folios',
  'hotel_folio_entries',
  'hotel_folio_payments',
  'hotel_operation_idempotency_keys',
  'hotel_housekeeping_tasks',
];

describe('hotel MVP migration', () => {
  it.each(TABLES)('creates %s (no IF NOT EXISTS) and maps it in the Prisma schema', (table) => {
    expect(sql).toContain(`CREATE TABLE "${table}" (`);
    expect(schema).toContain(`@@map("${table}")`);
  });

  it('forces the standard organization RLS policy on every new table and nothing property-keyed', () => {
    for (const table of TABLES) expect(sql).toContain(`'${table}'`);
    expect(sql).toContain("EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t)");
    expect(sql).toContain('_tenant_isolation');
    expect(sql).not.toContain('app.current_hotel_property_id');
    expect(sql).not.toContain('IF NOT EXISTS');
  });

  it('has one folio ledger with bigint money and one sign convention', () => {
    expect(sql).not.toContain('hotel_folio_postings');
    expect(sql).toMatch(/"grossMinor" BIGINT NOT NULL/);
    expect(sql).toContain('"grossMinor" = "netMinor" + "taxMinor"');
    expect(sql).toContain('"hotel_folio_entries_reversal_key"');
    expect(sql).toContain('hotel_folio_reversal_guard');
    expect(sql).not.toMatch(/-original\."totalMinor"/);
  });

  it('makes recorded money append-only, admitting only the sanctioned purge', () => {
    for (const table of ['hotel_reservation_stay_units', 'hotel_folio_entries', 'hotel_folio_payments']) {
      expect(sql).toContain(`BEFORE UPDATE OR DELETE ON "${table}"`);
    }
    expect(sql).toContain("current_setting('app.purging_organization_id', true)");
    expect(sql).toContain("current_setting('app.is_platform_admin', true) = 'true'");
  });

  it('keys every child to its parent with a tenant- and property-qualified foreign key', () => {
    for (const constraint of [
      'hotel_reservations_primary_guest_fkey',
      'hotel_reservation_stay_units_reservation_fkey',
      'hotel_reservation_stay_units_rate_plan_fkey',
      'hotel_folios_reservation_fkey',
      'hotel_folio_entries_folio_fkey',
      'hotel_folio_entries_catalog_item_fkey',
      'hotel_folio_entries_reverses_fkey',
      'hotel_folio_payments_folio_fkey',
      'hotel_folio_payments_refunds_fkey',
      'hotel_rate_plan_prices_rate_plan_fkey',
      'hotel_housekeeping_tasks_room_fkey',
    ]) {
      expect(sql).toContain(`"${constraint}"`);
      expect(schema).toContain(`map: "${constraint}"`);
    }
    expect(sql).toContain('"hotel_reservations_confirmation_key"');
    expect(sql).toContain('"hotel_folios_number_key"');
  });

  it('stores the idempotency request hash and result, and fixes rate plan terms', () => {
    expect(sql).toMatch(/"requestHash" TEXT NOT NULL/);
    expect(sql).toMatch(/"response" JSONB/);
    expect(sql).toContain('hotel_rate_plan_terms_immutable');
    expect(sql).toContain('NEW."taxBasisPoints" IS DISTINCT FROM OLD."taxBasisPoints"');
    expect(sql).toContain('hotel_rate_price_immutable');
  });

  it('keeps one room status: the parallel housekeeping table is dropped, not mapped', () => {
    expect(fixes).toContain('DROP TABLE "hotel_room_housekeeping";');
    expect(fixes).toContain('DROP TYPE "HotelHousekeepingStatus";');
    expect(schema).not.toContain('@@map("hotel_room_housekeeping")');
    expect(schema).not.toContain('enum HotelHousekeepingStatus');
  });

  it('caps rate plan tax at 100% and pins a plan to its property currency', () => {
    expect(fixes).toContain('CHECK ("taxBasisPoints" BETWEEN 0 AND 10000)');
    expect(fixes).toContain('BEFORE INSERT ON "hotel_rate_plans"');
    expect(fixes).toContain('p."currency" = NEW."currency"');
  });

  it('guards folio entries (open folio, folio currency) and refunds (same folio, capped, locked)', () => {
    expect(fixes).toContain('BEFORE INSERT ON "hotel_folio_entries"');
    expect(fixes).toContain(`folio."status" <> 'OPEN'`);
    expect(fixes).toContain('folio."currency" <> NEW."currency"');
    expect(fixes).toContain('BEFORE INSERT ON "hotel_folio_payments"');
    expect(fixes).toContain('refunded + NEW."amountMinor" > original."amountMinor"');
    expect(fixes).toMatch(/"refundsPaymentId"\s*FOR UPDATE;/);
    expect(schema).toContain('map: "hotel_folio_payments_refunds_idx"');
    expect(fixes).not.toContain('IF NOT EXISTS');
  });
});
