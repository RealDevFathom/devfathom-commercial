import { describe, expect, it } from 'vitest';

import {
  chunkReferenceRows,
  formulaSafeCell,
  ManualFileConnector,
  REFERENCE_BATCH_MAX_ROWS,
  REFERENCE_FILE_MAX_ROWS,
} from './reference-connectors';

describe('medicine reference normalization and provenance', () => {
  it('keeps missing regulated fields explicit instead of defaulting them', async () => {
    const result = await new ManualFileConnector().fetch({
      batchId: 'batch-01',
      fileName: 'catalog.csv',
      rows: [{ Name: 'Panadol', Source: 'legacy-7' }],
      mapping: { productName: 'Name', rowSourceKey: 'Source' },
      retrievedAt: '2030-01-02T03:04:05.000Z',
    });

    expect(result.rows[0]).toMatchObject({
      batchId: 'batch-01',
      rowSourceKey: 'legacy-7',
      values: { productName: 'Panadol' },
      blockingIssues: ['MISSING_STRENGTH', 'MISSING_DOSAGE_FORM', 'MISSING_PACK'],
    });
    expect(result.rows[0]?.values).not.toHaveProperty('strength');
    expect(result.rows[0]?.values).not.toHaveProperty('dosageForm');
    expect(result.rows[0]?.values).not.toHaveProperty('pack');
  });

  it('attaches immutable batch, row, source, retrieval, and rights evidence to every field', async () => {
    const result = await new ManualFileConnector().fetch({
      batchId: 'batch-02',
      fileName: 'reference.xlsx',
      rows: [{ Product: 'Amoxicillin', Strength: '500 mg', Form: 'Capsule', Pack: '2 x 10' }],
      mapping: { productName: 'Product', strength: 'Strength', dosageForm: 'Form', pack: 'Pack' },
      retrievedAt: '2030-02-03T04:05:06.000Z',
    });

    expect(result.rows[0]?.blockingIssues).toEqual([]);
    expect(result.rows[0]?.assertions).toHaveLength(4);
    expect(result.rows[0]?.assertions[0]).toMatchObject({
      source: 'reference.xlsx',
      sourceType: 'IMPORT',
      retrievedAt: '2030-02-03T04:05:06.000Z',
      batchId: 'batch-02',
      rowSourceKey: 'row-2',
      rights: {
        acquisition: 'Uploaded by an authorized workspace administrator',
        redistribution: 'Not permitted outside the tenant workspace',
      },
    });
  });

  it('neutralizes spreadsheet formulas in generated mapping exports', () => {
    expect(formulaSafeCell('=HYPERLINK("https://example.test")')).toBe(
      '\'=HYPERLINK("https://example.test")'
    );
    expect(formulaSafeCell('Panadol')).toBe('Panadol');
    expect(formulaSafeCell('\t=1+1')).toBe("' =1+1");
    expect(formulaSafeCell('QA\r=1+1')).toBe('QA =1+1');
  });

  it('carries an optional tenant medicine target and rejects invalid schedule flags', async () => {
    const result = await new ManualFileConnector().fetch({
      batchId: 'batch-03',
      fileName: 'updates.csv',
      rows: [
        {
          MedicineId: 'medicine-1',
          Product: 'Paracetamol',
          Strength: '500 mg',
          Form: 'Tablet',
          Pack: '10 tablets',
          Controlled: 'sometimes',
        },
      ],
      mapping: {
        targetMedicineId: 'MedicineId',
        productName: 'Product',
        strength: 'Strength',
        dosageForm: 'Form',
        pack: 'Pack',
        controlled: 'Controlled',
      },
    });

    expect(result.rows[0]).toMatchObject({
      targetMedicineId: 'medicine-1',
      blockingIssues: ['INVALID_SCHEDULE_CLASSIFICATION'],
    });
  });
});

describe('reference file chunking', () => {
  async function normalized(count: number) {
    const result = await new ManualFileConnector().fetch({
      batchId: 'file-batch',
      fileName: 'large.csv',
      rows: Array.from({ length: count }, (_, index) => ({
        Product: `Medicine ${index}`,
        Strength: '500 mg',
      })),
      mapping: { productName: 'Product', strength: 'Strength' },
      retrievedAt: '2030-01-02T03:04:05.000Z',
    });
    return result.rows;
  }

  it('splits a file into ceil(N / 500) parts whose rows and assertions carry the part batch ID', async () => {
    const rows = await normalized(1_201);
    const chunks = chunkReferenceRows('file-batch', rows);

    expect(REFERENCE_BATCH_MAX_ROWS).toBe(500);
    expect(chunks).toHaveLength(Math.ceil(1_201 / REFERENCE_BATCH_MAX_ROWS));
    expect(chunks.map((chunk) => chunk.batchId)).toEqual([
      'file-batch-p01',
      'file-batch-p02',
      'file-batch-p03',
    ]);
    expect(new Set(chunks.map((chunk) => chunk.batchId)).size).toBe(chunks.length);
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([500, 500, 201]);
    for (const chunk of chunks) {
      for (const row of chunk.rows) {
        expect(row.batchId).toBe(chunk.batchId);
        for (const assertion of row.assertions) expect(assertion.batchId).toBe(chunk.batchId);
      }
    }
    expect(chunks.flatMap((chunk) => chunk.rows.map((row) => row.rowSourceKey))).toEqual(
      rows.map((row) => row.rowSourceKey)
    );
    expect(chunks[2]?.rows.at(-1)?.rowSourceKey).toBe('row-1202');
    expect(rows[0]?.batchId).toBe('file-batch');
  });

  it('produces identical parts on retry so replays stay idempotent', async () => {
    const rows = await normalized(700);
    expect(chunkReferenceRows('file-batch', rows)).toEqual(chunkReferenceRows('file-batch', rows));
  });

  it('keeps the original batch ID for a file that fits in one request', async () => {
    const chunks = chunkReferenceRows('file-batch', await normalized(500));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.batchId).toBe('file-batch');
  });

  it('rejects a file above the 20,000-row cap before producing any part', async () => {
    const rows = await normalized(REFERENCE_FILE_MAX_ROWS + 1);
    expect(() => chunkReferenceRows('file-batch', rows)).toThrow(
      'A reference file is limited to 20,000 rows'
    );
  });
});
