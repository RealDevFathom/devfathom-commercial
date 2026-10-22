import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { excelCsvProfiler } from './excel-csv-profiler';
import {
  IMPORT_LIMITS,
  ImportValidationError,
  parseImportFile,
} from './import-core';
import {
  commitImportBatch,
  rollbackImportBatch,
  type EntityImportRepository,
} from './entity-import-service';
import type { EntityImportWriter, ImportCommitContext } from './entity-committers';
import { profileTable } from './profiler';

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function parseFixture(name: string) {
  return parseImportFile(name, new Uint8Array(await readFile(fixture(name))));
}

const context: ImportCommitContext = {
  batchId: 'batch-org-a',
  actorId: 'owner-org-a',
  branchId: 'branch-org-a',
  stockLocationId: 'stock-org-a',
  awardImportedLoyalty: false,
};

/** Sibling persistence adapters are deliberately stubbed until their import pieces land. */
function importStubs(rows: Awaited<ReturnType<EntityImportRepository['rows']>> = []) {
  const repository: EntityImportRepository = {
    batch: vi.fn(async (batchId) =>
      batchId === context.batchId ? { status: 'PREVIEW' } : null
    ),
    rows: vi.fn(async (batchId) => (batchId === context.batchId ? rows : [])),
    openBlockingCount: vi.fn(async () => 0),
    manifest: vi.fn(async () => []),
    setStatus: vi.fn(async () => undefined),
  };
  const writer: EntityImportWriter = {
    product: vi.fn(async () => []),
    customer: vi.fn(async () => []),
    supplier: vi.fn(async () => []),
    historicalSale: vi.fn(async () => []),
    manifest: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    reverseOpeningMovement: vi.fn(async () => 'reversal-stub'),
  };
  return { repository, writer };
}

describe('self-serve pharmacy importer v3 fixtures', () => {
  it('turns malformed stock cells into blocking row exceptions without inventing values', async () => {
    const table = await parseFixture('self-serve-malformed-rows.csv');
    const result = profileTable(excelCsvProfiler, table);

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      sourceKey: 'BAD-001',
      batchNumber: null,
      expiryDate: null,
      mrpMinor: null,
      quantityCanonical: null,
    });
    expect(
      result.exceptions.map(({ rowIndex, bucket, severity }) => ({
        rowIndex,
        bucket,
        severity,
      }))
    ).toEqual(
      expect.arrayContaining([
        { rowIndex: 0, bucket: 'MISSING_BATCH', severity: 'BLOCKING' },
        { rowIndex: 0, bucket: 'MISSING_EXPIRY', severity: 'BLOCKING' },
        { rowIndex: 0, bucket: 'MISSING_MRP', severity: 'BLOCKING' },
        { rowIndex: 0, bucket: 'UNIT_AMBIGUOUS', severity: 'BLOCKING' },
        { rowIndex: 1, bucket: 'MISSING_EXPIRY', severity: 'BLOCKING' },
        { rowIndex: 2, bucket: 'MISSING_EXPIRY', severity: 'BLOCKING' },
      ])
    );
  });

  it('retains Urdu text and reports duplicate SKU/batch rows deterministically', async () => {
    const result = profileTable(
      excelCsvProfiler,
      await parseFixture('self-serve-duplicates-urdu.csv')
    );

    expect(result.rows.map((row) => [row.sourceKey, row.productName, row.batchNumber])).toEqual([
      ['SKU-UR-01', 'پیراسیٹامول گولیاں', 'بیچ-الف'],
      ['SKU-UR-01', 'پیراسیٹامول گولیاں', 'بیچ-الف'],
      ['SKU-UR-01', 'پیراسیٹامول گولیاں', 'بیچ-ب'],
    ]);
    expect(result.exceptions.filter((error) => error.bucket === 'DUPLICATE_PRODUCT')).toEqual([
      expect.objectContaining({ rowIndex: 1, severity: 'BLOCKING' }),
      expect.objectContaining({ rowIndex: 2, severity: 'BLOCKING' }),
    ]);
  });

  it('parses XLSX batch strings and supported expiry shapes exactly', async () => {
    const result = profileTable(
      excelCsvProfiler,
      await parseFixture('self-serve-expiry-batches.xlsx')
    );

    expect(
      result.rows.map((row) => ({
        batch: row.batchNumber,
        expiry: row.expiryDate?.toISOString(),
      }))
    ).toEqual([
      { batch: 'LOT-2027-A', expiry: '2027-03-31T00:00:00.000Z' },
      { batch: 'LOT-2028-B', expiry: '2028-02-29T00:00:00.000Z' },
      { batch: 'LOT-2026-C', expiry: '2026-12-31T00:00:00.000Z' },
    ]);
  });

  it('rejects files over the configured byte, row, and column limits', async () => {
    await expect(
      parseImportFile('too-large.csv', new Uint8Array(IMPORT_LIMITS.maxBytes + 1))
    ).rejects.toMatchObject({ code: 'MAX_BYTES' } satisfies Partial<ImportValidationError>);

    const columns = Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',');
    await expect(
      parseImportFile('too-wide.csv', new TextEncoder().encode(columns))
    ).rejects.toMatchObject({ code: 'MAX_COLUMNS' } satisfies Partial<ImportValidationError>);

    const rows = `Product Name\n${'Panadol\n'.repeat(IMPORT_LIMITS.maxRows + 1)}`;
    await expect(
      parseImportFile('too-tall.csv', new TextEncoder().encode(rows))
    ).rejects.toMatchObject({ code: 'MAX_ROWS' } satisfies Partial<ImportValidationError>);
  });
});

describe('self-serve preview/commit boundary', () => {
  it('keeps dry-run profiling pure and performs no sibling persistence writes', async () => {
    const stubs = importStubs();
    const preview = profileTable(
      excelCsvProfiler,
      await parseFixture('self-serve-expiry-batches.xlsx')
    );

    expect(preview.rows).toHaveLength(3);
    expect(stubs.repository.setStatus).not.toHaveBeenCalled();
    expect(stubs.writer.product).not.toHaveBeenCalled();
    expect(stubs.writer.audit).not.toHaveBeenCalled();
  });

  it('commits only the requested tenant-scoped batch and writes one audit entry', async () => {
    const stubs = importStubs([]);
    await commitImportBatch(stubs.repository, stubs.writer, context);

    expect(stubs.repository.batch).toHaveBeenCalledWith('batch-org-a');
    expect(stubs.repository.rows).toHaveBeenCalledWith('batch-org-a');
    expect(stubs.repository.setStatus).toHaveBeenNthCalledWith(1, 'batch-org-a', 'COMMITTING');
    expect(stubs.repository.setStatus).toHaveBeenNthCalledWith(2, 'batch-org-a', 'COMMITTED');
    expect(stubs.writer.audit).toHaveBeenCalledOnce();
    expect(stubs.writer.audit).toHaveBeenCalledWith(
      'pharmacy.import.commit',
      context,
      { created: 0 }
    );
  });

  it('rejects a foreign batch before rows, status, or audit side effects', async () => {
    const stubs = importStubs();

    await expect(
      commitImportBatch(stubs.repository, stubs.writer, {
        ...context,
        batchId: 'batch-org-b',
      })
    ).rejects.toThrow('Only a previewed batch can be committed');
    expect(stubs.repository.rows).not.toHaveBeenCalled();
    expect(stubs.repository.setStatus).not.toHaveBeenCalled();
    expect(stubs.writer.audit).not.toHaveBeenCalled();
  });

  it('audits rollback separately from commit and uses only the manifest stub', async () => {
    const stubs = importStubs();
    vi.mocked(stubs.repository.batch).mockResolvedValueOnce({ status: 'COMMITTED' });
    vi.mocked(stubs.repository.manifest).mockResolvedValueOnce([]);

    await rollbackImportBatch(stubs.repository, stubs.writer, context);

    expect(stubs.repository.manifest).toHaveBeenCalledWith('batch-org-a');
    expect(stubs.repository.setStatus).toHaveBeenCalledWith('batch-org-a', 'ROLLED_BACK');
    expect(stubs.writer.audit).toHaveBeenCalledOnce();
    expect(stubs.writer.audit).toHaveBeenCalledWith(
      'pharmacy.import.rollback',
      context,
      { entities: 0 }
    );
  });
});
