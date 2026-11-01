// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildSeedRows,
  cleanText,
  familyForPosCategory,
  isControlledCandidate,
  parseCsv,
  parseSeedCsv,
  presentationLabel,
  SEED_COLUMNS,
  serializeSeedCsv,
} from './default-catalogue-seed';

const FIXTURE = join(process.cwd(), 'tests/fixtures/pharmacy-default-catalogue-50.csv');

function reference(overrides: Record<string, string>) {
  return {
    index: '0',
    productName: '',
    brandName: '',
    manufacturer: '',
    drapRegistrationNumber: '',
    strength: '',
    dosageForm: '',
    pack: '',
    barcode: '',
    alias: '',
    rx: '',
    restricted: '',
    controlled: '',
    rowSourceKey: '',
    targetMedicineId: '',
    ...overrides,
  };
}

function pos(overrides: Record<string, string>) {
  return {
    Name: '',
    aliasname: '',
    active: 'Y',
    saleprice: '1944.00',
    purprice: '1779.00',
    PackUnits: '1',
    QTY: '37.0000',
    name: 'MISC',
    classname: 'MISC',
    Category: 'MEDICINE.',
    UnitPrice: '1944.0000000000000',
    PackQty: '1.000000',
    StockValue: '71928.000000',
    ...overrides,
  };
}

describe('familyForPosCategory', () => {
  it.each([
    ['MEDICINE', 'PHARMACEUTICAL'],
    ['MEDICINE.', 'PHARMACEUTICAL'],
    [' medicine. ', 'PHARMACEUTICAL'],
    ['NARCOTICS', 'PHARMACEUTICAL'],
    ['COSMETIC', 'FRONT_SHOP'],
    ['CONSUMER', 'FRONT_SHOP'],
    ['MILK PRODUCTS', 'FRONT_SHOP'],
    ['PAMPERS', 'FRONT_SHOP'],
    ['CARDS', 'FRONT_SHOP'],
    ['DRINK', 'FRONT_SHOP'],
    ['SURGICAL ITEMS', 'DEVICE'],
    ['INSTUMERNT ITEM', 'DEVICE'],
    ['OPTICS', 'DEVICE'],
    ['SUGER STRIPS', 'DEVICE'],
  ] as const)('maps %j to %s', (category, family) => {
    expect(familyForPosCategory(category)).toBe(family);
  });

  it('falls back to the strictest family for anything it does not recognise', () => {
    expect(familyForPosCategory('SOMETHING NEW')).toBe('PHARMACEUTICAL');
    expect(familyForPosCategory('')).toBe('PHARMACEUTICAL');
    expect(familyForPosCategory(undefined)).toBe('PHARMACEUTICAL');
  });
});

describe('isControlledCandidate', () => {
  it('flags the POS NARCOTICS class and category, nothing else', () => {
    expect(isControlledCandidate({ classname: 'NARCOTICS', Category: 'MEDICINE.' })).toBe(true);
    expect(
      isControlledCandidate({ classname: 'FARAHAT ALI (HILTON)', Category: 'NARCOTICS' })
    ).toBe(true);
    expect(isControlledCandidate({ classname: 'MISC', Category: 'MEDICINE' })).toBe(false);
  });
});

describe('buildSeedRows', () => {
  it('falls back to brandName when productName is empty and cleans whitespace', () => {
    const [row] = buildSeedRows(
      [
        reference({
          brandName: '  PEDIAMAX  VIT A&D DROPS ',
          manufacturer: '(FARHAT ALI )MAPLE',
          strength: ' ',
          dosageForm: 'Drops',
          rowSourceKey: 'catalog-7',
        }),
      ],
      [pos({ aliasname: '7', Name: 'PEDIAMAX  VIT A&D DROPS' })]
    );
    expect(row).toEqual({
      sourceKey: 'catalog-7',
      productName: 'PEDIAMAX VIT A&D DROPS',
      brandName: 'PEDIAMAX VIT A&D DROPS',
      manufacturer: '(FARHAT ALI )MAPLE',
      strength: null,
      dosageForm: 'Drops',
      productFamily: 'PHARMACEUTICAL',
      controlledCandidate: false,
    });
  });

  it('keeps an explicit productName over the brand', () => {
    const [row] = buildSeedRows(
      [reference({ productName: 'Diclofenac', brandName: 'VOREN', rowSourceKey: 'catalog-1' })],
      []
    );
    expect(row!.productName).toBe('Diclofenac');
    expect(row!.brandName).toBe('VOREN');
  });

  it('flags NARCOTICS rows as controlled candidates without inventing any other flag', () => {
    const rows = buildSeedRows(
      [
        reference({ brandName: 'ALP 0.5MG TAB', rowSourceKey: 'catalog-916' }),
        reference({ brandName: 'LOMOTIL TAB', rowSourceKey: 'catalog-2038' }),
        reference({ brandName: 'PANADOL TAB', rowSourceKey: 'catalog-3' }),
      ],
      [
        pos({ aliasname: '916', classname: 'FARAHAT ALI (HILTON)', Category: 'NARCOTICS' }),
        pos({ aliasname: '2038', classname: 'NARCOTICS', Category: 'MEDICINE.' }),
        pos({ aliasname: '3', classname: 'MISC', Category: 'MEDICINE' }),
      ]
    );
    expect(rows.map((row) => [row.sourceKey, row.controlledCandidate])).toEqual([
      ['catalog-3', false],
      ['catalog-916', true],
      ['catalog-2038', true],
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...SEED_COLUMNS].sort());
    }
  });

  it('never carries prices, QTY or stock value into the seed', () => {
    const rows = buildSeedRows(
      [reference({ brandName: 'ANAPRO HAIR SPRAY', rowSourceKey: 'catalog-32459' })],
      [pos({ aliasname: '32459', Name: 'ANAPRO HAIR SPRAY', Category: 'COSMETIC' })]
    );
    const csv = serializeSeedCsv(rows);
    expect(csv.split('\n')[0]).toBe(SEED_COLUMNS.join(','));
    for (const leaked of ['1944', '1779', '37.0000', '71928', 'QTY', 'saleprice', 'StockValue']) {
      expect(csv).not.toContain(leaked);
    }
    expect(rows[0]!.productFamily).toBe('FRONT_SHOP');
  });

  it('joins an unkeyed row only to a uniquely named POS row that has no alias', () => {
    const rows = buildSeedRows(
      [
        reference({ brandName: 'FEEDAR IPSA 240ML 811', rowSourceKey: 'catalog-row-11419' }),
        reference({ brandName: 'TWIN', rowSourceKey: 'catalog-row-2' }),
      ],
      [
        pos({ aliasname: '', Name: 'FEEDAR IPSA 240ML 811', Category: 'SURGICAL ITEMS' }),
        pos({ aliasname: '', Name: 'TWIN', classname: 'NARCOTICS' }),
        pos({ aliasname: '', Name: 'TWIN', classname: 'NARCOTICS' }),
      ]
    );
    expect(rows.find((row) => row.sourceKey === 'catalog-row-11419')!.productFamily).toBe('DEVICE');
    // Ambiguous: the conservative defaults, not either twin's class.
    expect(rows.find((row) => row.sourceKey === 'catalog-row-2')).toMatchObject({
      productFamily: 'PHARMACEUTICAL',
      controlledCandidate: false,
    });
  });

  it('joins non-numeric aliases and sorts deterministically', () => {
    const input = [
      reference({ brandName: 'B', rowSourceKey: 'catalog-AJE007' }),
      reference({ brandName: 'C', rowSourceKey: 'catalog-10' }),
      reference({ brandName: 'A', rowSourceKey: 'catalog-2' }),
    ];
    const posRows = [pos({ aliasname: 'AJE007', Category: 'OPTICS' })];
    const first = serializeSeedCsv(buildSeedRows(input, posRows));
    const second = serializeSeedCsv(buildSeedRows([...input].reverse(), posRows));
    expect(first).toBe(second);
    const keys = parseSeedCsv(first).map((row) => [row.sourceKey, row.productFamily]);
    expect(keys).toEqual([
      ['catalog-2', 'PHARMACEUTICAL'],
      ['catalog-10', 'PHARMACEUTICAL'],
      ['catalog-AJE007', 'DEVICE'],
    ]);
  });

  it('refuses duplicate or missing source keys and nameless rows', () => {
    expect(() =>
      buildSeedRows(
        [
          reference({ brandName: 'A', rowSourceKey: 'catalog-1' }),
          reference({ brandName: 'B', rowSourceKey: 'catalog-1' }),
        ],
        []
      )
    ).toThrow(/Duplicate/);
    expect(() => buildSeedRows([reference({ brandName: 'A' })], [])).toThrow(/rowSourceKey/);
    expect(() => buildSeedRows([reference({ rowSourceKey: 'catalog-1' })], [])).toThrow(
      /neither productName nor brandName/
    );
  });
});

describe('seed CSV', () => {
  it('round-trips commas, quotes and empty values', () => {
    const rows = [
      {
        sourceKey: 'catalog-1',
        productName: 'GLUCOSE "D" 5%, 500ML',
        brandName: 'GLUCOSE "D" 5%, 500ML',
        manufacturer: null,
        strength: '5%',
        dosageForm: null,
        productFamily: 'PHARMACEUTICAL' as const,
        controlledCandidate: true,
      },
    ];
    expect(parseSeedCsv(serializeSeedCsv(rows))).toEqual(rows);
  });

  it('rejects a row the materialiser could not trust', () => {
    const header = SEED_COLUMNS.join(',');
    expect(() => parseSeedCsv(`${header}\ncatalog-1,X,,,,,VITAMIN,false\n`)).toThrow(
      /productFamily/
    );
    expect(() => parseSeedCsv(`${header}\ncatalog-1,X,,,,,DEVICE,yes\n`)).toThrow(
      /controlledCandidate/
    );
    expect(() => parseSeedCsv(`${header}\ncatalog-1,,,,,,DEVICE,false\n`)).toThrow(/productName/);
    expect(() =>
      parseSeedCsv(`${header}\ncatalog-1,X,,,,,DEVICE,false\ncatalog-1,Y,,,,,DEVICE,false\n`)
    ).toThrow(/repeats/);
  });

  it('parses a BOM-prefixed, CRLF source export', () => {
    expect(parseCsv('﻿"Name","QTY"\r\n"A, B","1"\r\n')).toEqual([{ Name: 'A, B', QTY: '1' }]);
  });

  it('reads the committed 50-row fixture', () => {
    const rows = parseSeedCsv(readFileSync(FIXTURE, 'utf8'));
    expect(rows).toHaveLength(50);
    expect(rows.filter((row) => row.controlledCandidate).length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.productFamily))).toEqual(
      new Set(['PHARMACEUTICAL', 'DEVICE', 'FRONT_SHOP'])
    );
  });
});

describe('helpers', () => {
  it('cleans text and labels presentations', () => {
    expect(cleanText('  a   b ')).toBe('a b');
    expect(cleanText('   ')).toBeNull();
    expect(presentationLabel({ strength: '30MG', dosageForm: 'Tablet' })).toBe('30MG Tablet');
    expect(presentationLabel({ strength: null, dosageForm: 'Syrup' })).toBe('Syrup');
    expect(presentationLabel({ strength: null, dosageForm: null })).toBeNull();
  });
});
