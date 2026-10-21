import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20260904197000_pharmacy_restock_interest/migration.sql',
  'utf8'
);
const ledger = readFileSync('src/lib/pharmacy/stock-ledger.ts', 'utf8');

describe('DEM-03 database backstops', () => {
  it('subtracts active restock reservations from saleable stock', () => {
    expect(ledger).toContain('FROM "pharmacy_restock_reservations" reservation');
    expect(ledger).toContain('reservation."status" = \'RESERVED\'');
  });

  it('rejects unsafe or overdrawn reservations and non-consented notifications', () => {
    expect(migration).toContain('restock reservation exceeds safe available stock');
    expect(migration).toContain('restock reservation payload or settled state is immutable');
    expect(migration).toContain('balance."disposition" = \'AVAILABLE\'');
    expect(migration).toContain('batch."expiresAt" > CURRENT_TIMESTAMP');
    expect(migration).toContain('current reminders consent required');
    expect(migration).toContain('newer."version" > consent."version"');
    expect(migration).not.toContain(
      '\'RECOVERED\' AND "saleId" IS NOT NULL AND "recoveredSaleLineId"'
    );
  });

  it.each([
    'pharmacy_restock_interests',
    'pharmacy_restock_reservations',
    'pharmacy_restock_notifications',
  ])('enables tenant and branch RLS for %s', (table) => {
    expect(migration).toContain(
      `ARRAY['pharmacy_restock_interests','pharmacy_restock_reservations','pharmacy_restock_notifications']`
    );
    expect(migration).toContain('app.current_organization_id');
    expect(migration).toContain('app.current_branch_id');
    expect(table).toMatch(/^pharmacy_restock_/);
  });
});
