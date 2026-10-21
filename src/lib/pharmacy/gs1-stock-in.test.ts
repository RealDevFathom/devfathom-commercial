import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { resolveScan } from './purchasing-console';

const scope = { organizationId: 'org_a' };
const GS = '\u001d';
const GTIN = '08961234567894';

function database(options: { barcode?: unknown; medicine?: unknown } = {}) {
  return {
    medicineBarcode: { findFirst: vi.fn().mockResolvedValue(options.barcode ?? null) },
    medicine: { findFirst: vi.fn().mockResolvedValue(options.medicine ?? null) },
  } as unknown as ScopedDb;
}

const linked = {
  packLevelId: 'pack_a',
  presentation: { medicineId: 'med_a', medicine: { productName: 'Amoxil 500' } },
};

describe('resolveScan stock-in', () => {
  it('fills product, batch, expiry and serial from a DataMatrix', async () => {
    const db = database({ barcode: linked });
    const scan = await resolveScan(db, scope, `]d201${GTIN}1727123110ABCD1234${GS}21A3F09C1E77B2`);
    expect(scan).toMatchObject({
      kind: 'gs1',
      medicineId: 'med_a',
      packLevelId: 'pack_a',
      label: 'Amoxil 500',
      gtin: GTIN,
      batch: 'ABCD1234',
      expiryDate: '2027-12-31',
      serial: 'A3F09C1E77B2',
      warnings: [],
    });
    expect(db.medicineBarcode.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_a',
          normalizedCode: { in: [GTIN, GTIN.slice(1)] },
        }),
      })
    );
  });

  it('keeps the parsed fields when the GTIN is not linked yet', async () => {
    const scan = await resolveScan(database(), scope, `(01)${GTIN}(17)271200(10)ABCD1234`);
    expect(scan).toMatchObject({
      kind: 'gs1',
      medicineId: null,
      label: GTIN,
      expiryDate: '2027-12-31',
      rawExpiry: '271200',
    });
    if (scan.kind !== 'gs1') throw new Error('expected a gs1 scan');
    expect(scan.warnings.map((warning) => warning.code)).toEqual(['EXPIRY_END_OF_MONTH']);
  });

  it('asks for manual entry when the element string is not readable', async () => {
    const scan = await resolveScan(database(), scope, `(01)${GTIN.slice(0, 13)}5`);
    expect(scan).toMatchObject({
      kind: 'manual',
      reason: 'GTIN check digit does not match.',
    });
  });

  it('falls back to a linear barcode plus a later manual batch and expiry', async () => {
    const db = database({ barcode: linked });
    const scan = await resolveScan(db, scope, '8901234567890');
    expect(scan).toEqual({
      kind: 'barcode',
      medicineId: 'med_a',
      packLevelId: 'pack_a',
      label: 'Amoxil 500',
    });
  });

  it('still resolves a typed product name', async () => {
    const db = database({ medicine: { id: 'med_a', productName: 'Amoxil 500' } });
    await expect(resolveScan(db, scope, 'Amoxil')).resolves.toEqual({
      kind: 'medicine',
      medicineId: 'med_a',
      packLevelId: null,
      label: 'Amoxil 500',
    });
  });
});
