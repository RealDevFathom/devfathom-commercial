/**
 * Platform default medicine catalogue — the pure half.
 *
 * Turns the two source exports (the app reference-import CSV and the POS item
 * export it was produced from) into the committed, deterministic seed file, and
 * parses that seed file back. No database, no Node APIs, no imports: the seed
 * builder script, the loader, and the unit tests all share exactly this code.
 *
 * WHAT IS DELIBERATELY DROPPED. The POS export carries sale/purchase prices,
 * QTY and StockValue. None of it is copied: the seed has no column for it, so
 * a tenant's materialised catalogue starts with zero stock and no prices. Only
 * Name, classname and Category are read, and only to classify.
 *
 * CONTROLLED CANDIDATES. Rows the POS filed under NARCOTICS (its `classname`,
 * and the handful whose `Category` says so) are flagged `controlledCandidate`
 * for pharmacist review. The POS bucket is not a regulatory schedule — it holds
 * creams and supplements as well as benzodiazepines — so it never becomes a
 * `controlled` flag here; it only withholds the row from sale until reviewed.
 */

export const DEFAULT_CATALOGUE_KEY = 'pharmacy-default';

export type CatalogueProductFamily =
  'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP';

export type DefaultCatalogueSeedRow = {
  sourceKey: string;
  productName: string;
  brandName: string | null;
  manufacturer: string | null;
  strength: string | null;
  dosageForm: string | null;
  productFamily: CatalogueProductFamily;
  controlledCandidate: boolean;
};

export const SEED_COLUMNS = [
  'sourceKey',
  'productName',
  'brandName',
  'manufacturer',
  'strength',
  'dosageForm',
  'productFamily',
  'controlledCandidate',
] as const;

const FAMILIES: ReadonlySet<string> = new Set([
  'PHARMACEUTICAL',
  'BIOLOGICAL',
  'DEVICE',
  'ALTERNATIVE',
  'FRONT_SHOP',
]);

const MAX_TEXT = 300;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * POS `Category` → product family. Matching is on the normalised category, so
 * `MEDICINE` and `MEDICINE.` are one bucket. Anything unrecognised falls back to
 * PHARMACEUTICAL: that family carries the strictest saleable gate (strength,
 * DRAP registration and its provenance), so a misfiled row errs towards more
 * review, never less. FRONT_SHOP is reserved for categories that are plainly
 * not medicines.
 */
const CATEGORY_FAMILY: ReadonlyMap<string, CatalogueProductFamily> = new Map([
  ['MEDICINE', 'PHARMACEUTICAL'],
  ['NARCOTICS', 'PHARMACEUTICAL'],
  ['SURGICAL ITEMS', 'DEVICE'],
  ['INSTUMERNT ITEM', 'DEVICE'],
  ['INSTRUMENT ITEM', 'DEVICE'],
  ['OPTICS', 'DEVICE'],
  ['SUGER STRIPS', 'DEVICE'],
  ['SUGAR STRIPS', 'DEVICE'],
  ['COSMETIC', 'FRONT_SHOP'],
  ['CONSUMER', 'FRONT_SHOP'],
  ['MILK PRODUCTS', 'FRONT_SHOP'],
  ['PAMPERS', 'FRONT_SHOP'],
  ['CARDS', 'FRONT_SHOP'],
  ['DRINK', 'FRONT_SHOP'],
]);

/** Trim, collapse runs of whitespace, and turn an empty value into null. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_TEXT ? cleaned.slice(0, MAX_TEXT).trimEnd() : cleaned;
}

function categoryKey(value: string | null | undefined): string {
  return (cleanText(value) ?? '').toUpperCase().replace(/[.\s]+$/, '');
}

export function familyForPosCategory(category: string | null | undefined): CatalogueProductFamily {
  return CATEGORY_FAMILY.get(categoryKey(category)) ?? 'PHARMACEUTICAL';
}

export function isControlledCandidate(pos: {
  classname?: string | null;
  Category?: string | null;
}): boolean {
  return categoryKey(pos.classname) === 'NARCOTICS' || categoryKey(pos.Category) === 'NARCOTICS';
}

/** RFC 4180 CSV → records keyed by header. Strips a UTF-8 BOM. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((cells) => cells.some((cell) => cell !== ''));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  return body.map((cells, line) => {
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${line + 2} has ${cells.length} fields; expected ${header.length}.`);
    }
    return Object.fromEntries(header.map((name, column) => [name, cells[column] ?? '']));
  });
}

function csvCell(value: string): string {
  const quote = /[",\r\n]/.test(value) || value !== value.trim();
  return quote ? `"${value.replaceAll('"', '""')}"` : value;
}

export type PosExportRow = Record<string, string>;
export type ReferenceImportRow = Record<string, string>;

/** `catalog-123` → `123`, the POS `aliasname` it was exported from. */
function posAliasForSourceKey(sourceKey: string): string | null {
  return sourceKey.startsWith('catalog-') ? sourceKey.slice('catalog-'.length) || null : null;
}

/** Purely numeric aliases sort numerically, ahead of everything else. */
function numericOrder(sourceKey: string): number {
  const match = /^catalog-(\d+)$/.exec(sourceKey);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Join the reference rows to the POS rows they came from and produce the seed.
 *
 * The join is reference `rowSourceKey` `catalog-<alias>` = POS `aliasname`. A
 * reference row with no such key falls back to an exact name match against a
 * POS row that has no aliasname at all — and only when that name is unique —
 * so a renamed or duplicated product can never borrow another row's class. A
 * row with no POS match keeps the conservative defaults (PHARMACEUTICAL, not a
 * controlled candidate).
 *
 * Output is sorted (numeric aliases by number, then by key), so the same inputs
 * always produce byte-identical seed files.
 */
export function buildSeedRows(
  reference: readonly ReferenceImportRow[],
  pos: readonly PosExportRow[]
): DefaultCatalogueSeedRow[] {
  const byAlias = new Map<string, PosExportRow>();
  const unaliasedByName = new Map<string, PosExportRow[]>();
  for (const row of pos) {
    const alias = cleanText(row.aliasname);
    if (alias) {
      if (!byAlias.has(alias)) byAlias.set(alias, row);
      continue;
    }
    const name = cleanText(row.Name)?.toUpperCase();
    if (name) unaliasedByName.set(name, [...(unaliasedByName.get(name) ?? []), row]);
  }

  const seen = new Set<string>();
  const rows: DefaultCatalogueSeedRow[] = [];
  for (const source of reference) {
    const sourceKey = cleanText(source.rowSourceKey);
    if (!sourceKey || !SOURCE_KEY.test(sourceKey)) {
      throw new Error(`Reference row has an invalid rowSourceKey: ${JSON.stringify(sourceKey)}.`);
    }
    if (seen.has(sourceKey)) throw new Error(`Duplicate rowSourceKey ${sourceKey}.`);
    seen.add(sourceKey);

    const brandName = cleanText(source.brandName);
    const productName = cleanText(source.productName) ?? brandName;
    if (!productName) throw new Error(`Row ${sourceKey} has neither productName nor brandName.`);

    const alias = posAliasForSourceKey(sourceKey);
    let match = alias ? byAlias.get(alias) : undefined;
    if (!match) {
      const candidates = unaliasedByName.get((brandName ?? productName).toUpperCase());
      if (candidates?.length === 1) match = candidates[0];
    }

    rows.push({
      sourceKey,
      productName,
      brandName,
      manufacturer: cleanText(source.manufacturer),
      strength: cleanText(source.strength),
      dosageForm: cleanText(source.dosageForm),
      productFamily: match ? familyForPosCategory(match.Category) : 'PHARMACEUTICAL',
      controlledCandidate: match ? isControlledCandidate(match) : false,
    });
  }
  return rows.sort(
    (left, right) =>
      numericOrder(left.sourceKey) - numericOrder(right.sourceKey) ||
      (left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0)
  );
}

export function serializeSeedCsv(rows: readonly DefaultCatalogueSeedRow[]): string {
  const lines = [SEED_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      SEED_COLUMNS.map((column) => {
        const value = row[column];
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return csvCell(value ?? '');
      }).join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Parse and validate a seed file. Throws on any row the materialiser could not trust. */
export function parseSeedCsv(text: string): DefaultCatalogueSeedRow[] {
  const records = parseCsv(text);
  const seen = new Set<string>();
  return records.map((record, index) => {
    const line = index + 2;
    for (const column of SEED_COLUMNS) {
      if (!(column in record)) throw new Error(`Seed is missing the ${column} column.`);
    }
    const sourceKey = cleanText(record.sourceKey);
    if (!sourceKey || !SOURCE_KEY.test(sourceKey)) {
      throw new Error(`Seed line ${line} has an invalid sourceKey.`);
    }
    if (seen.has(sourceKey)) throw new Error(`Seed line ${line} repeats sourceKey ${sourceKey}.`);
    seen.add(sourceKey);
    const productName = cleanText(record.productName);
    if (!productName) throw new Error(`Seed line ${line} has no productName.`);
    const productFamily = cleanText(record.productFamily);
    if (!productFamily || !FAMILIES.has(productFamily)) {
      throw new Error(`Seed line ${line} has an unknown productFamily.`);
    }
    const controlled = cleanText(record.controlledCandidate);
    if (controlled !== 'true' && controlled !== 'false') {
      throw new Error(`Seed line ${line} has a non-boolean controlledCandidate.`);
    }
    return {
      sourceKey,
      productName,
      brandName: cleanText(record.brandName),
      manufacturer: cleanText(record.manufacturer),
      strength: cleanText(record.strength),
      dosageForm: cleanText(record.dosageForm),
      productFamily: productFamily as CatalogueProductFamily,
      controlledCandidate: controlled === 'true',
    };
  });
}

/**
 * A stable, order-independent text for one row's content, used to notice when
 * a later catalogue version changed an item a tenant already holds. The caller
 * hashes it; this module stays free of Node APIs.
 */
export function seedRowContent(row: Omit<DefaultCatalogueSeedRow, 'sourceKey'>): string {
  return JSON.stringify([
    row.productName,
    row.brandName,
    row.manufacturer,
    row.strength,
    row.dosageForm,
    row.productFamily,
    row.controlledCandidate,
  ]);
}

/** Presentation label for a materialised medicine, or null when there is nothing to say. */
export function presentationLabel(row: {
  strength: string | null;
  dosageForm: string | null;
}): string | null {
  const label = [row.strength, row.dosageForm].filter(Boolean).join(' ');
  return label || null;
}
