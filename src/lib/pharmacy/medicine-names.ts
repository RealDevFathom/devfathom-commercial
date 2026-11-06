import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * The tenant's own medicine names, for keeping drug names out of customer-facing text
 * (DEV-576). Names come from the catalogue (product and brand names), aliases (brand,
 * generic, Urdu and transliterated spellings) and ingredient (salt) names. Legacy codes
 * are aliases but not names, so they are left out.
 */

/** Rows read per page, paged by id. */
export const MEDICINE_NAME_QUERY_LIMIT = 5_000;
/** Rows read per source in total; a larger catalogue is checked on its first rows and logged. */
export const MEDICINE_NAME_MAX_ROWS = 100_000;
/** Shorter names ("Q", "AB") would match ordinary words. */
export const MIN_MEDICINE_NAME_LENGTH = 3;

/** Dose-form and unit words: a name's leading words before one of these are also a name. */
const DOSE_FORM_WORDS = new Set([
  'tablet',
  'tablets',
  'tab',
  'tabs',
  'capsule',
  'capsules',
  'cap',
  'caps',
  'syrup',
  'syp',
  'suspension',
  'susp',
  'drops',
  'drop',
  'injection',
  'inj',
  'cream',
  'ointment',
  'oint',
  'gel',
  'sachet',
  'sachets',
  'lotion',
  'spray',
  'inhaler',
  'infusion',
  'solution',
  'powder',
  'elixir',
  'ml',
  'mg',
  'mcg',
  'goli',
  'golian',
  'goliyan',
  'sharbat',
  'qatray',
  'qatre',
  'گولی',
  'گولیاں',
  'شربت',
  'کیپسول',
  'قطرے',
  'انجکشن',
  'کریم',
]);

/**
 * Ordinary words that are not names on their own, though a product may start with them
 * ("Eye Drops", "Baby Syrup"). The full product name is still kept.
 */
const SHORT_NAME_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'new',
  'eye',
  'ear',
  'nose',
  'nasal',
  'oral',
  'baby',
  'kids',
  'child',
  'children',
  'adult',
  'cough',
  'cold',
  'flu',
  'pain',
  'fever',
  'skin',
  'hair',
  'multi',
  'vitamin',
  'vitamins',
  'extra',
  'plus',
  'forte',
  'sugar',
  'free',
  'relief',
]);

/** Lower-case, accents removed, every run of non-letters/digits collapsed to one space. */
export function normalizeNameText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The full normalized name plus its leading words before a strength or dose form, so
 * "Panadol Extra 500mg Tablet" also yields "panadol extra" and "Calpol Syrup 120ml"
 * yields "calpol". A leading part that is only an ordinary word ("eye") is dropped.
 */
export function medicineNameVariants(value: string): string[] {
  const full = normalizeNameText(value);
  if (!full) return [];
  const words = full.split(' ');
  const cut = words.findIndex((word) => /\d/.test(word) || DOSE_FORM_WORDS.has(word));
  const base = (cut === -1 ? words : words.slice(0, cut)).join(' ');
  const names = [full];
  if (base !== full && !SHORT_NAME_STOPWORDS.has(base)) names.push(base);
  return names.filter((name) => [...name].length >= MIN_MEDICINE_NAME_LENGTH);
}

/** Build a name set from raw catalogue strings. */
export function medicineNameSet(values: Iterable<string | null | undefined>): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    if (value) for (const name of medicineNameVariants(value)) names.add(name);
  }
  return names;
}

/**
 * Read every row of one source, a page at a time by id, up to MEDICINE_NAME_MAX_ROWS.
 * Hitting the bound is logged (source and row count only).
 */
async function readAllPages<T extends { id: string }>(
  source: string,
  readPage: (afterId: string | undefined) => Promise<T[]>
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = await readPage(afterId);
    rows.push(...page);
    if (page.length < MEDICINE_NAME_QUERY_LIMIT) return rows;
    if (rows.length >= MEDICINE_NAME_MAX_ROWS) {
      console.warn('PHARMACY_MEDICINE_NAMES_TRUNCATED', { source, rows: rows.length });
      return rows;
    }
    afterId = page.at(-1)!.id;
  }
}

const afterIdWhere = (afterId: string | undefined) => (afterId ? { id: { gt: afterId } } : {});

/** Read the tenant's medicine names. `db` must be tenant-scoped (RLS). */
export async function readTenantMedicineNames(db: ScopedDb): Promise<Set<string>> {
  const [medicines, aliases, ingredients] = await Promise.all([
    readAllPages('medicine', (afterId) =>
      db.medicine.findMany({
        where: afterIdWhere(afterId),
        select: { id: true, productName: true, brandName: true },
        orderBy: { id: 'asc' },
        take: MEDICINE_NAME_QUERY_LIMIT,
      })
    ),
    readAllPages('medicineAlias', (afterId) =>
      db.medicineAlias.findMany({
        where: { type: { not: 'LEGACY_CODE' }, ...afterIdWhere(afterId) },
        select: { id: true, value: true },
        orderBy: { id: 'asc' },
        take: MEDICINE_NAME_QUERY_LIMIT,
      })
    ),
    readAllPages('ingredient', (afterId) =>
      db.ingredient.findMany({
        where: afterIdWhere(afterId),
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
        take: MEDICINE_NAME_QUERY_LIMIT,
      })
    ),
  ]);
  return medicineNameSet([
    ...medicines.flatMap((row) => [row.productName, row.brandName]),
    ...aliases.map((row) => row.value),
    ...ingredients.map((row) => row.name),
  ]);
}

/** Whether `text` contains any of `names` as whole words, after normalization. */
export function containsMedicineName(text: string, names: ReadonlySet<string>): boolean {
  const haystack = ` ${normalizeNameText(text)} `;
  for (const name of names) if (haystack.includes(` ${name} `)) return true;
  return false;
}
