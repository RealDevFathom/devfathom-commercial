import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'prisma/migrations/20261029000164_pharmacy_purchase_bill_tax_identity/migration.sql',
  'utf8'
);

describe('#763 pharmacy purchase bill tax identity migration', () => {
  it('adds nullable bill-level NTN and STRN snapshots', () => {
    expect(migration).toContain('ALTER TABLE "pharmacy_goods_receipts"');
    expect(migration).toContain('ADD COLUMN "distributorNtn" TEXT');
    expect(migration).toContain('ADD COLUMN "distributorStrn" TEXT');
    expect(migration).not.toMatch(/"distributor(?:Ntn|Strn)" TEXT NOT NULL/);
  });
});
