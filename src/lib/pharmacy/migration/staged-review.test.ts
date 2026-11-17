import { describe, expect, it } from 'vitest';
import {
  exceptionWorkflow,
  spreadsheetCell,
  stagedReference,
  stagedReferencesCsv,
  type ReviewRow,
} from './staged-review';
import { missingAttributes } from './opening-stock';

const hash = 'a'.repeat(64);
export function fixture(): ReviewRow {
  return {
    id: 'row_1',
    sourceKey: `sha256:${hash}:row:1`,
    rowNumber: 1,
    productName: '  Example   Medicine  ',
    packLabel: null,
    quantityCanonical: null,
    rawPayload: {
      Name: '  Example   Medicine  ',
      QTY: '9007199254740993.0000',
      PackQty: '1.000000',
      PackUnits: '1',
      saleprice: '01.2300',
      name: 'legacy group',
      __source_sha256: hash,
      __source_row: '1',
      __review_flags: 'NORMALIZED_NAME_COLLISION_NO_MERGE',
      privateUnrelatedField: 'never exposed',
    },
    exceptions: [{ bucket: 'MISSING_BATCH', severity: 'BLOCKING', status: 'OPEN' }],
  };
}
const source = { id: 'source_1', contentHash: hash };
describe('staged medicine evidence', () => {
  it('retains original decimal strings, case-distinct fields and source lineage without mutating', () => {
    const row = fixture();
    const before = JSON.stringify(row);
    const view = stagedReference(row, source, 'batch_1');
    expect(view.references.QTY).toBe('9007199254740993.0000');
    expect(view.references.PackQty).toBe('1.000000');
    expect(view.references.saleprice).toBe('01.2300');
    expect(view.references.name).toBe('legacy group');
    expect(view.references.Name).toBe('  Example   Medicine  ');
    expect(view.lineage).toBe('Source lineage matches');
    expect(view.sourceKey).toBe(row.sourceKey);
    expect(view.contentHash).toBe(hash);
    expect(view.normalizedNamePreview).toBe('Example Medicine');
    expect(view.naturalKeyPreview).toBe('med.product:example medicine');
    expect(view.collision).toBe(true);
    expect(JSON.stringify(view)).not.toContain('privateUnrelatedField');
    expect(JSON.stringify(row)).toBe(before);
  });
  it('does not invent original text from JSON numbers or missing cells', () => {
    const view = stagedReference({ ...fixture(), rawPayload: { QTY: 1 } }, source, 'batch_1');
    expect(view.references.QTY).toBeNull();
    expect(view.references.PackQty).toBeNull();
    expect(view.lineage).toBe('Unrecorded source checksum');
  });
  it.each(['__source_sha256', '__source_row'])('flags a changed %s', (key) => {
    const row = fixture();
    row.rawPayload = { ...(row.rawPayload as object), [key]: 'wrong' };
    expect(stagedReference(row, source, 'batch_1').lineage).toBe('Source lineage mismatch');
  });
  it('flags mismatched source key and preserves both colliding candidates', () => {
    const first = stagedReference(fixture(), source, 'batch_1');
    const second = stagedReference(
      { ...fixture(), id: 'row_2', sourceKey: 'wrong' },
      source,
      'batch_1'
    );
    expect(second.lineage).toBe('Source lineage mismatch');
    expect([first, second]).toHaveLength(2);
    expect(first.id).not.toBe(second.id);
  });
  it.each([
    ['MISSING_BATCH', 'Opening stock'],
    ['MISSING_EXPIRY', 'Opening stock'],
    ['MISSING_MRP', 'Verified price'],
    ['DUPLICATE_PRODUCT', 'Identity review'],
    ['UNIT_AMBIGUOUS', 'Pack / unit review'],
  ] as const)('classifies %s without downgrading stored severity', (bucket, workflow) => {
    expect(exceptionWorkflow(bucket)).toBe(workflow);
  });
  it('never makes source counts sellable and leaves existing opening guard fail closed', () => {
    const view = stagedReference(fixture(), source, 'batch_1');
    expect(view.verified).toBe(false);
    expect(view.sellable).toBe(false);
    expect(view.canonicalQuantity).toBeNull();
    expect(view.exceptions[0].severity).toBe('BLOCKING');
    expect(
      missingAttributes({
        sourceRef: 'ref',
        manufacturingBatchId: null,
        batchNumber: null,
        expiryDate: null,
        expiryPrecision: null,
        printedMrpMinor: null,
        unitCostMinor: null,
        stockLocationId: null,
        packLevelId: null,
        unitsPerPack: null,
        countedUnits: null,
      })
    ).toEqual(
      expect.arrayContaining([
        'MISSING_BATCH',
        'MISSING_EXPIRY',
        'MISSING_MRP',
        'MISSING_COST',
        'MISSING_COUNT',
      ])
    );
  });
  it.each(['=1+1', '+SUM(A1)', '-1', '@formula', ' \t=CMD()', '\n=1', '\ttext'])(
    'escapes spreadsheet interpretation: %j',
    (value) => {
      expect(spreadsheetCell(value)).toBe(`"'${value}"`);
    }
  );
  it('quotes embedded CSV syntax and preserves original payload during export', () => {
    expect(spreadsheetCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    const row = fixture();
    const csv = stagedReferencesCsv([stagedReference(row, source, 'batch_1')]);
    expect(csv).toContain('"9007199254740993.0000"');
    expect(csv).toContain(hash);
    expect(csv).not.toContain('never exposed');
  });
  it('shows 29 packs of 30 as 870 units when the mapping says packs', () => {
    const row: ReviewRow = {
      ...fixture(),
      packFactor: BigInt(30),
      quantityCanonical: BigInt(870),
      rawPayload: { QTY: '29' },
    };
    const view = stagedReference(row, source, 'batch_1', 'PACKS');
    expect(view.quantityReview).toMatchObject({ unit: 'PACKS', packs: '29', units: '870' });
    expect(view.quantityReview.label).toBe('29 packs × 30 = 870 units');
  });
  it('shows base units without inventing packs', () => {
    const view = stagedReference(
      {
        ...fixture(),
        quantityCanonical: BigInt(29),
        rawPayload: { QTY: '29' },
      },
      source,
      'batch_1',
      'UNITS'
    );
    expect(view.quantityReview).toMatchObject({ unit: 'UNITS', packs: null, units: '29' });
  });
});

it.each([undefined, 'PACKS', 'unknown'])(
  'preserves legacy raw counts without claiming a recorded choice (%s)',
  (unit) => {
    const row: ReviewRow = {
      ...fixture(),
      packFactor: BigInt(30),
      quantityCanonical: BigInt(29),
      // A source column named __quantity_unit must never count as a recorded choice.
      rawPayload: { QTY: '29', __quantity_unit: unit ?? 'PACKS' },
    };
    const before = structuredClone(row);
    const view = stagedReference(row, source, 'batch_legacy');
    expect(view.quantityReview.unit).toBeNull();
    expect(view.quantityReview.choiceLabel).toBe('not recorded (staged as raw count)');
    expect(view.quantityReview.label).toBe('29 (staged as raw count)');
    expect(view.canonicalQuantity).toBe('29');
    expect(row).toEqual(before);
  }
);

describe('unresolved supplied quantities', () => {
  const unresolved = (unit: string | null) =>
    stagedReference(
      {
        ...fixture(),
        packFactor: null,
        quantityCanonical: null,
        rawPayload: { QTY: '29' },
      },
      source,
      'batch_1',
      unit
    ).quantityReview.label;
  it('labels a pack count without a factor as unresolved, not missing', () => {
    expect(unresolved('PACKS')).toBe('Unresolved: "29" packs (no countable pack factor)');
    expect(unresolved(null)).toBe('Unresolved: "29" (choose packs or units)');
  });
  it('reserves a null label for an empty quantity cell', () => {
    const view = stagedReference(
      { ...fixture(), quantityCanonical: null, rawPayload: { QTY: '' } },
      source,
      'batch_1',
      'PACKS'
    );
    expect(view.quantityReview.label).toBeNull();
  });
});
