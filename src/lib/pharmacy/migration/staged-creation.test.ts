import { describe, expect, it } from 'vitest';

import {
  cutText,
  failureDetail,
  isPassingFailure,
  isRowRefusal,
  normalizeMatchText,
  notCreatedReason,
  planStagedMedicine,
  STAGED_CREATION_BUSY,
  STAGED_CREATION_STOPPED,
  stagedLevelPrices,
  stagedMatchKey,
  stagedReorderUnits,
  type StagedRowForCreation,
} from './staged-creation';

const row = (over: Partial<StagedRowForCreation> = {}): StagedRowForCreation => ({
  id: 'row_1',
  sourceKey: 'sha256:abc:row:1',
  rowNumber: 1,
  productName: 'Fixture Tablet',
  packLabel: null,
  packFactor: null,
  mrpMinor: null,
  costMinor: null,
  rawPayload: {},
  ...over,
});

describe('DEV-912 planStagedMedicine', () => {
  it('keeps the MRP and purchase price exactly as read', () => {
    const plan = planStagedMedicine(
      row({
        packLabel: '100',
        packFactor: BigInt(100),
        mrpMinor: BigInt(50_000),
        costMinor: BigInt(42_000),
      })
    );
    expect(plan).toMatchObject({
      productName: 'Fixture Tablet',
      unitsPerPack: 100,
      mrpMinor: 50_000,
      purchasePriceMinor: 42_000,
      packLevels: [{ level: 'BOX', unitsPerParent: 100 }],
    });
  });

  it('creates a medicine from a name only and records the rest as not recorded', () => {
    expect(planStagedMedicine(row({ productName: '  Fixture   Syrup ' }))).toEqual({
      productName: 'Fixture Syrup',
      presentation: 'Pack size not recorded',
      packLevels: [],
      unitsPerPack: null,
      mrpMinor: null,
      purchasePriceMinor: null,
      genericName: null,
      legacyCode: null,
      barcode: null,
      packLabel: null,
      narcoticsClass: false,
      supplierName: null,
      reorderLevelPacks: null,
    });
  });

  it('creates nothing for a row with no medicine name', () => {
    expect(planStagedMedicine(row({ productName: '   ' }))).toBeNull();
    expect(planStagedMedicine(row({ productName: null }))).toBeNull();
  });

  it('builds a box of strips from "10 x 10" or a strips-per-box column', () => {
    const grid = planStagedMedicine(row({ packLabel: '10 x 10', packFactor: BigInt(100) }));
    expect(grid?.packLevels).toEqual([
      { level: 'BOX', unitsPerParent: 10 },
      { level: 'STRIP', unitsPerParent: 10 },
    ]);
    const column = planStagedMedicine(
      row({ packLabel: '30', packFactor: BigInt(30), rawPayload: { 'Strips per box': '3' } })
    );
    expect(column?.packLevels).toEqual([
      { level: 'BOX', unitsPerParent: 3 },
      { level: 'STRIP', unitsPerParent: 10 },
    ]);
    // A split that does not divide the units per pack is not invented.
    const uneven = planStagedMedicine(
      row({ packLabel: '30', packFactor: BigInt(30), rawPayload: { 'Strips per box': '4' } })
    );
    expect(uneven?.packLevels).toEqual([{ level: 'BOX', unitsPerParent: 30 }]);
  });

  it('names a strip, a box and a single tablet', () => {
    const strip = planStagedMedicine(
      row({ packLabel: '10', packFactor: BigInt(10), rawPayload: { 'Pack Type': 'Strip' } })
    );
    expect(strip?.packLevels).toEqual([{ level: 'STRIP', unitsPerParent: 10 }]);
    const single = planStagedMedicine(row({ packLabel: '1', packFactor: BigInt(1) }));
    expect(single?.packLevels).toEqual([{ level: 'UNIT', unitsPerParent: 1 }]);
    expect(single?.presentation).toBe('1');
  });

  it('reads the generic name, the old code and the NARCOTICS class from the source cells', () => {
    const plan = planStagedMedicine(
      row({
        rawPayload: {
          'Generic Name': ' Fixture  salt ',
          aliasname: 'OLD-7',
          classname: 'narcotics',
        },
      })
    );
    expect(plan).toMatchObject({
      genericName: 'Fixture salt',
      legacyCode: 'OLD-7',
      narcoticsClass: true,
    });
  });

  it('never reads a strength as a count, and treats a volume as one container', () => {
    const strength = planStagedMedicine(row({ packLabel: '500mg', packFactor: BigInt(500) }));
    expect([strength?.unitsPerPack, strength?.packLevels]).toEqual([null, []]);
    const bottle = planStagedMedicine(row({ packLabel: '100ML', packFactor: BigInt(100) }));
    expect(bottle?.packLevels).toEqual([{ level: 'UNIT', unitsPerParent: 1 }]);
    for (const packLabel of ['10 strips', '2 boxes', '10 strip'])
      expect(
        planStagedMedicine(row({ packLabel, packFactor: BigInt(10) }))?.unitsPerPack,
        packLabel
      ).toBeNull();
    const tablets = planStagedMedicine(row({ packLabel: '20 Tabs', packFactor: BigInt(20) }));
    expect(tablets?.packLevels).toEqual([{ level: 'BOX', unitsPerParent: 20 }]);
  });

  it('stores a price of 0 as not recorded, never as 0', () => {
    const plan = planStagedMedicine(row({ mrpMinor: BigInt(0), costMinor: BigInt(0) }));
    expect([plan?.mrpMinor, plan?.purchasePriceMinor]).toEqual([null, null]);
    expect(
      stagedLevelPrices({ ...plan!, packLevels: [{ level: 'UNIT', unitsPerParent: 1 }] })
    ).toBeNull();
  });

  it('keeps the barcode printed on the pack, and nothing for a blank one', () => {
    expect(planStagedMedicine(row({ barcode: ' 0896000000017 ' }))?.barcode).toBe('0896000000017');
    expect(planStagedMedicine(row({ barcode: '  ' }))?.barcode).toBeNull();
    expect(planStagedMedicine(row())?.barcode).toBeNull();
  });

  it('treats a negative or oversized amount as not recorded', () => {
    const plan = planStagedMedicine(
      row({ mrpMinor: BigInt(-5), costMinor: BigInt(2) ** BigInt(40), packFactor: BigInt(0) })
    );
    expect([plan?.mrpMinor, plan?.purchasePriceMinor, plan?.unitsPerPack]).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('DEV-912 stagedLevelPrices', () => {
  it('prices a box, a strip and a single tablet from the pack MRP', () => {
    expect(
      stagedLevelPrices({
        mrpMinor: 100_000,
        packLevels: [
          { level: 'BOX', unitsPerParent: 10 },
          { level: 'STRIP', unitsPerParent: 10 },
        ],
      })
    ).toEqual({
      levels: [
        { level: 'BOX', priceMinor: 100_000 },
        { level: 'STRIP', priceMinor: 10_000 },
      ],
      unitPriceMinor: 1_000,
    });
    expect(
      stagedLevelPrices({ mrpMinor: 12_000, packLevels: [{ level: 'STRIP', unitsPerParent: 10 }] })
    ).toEqual({ levels: [{ level: 'STRIP', priceMinor: 12_000 }], unitPriceMinor: 1_200 });
    expect(
      stagedLevelPrices({ mrpMinor: 1_500, packLevels: [{ level: 'UNIT', unitsPerParent: 1 }] })
    ).toEqual({ levels: [{ level: 'UNIT', priceMinor: 1_500 }], unitPriceMinor: 1_500 });
  });

  it('never charges above the MRP when a unit price is not a whole amount', () => {
    expect(
      stagedLevelPrices({ mrpMinor: 1_000, packLevels: [{ level: 'BOX', unitsPerParent: 3 }] })
        ?.unitPriceMinor
    ).toBe(333);
  });

  it('has no price when the MRP or units per pack is not recorded', () => {
    expect(
      stagedLevelPrices({ mrpMinor: null, packLevels: [{ level: 'BOX', unitsPerParent: 3 }] })
    ).toBeNull();
    expect(stagedLevelPrices({ mrpMinor: 500, packLevels: [] })).toBeNull();
  });
});

describe('DEV-912 stagedMatchKey', () => {
  const plan = (over: Partial<StagedRowForCreation>) => planStagedMedicine(row(over))!;

  it('keeps two strengths of one name apart when the strength sits in the pack cell', () => {
    const strong = stagedMatchKey(plan({ productName: 'Fixture Tab', packLabel: '500MG' }));
    const weak = stagedMatchKey(plan({ productName: 'Fixture Tab', packLabel: '250MG' }));
    expect(strong).not.toBeNull();
    expect(weak).not.toBeNull();
    expect(strong).not.toBe(weak);
  });

  it('never matches by name alone', () => {
    expect(stagedMatchKey(plan({ productName: 'Fixture Syrup' }))).toBeNull();
  });

  it('matches a re-spaced or re-cased re-export, with the same pack', () => {
    expect(stagedMatchKey(plan({ productName: ' fixture   TAB ', packLabel: '500  mg' }))).toBe(
      stagedMatchKey(plan({ productName: 'Fixture Tab', packLabel: '500 MG' }))
    );
    expect(
      stagedMatchKey(plan({ productName: 'Fixture Tab', packLabel: '10', packFactor: BigInt(10) }))
    ).not.toBe(
      stagedMatchKey(plan({ productName: 'Fixture Tab', packLabel: '20', packFactor: BigInt(20) }))
    );
  });

  it('uses the old code when the row has one, whatever the name', () => {
    expect(
      stagedMatchKey(plan({ productName: 'Renamed', rawPayload: { aliasname: ' ab-1 ' } }))
    ).toBe(stagedMatchKey(plan({ productName: 'Original', rawPayload: { aliasname: 'AB-1' } })));
  });

  it('has one normalisation rule, applied before the key is stored', () => {
    expect(normalizeMatchText('  Ｆｉｘｔｕｒｅ\t TAB\u00a0 500mg ')).toBe('fixture tab 500mg');
  });
});

describe('DEV-912 supplier and reorder level', () => {
  it('reads the template supplier and reorder level, and the legacy headers', () => {
    expect(
      planStagedMedicine(
        row({
          packFactor: BigInt(10),
          rawPayload: { Supplier: ' Example  Distributors ', 'Reorder level': '20' },
        })
      )
    ).toMatchObject({ supplierName: 'Example Distributors', reorderLevelPacks: 20 });
    expect(
      planStagedMedicine(row({ rawPayload: { distributor: 'Other Co', REORDERPOINT: '5.0' } }))
    ).toMatchObject({ supplierName: 'Other Co', reorderLevelPacks: 5 });
  });

  it('stores a blank, zero, fractional or unreadable reorder level as not recorded', () => {
    for (const cell of ['', '0', '2.5', 'ten', '-3'])
      expect(
        planStagedMedicine(row({ rawPayload: { 'Reorder level': cell, Supplier: '' } }))
      ).toMatchObject({ reorderLevelPacks: null, supplierName: null });
  });

  it('counts a reorder level in units from the units per pack, or not at all', () => {
    expect(stagedReorderUnits({ reorderLevelPacks: 20, unitsPerPack: 10 })).toBe(200);
    expect(stagedReorderUnits({ reorderLevelPacks: 20, unitsPerPack: null })).toBeNull();
    expect(stagedReorderUnits({ reorderLevelPacks: null, unitsPerPack: 10 })).toBeNull();
    expect(stagedReorderUnits({ reorderLevelPacks: 2_000_000_000, unitsPerPack: 10 })).toBeNull();
  });
});

describe('DEV-1002 a row never stops the rest of its file', () => {
  const refusal = (sqlState: string, message = 'refused') =>
    Object.assign(new Error('Database error'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2039',
      meta: {
        modelName: 'MedicineAlias',
        driverAdapterError: { cause: { originalCode: sqlState, originalMessage: message } },
      },
    });

  it('cuts long text on whole characters, never inside an emoji', () => {
    expect(cutText('ab\u{1F600}', 3)).toBe('ab');
    expect(cutText('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
    expect(cutText('abc', 300)).toBe('abc');
    const plan = planStagedMedicine(
      row({
        productName: 'L'.repeat(299) + '\u{1F600}tail',
        barcode: '7'.repeat(63) + '\u{1F600}',
        rawPayload: { aliasname: 'C'.repeat(199) + '\u{1F600}', 'Generic Name': 'G' },
      })
    )!;
    expect(plan.productName).toBe('L'.repeat(299));
    expect(plan.barcode).toBe('7'.repeat(63));
    expect(plan.legacyCode).toBe('C'.repeat(199));
    for (const text of [plan.productName, plan.barcode!, plan.legacyCode!])
      expect(text.isWellFormed()).toBe(true);
  });

  it('records an old code, generic name, barcode or supplier with no letter or digit as not recorded', () => {
    const plan = planStagedMedicine(
      row({
        barcode: '--',
        rawPayload: { aliasname: '-', 'Generic Name': '.', Supplier: '*' },
      })
    )!;
    expect([plan.legacyCode, plan.genericName, plan.barcode, plan.supplierName]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    // So a later file never matches every "-" row to one medicine by old code.
    expect(stagedMatchKey({ ...plan, unitsPerPack: 10 })).toBe('name:fixture tablet|10|');
  });

  it('isolates only a refusal of the data, never a busy or lost connection', () => {
    for (const state of ['23514', '23505', '22P02', '22001', '54000', 'P0001'])
      expect(isRowRefusal(refusal(state))).toBe(true);
    for (const state of ['40001', '40P01', '57014', '08006', '42501'])
      expect(isRowRefusal(refusal(state))).toBe(false);
    expect(isRowRefusal(new Error('Transaction already closed'))).toBe(false);
    expect(isPassingFailure(Object.assign(new Error('timeout'), { code: 'P2028' }))).toBe(true);
    expect(isPassingFailure(refusal('40P01'))).toBe(true);
    expect(isPassingFailure(refusal('23514'))).toBe(false);
    expect(isPassingFailure(new Error('unknown'))).toBe(false);
  });

  it('gives the person a plain reason and the next step', () => {
    expect(notCreatedReason(refusal('23514'))).toBe(
      'A value in this row is not accepted by the catalogue. Correct the row in the file and upload the file again: medicines already created are matched, never made twice.'
    );
    expect(notCreatedReason(refusal('22P02'))).toMatch(
      /^A cell in this row has characters the catalogue cannot store\. Correct the row/
    );
    expect(notCreatedReason(refusal('54000'))).toMatch(/^A cell in this row is too long/);
    expect(notCreatedReason(refusal('22003'))).toMatch(/^A number in this row is too large/);
    expect(notCreatedReason(refusal('23505'))).toMatch(/^A code or barcode in this row/);
    for (const state of ['23514', '22P02', '54000', '22003', '23505'])
      expect(notCreatedReason(refusal(state)).length).toBeLessThanOrEqual(500);
  });

  it('keeps codes for the log and the audit record, never a cell value', () => {
    expect(
      failureDetail(
        refusal(
          '23514',
          'new row for relation "pharmacy_medicine_aliases" violates check constraint "pharmacy_medicine_aliases_normalizedValue_check"'
        )
      )
    ).toEqual({
      prismaCode: 'P2039',
      sqlState: '23514',
      model: 'MedicineAlias',
      constraint: 'pharmacy_medicine_aliases_normalizedValue_check',
      errorName: 'PrismaClientKnownRequestError',
    });
    const quoted = failureDetail(
      refusal('22P02', 'invalid input syntax for type integer: "Panadol"')
    );
    expect(JSON.stringify(quoted)).not.toContain('Panadol');
    expect(STAGED_CREATION_STOPPED).not.toMatch(/Nothing was changed/);
    expect(STAGED_CREATION_BUSY).not.toMatch(/Nothing was changed/);
  });
});
