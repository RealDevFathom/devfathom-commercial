import { z } from 'zod';
import { isLegacyControlledClass, legacyProductNameKey } from './legacy-class';

// Validate without normalizing stored labels or text identities.
const label = z.string().refine((value) => value.trim().length > 0);
const fields = {
  sourceId: label,
  legacyCode: label.nullable(),
  name: label,
  packSize: z.number().int().positive().max(2147483647).nullable(),
  class: label.nullable(),
  categoryName: label.nullable().optional(),
  verifiedGeneric: label.nullable(),
  manufacturerLabel: label.nullable(),
  active: z.boolean(),
  controlled: z.boolean(),
};
const reference = z.strictObject(fields);
const sourceProduct = reference.extend({
  legacyCode: z
    .string()
    .nullable()
    .transform((value) => {
      const code = value?.trim();
      return !code || code === '.' ? null : value;
    }),
});
const overlay = z.strictObject({
  sourceId: fields.sourceId,
  name: fields.name,
  packSize: fields.packSize.optional(),
  verifiedGeneric: fields.verifiedGeneric.optional(),
  manufacturerLabel: fields.manufacturerLabel.optional(),
});
const generated = reference.extend({ fieldSource: label.optional() });
export type StarterProduct = z.infer<typeof generated>;

function bySource<T extends { sourceId: string }>(rows: T[]) {
  const result = new Map<string, T>();
  for (const item of rows) {
    if (result.has(item.sourceId)) throw new Error('Duplicate starter source identity.');
    result.set(item.sourceId, item);
  }
  return result;
}

export function validateStarterCatalogue(input: unknown) {
  const rows = z.array(generated).min(1).parse(input);
  bySource(rows);
  if (rows.some((row) => isLegacyControlledClass(row.class) && !row.controlled))
    throw new Error('NARCOTICS products must remain controlled.');
  return rows;
}

// Overlays already resolve to internal ICode/sourceId; they are not raw V4 Legacy Codes.
export function buildStarterCatalogue(source: unknown, verified: unknown) {
  const products = bySource(
    z
      .array(sourceProduct)
      .min(1)
      .parse(source)
      .map((product) => ({
        ...product,
        verifiedGeneric:
          product.verifiedGeneric?.trim().toUpperCase() === 'NONE' ? null : product.verifiedGeneric,
        fieldSource: 'Abuzar',
      }))
  );
  const reconciliation = { matched: 0, differentName: 0, absentCode: 0 };
  for (const patch of bySource(z.array(overlay).parse(verified)).values()) {
    const product = products.get(patch.sourceId);
    if (!product) reconciliation.absentCode++;
    else if (legacyProductNameKey(product.name) !== legacyProductNameKey(patch.name))
      reconciliation.differentName++;
    else {
      reconciliation.matched++;
      product.packSize = patch.packSize ?? product.packSize;
      product.verifiedGeneric = patch.verifiedGeneric ?? product.verifiedGeneric;
      product.manufacturerLabel = patch.manufacturerLabel ?? product.manufacturerLabel;
      const verifiedFields = [
        patch.packSize != null ? 'pack_units' : null,
        patch.verifiedGeneric != null ? 'generic_name' : null,
        patch.manufacturerLabel != null ? 'manufacturer_label' : null,
      ].filter(Boolean);
      if (verifiedFields.length) product.fieldSource += '; V4:' + verifiedFields.join(',');
    }
  }
  const rows = Array.from(products.values(), (product) => ({
    ...product,
    controlled: product.controlled || isLegacyControlledClass(product.class),
  })).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return { rows: validateStarterCatalogue(rows), reconciliation };
}

export const STARTER_CSV_HEADERS = [
  'source_id',
  'legacy_code',
  'name',
  'pack_units',
  'active',
  'class_name',
  'category_name',
  'controlled',
  'generic_name',
  'manufacturer_label',
  'field_source',
] as const;

// RFC-style quoted cells, including escaped quotes and embedded CR/LF; never trim cells.
export function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const finishCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else if (char === '"' && cell === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('Malformed starter CSV quoting.');
      cell += char;
    }
  }
  if (quoted) throw new Error('Unclosed starter CSV quote.');
  if (cell !== '' || row.length || closed) finishRow();
  return records;
}

export function parseStarterCsv(text: string) {
  if (text.includes('\0') || text.includes('\uFFFD'))
    throw new Error('Invalid starter CSV encoding.');
  const [headers, ...records] = csvRecords(text.replace(/^\uFEFF/, ''));
  if (
    !headers ||
    headers.length !== STARTER_CSV_HEADERS.length ||
    headers.some((value, i) => value !== STARTER_CSV_HEADERS[i])
  )
    throw new Error('Starter CSV headers must match the approved order exactly.');
  const boolean = (value: string) => {
    if (value !== 'true' && value !== 'false') throw new Error('Invalid starter boolean.');
    return value === 'true';
  };
  const optional = (value: string) => (value === '' ? null : value);
  const rows = records.map((cells) => {
    if (cells.length !== headers.length) throw new Error('Invalid starter CSV column count.');
    const [
      sourceId,
      legacyCode,
      name,
      pack,
      active,
      className,
      categoryName,
      controlled,
      generic,
      manufacturerLabel,
      fieldSource,
    ] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (pack !== '' && !/^[1-9][0-9]*$/.test(pack)) throw new Error('Invalid starter pack units.');
    if (!fieldSource.trim()) throw new Error('Starter provenance is required.');
    return {
      sourceId,
      legacyCode: optional(legacyCode),
      name,
      packSize: pack === '' ? null : Number(pack),
      active: boolean(active),
      class: optional(className),
      categoryName: optional(categoryName),
      controlled: boolean(controlled),
      verifiedGeneric: optional(generic),
      manufacturerLabel: optional(manufacturerLabel),
      fieldSource,
    };
  });
  validateStarterCatalogue(rows);
  return rows;
}

export function serializeStarterCsv(rows: StarterProduct[]) {
  const cell = (value: string | number | boolean | null | undefined) =>
    '"' + String(value ?? '').replaceAll('"', '""') + '"';
  return (
    STARTER_CSV_HEADERS.join(',') +
    '\r\n' +
    rows
      .map((row) =>
        [
          row.sourceId,
          row.legacyCode,
          row.name,
          row.packSize,
          row.active,
          row.class,
          row.categoryName,
          row.controlled,
          row.verifiedGeneric,
          row.manufacturerLabel,
          row.fieldSource ?? 'Abuzar',
        ]
          .map(cell)
          .join(',')
      )
      .join('\r\n') +
    '\r\n'
  );
}

export function validateStarterRelease(rows: StarterProduct[]) {
  const counts = {
    products: rows.length,
    active: rows.filter((row) => row.active).length,
    inactive: rows.filter((row) => !row.active).length,
    narcotics: rows.filter((row) => isLegacyControlledClass(row.class)).length,
    controlled: rows.filter((row) => row.controlled).length,
    generic: rows.filter((row) => row.verifiedGeneric !== null).length,
  };
  if (
    counts.products !== 26054 ||
    counts.active !== 18170 ||
    counts.inactive !== 7884 ||
    counts.narcotics !== 1476 ||
    counts.controlled !== 1558 ||
    counts.generic !== 5496
  )
    throw new Error('Catalogue counts differ from the approved Abuzar inspection.');
  return counts;
}
