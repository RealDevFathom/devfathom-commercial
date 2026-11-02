import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * The tenant's own medicine names, for keeping drug names out of customer-facing text
 * (DEV-576). Names come from the catalogue (product and brand names), aliases (brand,
 * generic, Urdu and transliterated spellings) and ingredient (salt) names. Legacy codes
 * are aliases but not names, so they are left out.
 */

/** Rows read per source; a tenant catalogue larger than this is checked on its first rows. */
export const MEDICINE_NAME_QUERY_LIMIT = 5_000;
/** Shorter names ("Q", "AB") would match ordinary words. */
export const MIN_MEDICINE_NAME_LENGTH = 3;

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
 * "Panadol Extra 500mg Tablet" also yields "panadol extra".
 */
export function medicineNameVariants(value: string): string[] {
  const full = normalizeNameText(value);
  if (!full) return [];
  const words = full.split(' ');
  const cut = words.findIndex((word) => /\d/.test(word));
  const base = (cut === -1 ? words : words.slice(0, cut)).join(' ');
  return [...new Set([full, base])].filter((name) => [...name].length >= MIN_MEDICINE_NAME_LENGTH);
}

/** Build a name set from raw catalogue strings. */
export function medicineNameSet(values: Iterable<string | null | undefined>): Set<string> {
  const names = new Set<string>();
  for (const value of values) {
    if (value) for (const name of medicineNameVariants(value)) names.add(name);
  }
  return names;
}

/** Read the tenant's medicine names. `db` must be tenant-scoped (RLS). */
export async function readTenantMedicineNames(db: ScopedDb): Promise<Set<string>> {
  const [medicines, aliases, ingredients] = await Promise.all([
    db.medicine.findMany({
      select: { productName: true, brandName: true },
      orderBy: { id: 'asc' },
      take: MEDICINE_NAME_QUERY_LIMIT,
    }),
    db.medicineAlias.findMany({
      where: { type: { not: 'LEGACY_CODE' } },
      select: { value: true },
      orderBy: { id: 'asc' },
      take: MEDICINE_NAME_QUERY_LIMIT,
    }),
    db.ingredient.findMany({
      select: { name: true },
      orderBy: { id: 'asc' },
      take: MEDICINE_NAME_QUERY_LIMIT,
    }),
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
