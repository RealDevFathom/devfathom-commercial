// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  buildSeedRows,
  cleanText,
  compareSourceKeys,
  familyForPosCategory,
  isControlledCandidate,
  parseCsv,
  parseSeedCsv,
  presentationLabel,
  SEED_COLUMNS,
  serializeSeedCsv,
} from './default-catalogue-seed';

const FIXTURE = join(process.cwd(), 'tests/fixtures/pharmacy-default-catalogue-50.csv');
const SEED_V1 = join(process.cwd(), 'prisma/seed-data/pharmacy-default-catalogue/v1.csv.gz');

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

/*
 * POS aliases are barcode-like strings. Compared as numbers these collide;
 * compared exactly (as they must be) they are distinct products. These are the
 * real colliding groups from the source export.
 */
const LEADING_ZERO_GROUPS: ReadonlyArray<ReadonlyArray<[alias: string, name: string]>> = [
  [
    ['0', 'LITEPLUS TAB'],
    ['00', 'DISPRIN 300MG TAB'],
    ['000', 'DISPRIN 300MG TAB (100S)'],
    ['0000', 'LABELLO LIP BALM ROSE SOFT'],
    ['000000', 'HIN NEU D'],
  ],
  [
    ['11', 'BECEFOL TAB (25S)'],
    ['000011', 'A/F SULTAN AL RAHEEB 300ML'],
  ],
  [
    ['33324', 'ALOE VERA GEL 160ML'],
    ['033324', 'ALOE VERA SOOTHING GEL 99%'],
  ],
  [
    ['745604648165', 'BUTTERFLY BREATHABLE 28 PCS'],
    ['0745604648165', 'BUTTERFLY MAXI THICK XL 28PC'],
  ],
  [
    ['7137571699364', 'KINGTOX BLACK COIL'],
    ['07137571699364', 'KINGTOX GREEN COIL'],
  ],
];

describe('source keys with leading zeros', () => {
  const pairs = LEADING_ZERO_GROUPS.flat();
  const categories = ['MEDICINE', 'COSMETIC', 'SURGICAL ITEMS', 'CONSUMER', 'NARCOTICS'];

  it('keeps every key exact and joins each to its own POS row, never a numeric twin', () => {
    const rows = buildSeedRows(
      // Shuffled, so the join cannot lean on input order.
      [...pairs].reverse().map(([alias, name]) =>
        reference({ brandName: name, rowSourceKey: `catalog-${alias}` })
      ),
      pairs.map(([alias, name], index) =>
        pos({ aliasname: alias, Name: name, Category: categories[index % categories.length]! })
      )
    );
    expect(rows).toHaveLength(pairs.length);
    expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(pairs.length);
    pairs.forEach(([alias, name], index) => {
      const row = rows.find((candidate) => candidate.sourceKey === `catalog-${alias}`);
      expect(row, alias).toMatchObject({
        brandName: name,
        productFamily: familyForPosCategory(categories[index % categories.length]),
        controlledCandidate: categories[index % categories.length] === 'NARCOTICS',
      });
    });
    expect(rows.find((row) => row.sourceKey === 'catalog-0')!.brandName).toBe('LITEPLUS TAB');
    expect(rows.find((row) => row.sourceKey === 'catalog-00')!.brandName).toBe(
      'DISPRIN 300MG TAB'
    );

    // And the keys survive the seed file byte for byte.
    const parsed = parseSeedCsv(serializeSeedCsv(rows));
    expect(parsed.map((row) => row.sourceKey)).toEqual(rows.map((row) => row.sourceKey));
  });

  it('never joins a key to a POS alias that only equals it numerically', () => {
    const [row] = buildSeedRows(
      [reference({ brandName: 'LITEPLUS TAB', rowSourceKey: 'catalog-0' })],
      [
        pos({ aliasname: '00', Name: 'DISPRIN 300MG TAB', classname: 'NARCOTICS' }),
        pos({ aliasname: '000', Name: 'DISPRIN 300MG TAB (100S)', Category: 'COSMETIC' }),
      ]
    );
    // No exact `0` alias: conservative defaults, nothing borrowed from `00`/`000`.
    expect(row).toMatchObject({
      sourceKey: 'catalog-0',
      productFamily: 'PHARMACEUTICAL',
      controlledCandidate: false,
    });
  });

  it('orders numerically without merging keys of equal value', () => {
    const keys = [
      'catalog-00',
      'catalog-AJE007',
      'catalog-000011',
      'catalog-0',
      'catalog-2',
      'catalog-11',
    ];
    expect([...keys].sort(compareSourceKeys)).toEqual([
      'catalog-0',
      'catalog-00',
      'catalog-2',
      'catalog-000011',
      'catalog-11',
      'catalog-AJE007',
    ]);
    for (const group of LEADING_ZERO_GROUPS) {
      for (const [left] of group) {
        for (const [right] of group) {
          const order = compareSourceKeys(`catalog-${left}`, `catalog-${right}`);
          expect(order === 0, `${left} vs ${right}`).toBe(left === right);
        }
      }
    }
  });

  it('refuses padded keys and repeated POS aliases instead of normalising them', () => {
    expect(() =>
      buildSeedRows([reference({ brandName: 'A', rowSourceKey: ' catalog-00 ' })], [])
    ).toThrow(/rowSourceKey/);
    expect(() =>
      buildSeedRows(
        [reference({ brandName: 'A', rowSourceKey: 'catalog-00' })],
        [pos({ aliasname: '00' }), pos({ aliasname: '00' })]
      )
    ).toThrow(/repeats/);
    const header = SEED_COLUMNS.join(',');
    expect(() => parseSeedCsv(`${header}\n" catalog-0",X,,,,,DEVICE,false\n`)).toThrow(
      /sourceKey/
    );
    const twins = `${header}\ncatalog-0,X,,,,,DEVICE,false\ncatalog-00,Y,,,,,DEVICE,false\n`;
    expect(parseSeedCsv(twins).map((row) => row.sourceKey)).toEqual(['catalog-0', 'catalog-00']);
  });

  it('is what the committed v1 seed holds: 18,933 exact, unique keys', () => {
    const raw = gunzipSync(readFileSync(SEED_V1));
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '5bd01d7489068e8ae678d6625c77f0c250326e957fcb6ba52d091afe64310e3d'
    );
    const rows = parseSeedCsv(raw.toString('utf8'));
    expect(rows).toHaveLength(18_933);
    const byKey = new Map(rows.map((row) => [row.sourceKey, row]));
    expect(byKey.size).toBe(18_933);
    expect(byKey.get('catalog-0')).toMatchObject({
      brandName: 'LITEPLUS TAB',
      manufacturer: 'WILSHIRE LABORATORIES(PVT)LTD',
    });
    expect(byKey.get('catalog-00')).toMatchObject({
      brandName: 'DISPRIN 300MG TAB',
      manufacturer: 'RECKIT&BENCKISER(BMC )',
      strength: '300MG',
    });
    for (const [alias, name] of pairs) {
      expect(byKey.get(`catalog-${alias}`)?.brandName, alias).toBe(name);
    }
  });
});
