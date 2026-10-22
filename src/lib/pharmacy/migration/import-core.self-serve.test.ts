import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { excelCsvProfiler } from './excel-csv-profiler';
import {
  IMPORT_LIMITS,
  parseImportFile,
  productDedupeKey,
  transitionImportBatch,
} from './import-core';
import { profileTable } from './profiler';

const FIXTURES = join(process.cwd(), 'src/lib/pharmacy/migration/fixtures');

/**
 * Contract for the commit/audit sibling, which intentionally is not part of
 * import-core. This stub keeps this test branch independent of that feature.
 */
interface ImportCommitSibling {
  apply(input: {
    organizationId: string;
    branchId: string;
    batchId: string;
    dryRun: boolean;
  }): Promise<{ writes: number }>;
  audit(input: {
    organizationId: string;
    branchId: string;
    batchId: string;
    action: 'PHARMACY_IMPORT_COMMITTED';
  }): Promise<void>;
}

async function exerciseCommitBoundary(
  sibling: ImportCommitSibling,
  input: { organizationId: string; branchId: string; batchId: string; dryRun: boolean }
) {
  const result = await sibling.apply(input);
  if (!input.dryRun) {
    await sibling.audit({ ...input, action: 'PHARMACY_IMPORT_COMMITTED' });
  }
  return result;
}

describe('self-serve pharmacy import fixtures', () => {
  it('keeps malformed source evidence while blocking incomplete and invalid rows', async () => {
    const bytes = readFileSync(join(FIXTURES, 'self-serve-malformed-duplicates.csv'));
    const table = await parseImportFile('stock.csv', bytes);
    const result = profileTable(excelCsvProfiler, table);

    expect(table.rows).toHaveLength(5);
    expect(result.rows[3]?.rawPayload).toMatchObject({
      'Item Code': 'SKU-003',
      Product: 'Missing stock columns',
      'Pack Size': '',
      'Batch No': '',
    });
    expect(
      result.exceptions.filter(({ rowIndex }) => rowIndex === 3).map(({ bucket }) => bucket)
    ).toEqual(['MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP', 'UNIT_AMBIGUOUS']);
    expect(result.rows[4]?.productName).toBe('Comma, retained');
    expect(result.rows[4]?.rawPayload).not.toHaveProperty('IGNORED-TRAILING-CELL');
  });

  it('detects duplicate SKUs/products without merging distinct batches', async () => {
    const table = await parseImportFile(
      'stock.csv',
      readFileSync(join(FIXTURES, 'self-serve-malformed-duplicates.csv'))
    );
    const result = profileTable(excelCsvProfiler, table);

    expect(
      result.rows.slice(0, 2).map(({ sourceKey, batchNumber }) => [sourceKey, batchNumber])
    ).toEqual([
      ['SKU-001', 'B-100'],
      ['SKU-001', 'B-100'],
    ]);
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({ rowIndex: 1, bucket: 'DUPLICATE_PRODUCT' })
    );
    expect(productDedupeKey({ barcode: '8964000000012', name: 'anything' })).toBe(
      'barcode:8964000000012'
    );
    expect(productDedupeKey({ barcode: '8964000000029', name: 'Brufen 400mg' })).not.toBe(
      productDedupeKey({ barcode: '8964000000012', name: 'Panadol 500mg' })
    );
  });

  it('loads an XLSX fixture with Urdu text and exact batch/expiry values', async () => {
    const table = await parseImportFile(
      'abbasi-urdu.xlsx',
      readFileSync(join(FIXTURES, 'self-serve-urdu.xlsx'))
    );
    const result = profileTable(excelCsvProfiler, table);

    expect(table.rows).toEqual([
      ['UR-1', 'پیراسیٹامول 500 ملی گرام', '10x10', 'URDU-بیچ-۱', '02/2028', '125.50', '4'],
      ['UR-2', 'کھانسی کا شربت', '100 ml', 'LOT-اردو-۲', '2028-12', '210', '2'],
    ]);
    expect(result.rows.map(({ batchNumber }) => batchNumber)).toEqual(['URDU-بیچ-۱', 'LOT-اردو-۲']);
    expect(result.rows.map(({ expiryDate }) => expiryDate?.toISOString())).toEqual([
      '2028-02-29T00:00:00.000Z',
      '2028-12-31T00:00:00.000Z',
    ]);
    expect(result.exceptions).toEqual([]);
  });
});

describe('self-serve import boundaries', () => {
  it('enforces row, column, and byte limits at their boundaries', async () => {
    const atColumnLimit = Array.from(
      { length: IMPORT_LIMITS.maxColumns },
      (_, i) => `c${i}`
    ).join(',');
    await expect(
      parseImportFile('columns.csv', new TextEncoder().encode(atColumnLimit))
    ).resolves.toMatchObject({ headers: expect.arrayContaining(['c0', 'c199']) });

    const tooManyRows = `Name\n${'Panadol\n'.repeat(IMPORT_LIMITS.maxRows + 1)}`;
    await expect(
      parseImportFile('rows.csv', new TextEncoder().encode(tooManyRows))
    ).rejects.toMatchObject({ code: 'MAX_ROWS' });
    await expect(
      parseImportFile('bytes.csv', new Uint8Array(IMPORT_LIMITS.maxBytes + 1))
    ).rejects.toMatchObject({ code: 'MAX_BYTES' });
  });

  it('always scopes lifecycle writes by organization, branch, batch, and expected status', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await transitionImportBatch(
      { pharmacyMigrationBatch: { updateMany } },
      { organizationId: 'org_abbasi', branchId: 'branch_clifton', batchId: 'batch_1' },
      'PREVIEW',
      'COMMITTING'
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'batch_1',
        organizationId: 'org_abbasi',
        branchId: 'branch_clifton',
        status: 'PREVIEW',
      },
      data: { status: 'COMMITTING' },
    });
  });

  it('fails closed when a tenant-scoped lifecycle write matches no row', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(
      transitionImportBatch(
        { pharmacyMigrationBatch: { updateMany } },
        { organizationId: 'org_foreign', branchId: 'branch_clifton', batchId: 'batch_1' },
        'PREVIEW',
        'COMMITTING'
      )
    ).rejects.toThrow(/outside branch scope/);
  });

  it('keeps dry-runs write-free and emits a tenant-scoped audit entry only on commit', async () => {
    const sibling: ImportCommitSibling = {
      apply: vi.fn(async ({ dryRun }) => ({ writes: dryRun ? 0 : 2 })),
      audit: vi.fn(async () => undefined),
    };
    const scope = { organizationId: 'org_abbasi', branchId: 'branch_clifton', batchId: 'batch_1' };

    await expect(exerciseCommitBoundary(sibling, { ...scope, dryRun: true })).resolves.toEqual({
      writes: 0,
    });
    expect(sibling.audit).not.toHaveBeenCalled();

    await expect(exerciseCommitBoundary(sibling, { ...scope, dryRun: false })).resolves.toEqual({
      writes: 2,
    });
    expect(sibling.audit).toHaveBeenCalledOnce();
    expect(sibling.audit).toHaveBeenCalledWith({
      ...scope,
      dryRun: false,
      action: 'PHARMACY_IMPORT_COMMITTED',
    });
  });
});
