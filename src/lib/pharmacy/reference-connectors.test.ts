import { describe, expect, it } from 'vitest';

import { formulaSafeCell, ManualFileConnector } from './reference-connectors';

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
