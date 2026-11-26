import { describe, expect, it } from 'vitest';
import {
  buildStarterCatalogue,
  validateStarterCatalogue,
  parseStarterCsv,
  serializeStarterCsv,
  STARTER_CSV_HEADERS,
  validateStarterRelease,
} from './starter-reference';

const item = {
  sourceId: '001',
  legacyCode: 'LEG-A',
  name: 'QA product A',
  packSize: 12,
  class: 'NARCOTICS',
  verifiedGeneric: null,
  manufacturerLabel: null,
  active: false,
  controlled: false,
};

describe('starter reference input boundary', () => {
  it('accepts verified overlays only for the same code and name, preserving inactive and controlled status', () => {
    const other = { ...item, sourceId: '002', name: 'QA product B' };
    const result = buildStarterCatalogue(
      [other, item],
      [
        { sourceId: '001', name: item.name, verifiedGeneric: 'QA generic' },
        { sourceId: '002', name: 'QA different', verifiedGeneric: 'Wrong generic' },
        { sourceId: '003', name: item.name, verifiedGeneric: 'Wrong generic' },
      ]
    );
    expect(result.rows).toEqual([
      {
        ...item,
        controlled: true,
        verifiedGeneric: 'QA generic',
        fieldSource: 'Abuzar; V4:generic_name',
      },
      { ...other, controlled: true, fieldSource: 'Abuzar' },
    ]);
    expect(result.reconciliation).toEqual({ matched: 1, differentName: 1, absentCode: 1 });
  });

  it('retains explicit verified pack/label overrides with individual provenance and null fallback', () => {
    const source = {
      ...item,
      name: '  QA product A  ',
      verifiedGeneric: ' Base generic ',
      manufacturerLabel: ' Base label ',
    };
    const { rows } = buildStarterCatalogue(
      [source],
      [
        {
          sourceId: item.sourceId,
          name: 'qa  product a',
          packSize: 24,
          verifiedGeneric: ' Verified generic ',
          manufacturerLabel: ' Verified label ',
        },
      ]
    );
    expect(rows[0]).toEqual({
      ...source,
      controlled: true,
      packSize: 24,
      verifiedGeneric: ' Verified generic ',
      manufacturerLabel: ' Verified label ',
      fieldSource: 'Abuzar; V4:pack_units,generic_name,manufacturer_label',
    });
    expect(
      buildStarterCatalogue(
        [source],
        [
          {
            sourceId: item.sourceId,
            name: source.name,
            packSize: null,
            verifiedGeneric: null,
            manufacturerLabel: null,
          },
        ]
      ).rows[0]
    ).toEqual({ ...source, controlled: true, fieldSource: 'Abuzar' });
  });

  it('cleans only the literal old-code marker and blanks the source NONE generic', () => {
    const { rows } = buildStarterCatalogue(
      [
        { ...item, sourceId: '003', legacyCode: ' . ', verifiedGeneric: ' NONE ' },
        { ...item, sourceId: '001', legacyCode: ' 00(.)12 ', categoryName: ' Category ' },
        { ...item, sourceId: '002', legacyCode: '(x)' },
        { ...item, sourceId: '004', legacyCode: '' },
      ],
      []
    );
    expect(rows.map((row) => row.legacyCode)).toEqual([' 00(.)12 ', '(x)', null, null]);
    expect(rows[0]!.categoryName).toBe(' Category ');
    expect(rows[2]!.verifiedGeneric).toBeNull();
    expect(rows.every((row) => row.fieldSource === 'Abuzar')).toBe(true);
  });

  it('rejects extra fields in either input and in the generated product', () => {
    expect(() => buildStarterCatalogue([{ ...item, stock: 1 }], [])).toThrow();
    expect(() =>
      buildStarterCatalogue([item], [{ sourceId: item.sourceId, name: item.name, supplier: 'QA' }])
    ).toThrow();
    expect(() => validateStarterCatalogue([{ ...item, price: 1 }])).toThrow();
  });

  it('refuses duplicate identities, missing required fields and uncontrolled NARCOTICS output', () => {
    expect(() => buildStarterCatalogue([item, item], [])).toThrow();
    const overlay = { sourceId: item.sourceId, name: item.name, packSize: 2 };
    expect(() => buildStarterCatalogue([item], [overlay, overlay])).toThrow();
    expect(() => validateStarterCatalogue([{ ...item, class: undefined }])).toThrow();
    expect(() => validateStarterCatalogue([item])).toThrow();
  });
});

const row = [
  '0009007199254740993',
  '00123',
  '  QA, "product"\r\nnext  ',
  '12',
  'false',
  'NARCOTICS',
  '',
  'true',
  ' QA generic ',
  ' Abuzar label ',
  ' Abuzar; V4:generic_name ',
];
const cell = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const csv = (values = row, headers: readonly string[] = STARTER_CSV_HEADERS) =>
  headers.join(',') + '\r\n' + values.map(cell).join(',') + '\r\n';

describe('approved starter CSV boundary', () => {
  it('preserves text identities, labels, quoting, optional category and opaque provenance', () => {
    expect(parseStarterCsv('\uFEFF' + csv())).toEqual([
      {
        sourceId: row[0],
        legacyCode: row[1],
        name: row[2],
        packSize: 12,
        active: false,
        class: 'NARCOTICS',
        categoryName: null,
        controlled: true,
        verifiedGeneric: row[8],
        manufacturerLabel: row[9],
        fieldSource: row[10],
      },
    ]);
    const values = [...row];
    values[10] = 'operator text, without prescribed syntax';
    expect(parseStarterCsv(csv(values))[0]!.fieldSource).toBe(values[10]);
  });

  it('serializes eleven exact columns with RFC quoting and no coercion of text', () => {
    const { rows } = buildStarterCatalogue(
      [
        {
          ...item,
          sourceId: '0009007199254740993',
          legacyCode: '00123',
          name: '  QA, "product"\r\nnext  ',
          categoryName: ' Category ',
        },
      ],
      [
        {
          sourceId: '0009007199254740993',
          name: 'qa, "product" next',
          verifiedGeneric: ' Verified generic ',
        },
      ]
    );
    const serialized = serializeStarterCsv(rows);
    expect(serialized).toBe(
      'source_id,legacy_code,name,pack_units,active,class_name,category_name,controlled,generic_name,manufacturer_label,field_source\r\n' +
        '"0009007199254740993","00123","  QA, ""product""\r\nnext  ","12","false","NARCOTICS"," Category ","true"," Verified generic ","","Abuzar; V4:generic_name"\r\n'
    );
    expect(parseStarterCsv(serialized)).toEqual(rows);
    expect(
      parseStarterCsv(serializeStarterCsv(buildStarterCatalogue([item], []).rows))[0]!.categoryName
    ).toBeNull();
  });

  it('accepts missing optional pack and labels', () => {
    const values = [...row];
    for (const i of [1, 3, 5, 8, 9]) values[i] = '';
    values[6] = ' Category as stored ';
    expect(parseStarterCsv(csv(values))[0]).toMatchObject({
      packSize: null,
      legacyCode: null,
      class: null,
      verifiedGeneric: null,
      manufacturerLabel: null,
      categoryName: values[6],
    });
  });

  it('rejects header additions, removals, duplicates, reordering and whitespace', () => {
    for (const headers of [
      STARTER_CSV_HEADERS.slice(1),
      [...STARTER_CSV_HEADERS, 'price'],
      [...STARTER_CSV_HEADERS].reverse(),
      STARTER_CSV_HEADERS.map(() => 'source_id'),
      STARTER_CSV_HEADERS.map((h) => ' ' + h),
    ]) {
      expect(() => parseStarterCsv(csv(row, headers))).toThrow(/headers/);
    }
  });

  it('rejects bad types, uncontrolled narcotics, missing required values and ragged rows', () => {
    for (const [index, value] of [
      [0, ''],
      [2, ' '],
      [3, '0'],
      [3, '-1'],
      [3, '1.5'],
      [3, '1e2'],
      [3, '2147483648'],
      [4, '1'],
      [4, 'TRUE'],
      [7, 'false'],
      [7, 'no'],
      [10, ' '],
    ] as const) {
      const values = [...row];
      values[index] = value;
      expect(() => parseStarterCsv(csv(values))).toThrow();
    }
    expect(() => parseStarterCsv(csv(row.slice(1)))).toThrow();
    expect(() => parseStarterCsv(csv([...row, 'extra']))).toThrow();
    expect(() => parseStarterCsv(STARTER_CSV_HEADERS.join(',') + '\n')).toThrow();
  });

  it('rejects duplicate IDs, malformed quoting, binary data and JSON', () => {
    const body = row.map(cell).join(',');
    for (const text of [
      csv() + body,
      csv().replace('"12"', '"12"x'),
      csv().slice(0, -3),
      csv() + '\0',
      'null',
      '[]',
    ]) {
      expect(() => parseStarterCsv(text)).toThrow();
    }
  });

  it('refuses incomplete release counts', () => {
    expect(() => validateStarterRelease(parseStarterCsv(csv()))).toThrow(/counts differ/);
  });
});
