import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../../../prisma/migrations/20261023500000_pharmacy_catalog_preload/migration.sql', import.meta.url), 'utf8');

describe('catalogue preload safety contract', () => {
  it('uses the shared medicine aggregate, batches, deterministic ids, and one resumable run', () => {
    expect(source).toContain("['medicine', medicines]");
    expect(source).toContain("['medicineAlias', aliases]");
    expect(source).toContain('skipDuplicates: true');
    expect(source).toContain("completed?.status === 'COMPLETED'");
    expect(source).toContain("status: 'COMPLETED'");
  });
  it('stores aliases as legacy codes and never creates a barcode', () => {
    expect(source).toContain("type: 'LEGACY_CODE'");
    expect(source).not.toContain("delegate(db, 'medicineBarcode')");
  });
  it('leaves actual prices null until opt-in and never writes an MRP', () => {
    expect(source).toContain('sellingPriceMinor: null, purchasePriceMinor: null');
    expect(source).toContain('pack.sellingPriceMinor == null');
    expect(source).toContain('pack.purchasePriceMinor == null');
    expect(source).not.toContain("delegate(db, 'medicinePackMrp')");
  });
  it('does not address any stock, lot, batch, movement, opening, or supplier delegate', () => {
    for (const forbidden of ['stockBalance', 'stockMovement', 'inventoryLot', 'manufacturingBatch', 'opening', 'supplier']) expect(source).not.toContain(`delegate(db, '${forbidden}`);
  });
  it('enforces RLS on seed checkpoints and settings', () => {
    expect(migration.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration).toContain("current_setting('app.current_organization_id', true)");
    expect(migration).not.toContain("app.is_platform_admin', true) = 'true' OR");
  });
});
