// Shared #198 drug guard, extracted from fix/wa-drug-guard-2 templates.ts.
import confusables from './unicode-confusables';
import { PROHIBITED_DRUG_NAMES } from './prohibited-drugs';
type MedicineFamilyDb = { medicine: { findMany(args: never): Promise<unknown> } };
export class ProhibitedDrugInCopy extends Error {
  constructor() {
    super('Marketing copy names a prescription, controlled, or restricted medicine.');
    this.name = 'ProhibitedDrugInCopy';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Policy folds supplement the full vendored UTS #39 skeleton.
const DRUG_FOLD: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '€': 'e',
  l: 'i',
  ᴀ: 'a',
  ي: 'ی',
  ى: 'ی',
  ك: 'ک',
  ه: 'ہ',
  ة: 'ہ',
};

function foldDrugText(value: string): string {
  const digits = value
    .toLowerCase()
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) % 16));
  const policy = [...digits].map((c) => DRUG_FOLD[c] ?? c).join('');
  const skeleton = [...policy.normalize('NFKD')]
    .map((c) => (confusables as Record<string, string>)[c] ?? c)
    .join('')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\p{M}\u0640]/gu, '');
  return [...skeleton].map((c) => DRUG_FOLD[c] ?? c).join('');
}

export function normalizeDrugName(value: string): string {
  return foldDrugText(value)
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/(.)\1+/gu, '$1');
}

/** Long names allow affixes. Short names retain boundaries; repeated letters
 * and separators are accepted on both the body and catalog/list side. */
export function bodyNamesProhibitedDrug(body: string, names: readonly string[]): boolean {
  const text = foldDrugText(body);
  // A common adjective, explicitly reviewed in PR #175. Apply only to the
  // Lyrica alias so tenant catalog names remain enforceable.

  for (const raw of names) {
    const name = normalizeDrugName(raw);
    if (name.length < 3) continue;
    const letters = [...name].map((c) => `(?:${escapeRegExp(c)}[^\\p{L}\\p{N}]*)+`).join('');
    const long = normalizeDrugName(raw).length >= 5;
    const pattern = new RegExp(
      `${long ? '' : '(?<![\\p{L}\\p{N}])'}${letters}${long ? '' : '(?![\\p{L}\\p{N}])'}`,
      'iu'
    );
    const candidate =
      normalizeDrugName(raw) === normalizeDrugName('lyrica')
        ? text.replace(
            new RegExp(
              `(?<![\\p{L}\\p{N}])${escapeRegExp(foldDrugText('lyrical'))}(?![\\p{L}\\p{N}])`,
              'gu'
            ),
            ''
          )
        : text;
    if (pattern.test(candidate)) return true;
  }
  return false;
}

type MedicineReader = MedicineFamilyDb;

function readMedicines(db: MedicineReader, args: object): Promise<unknown> {
  return (db.medicine.findMany as (query: object) => Promise<unknown>)(args);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function prohibitedNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) throw new ProhibitedDrugInCopy();
  const names: string[] = [];
  for (const row of rows) {
    const value = asRecord(row);
    if (!value) continue;
    if (typeof value.productName === 'string') names.push(value.productName);
    if (typeof value.brandName === 'string') names.push(value.brandName);
    if (Array.isArray(value.aliases)) {
      for (const alias of value.aliases) {
        const record = asRecord(alias);
        if (typeof record?.value === 'string') names.push(record.value);
      }
    }
    if (Array.isArray(value.strengths)) {
      for (const strength of value.strengths) {
        const ingredient = asRecord(asRecord(strength)?.ingredient);
        if (typeof ingredient?.name === 'string') names.push(ingredient.name);
      }
    }
  }
  return names;
}

/**
 * Refuses marketing text naming any tenant medicine, including OTC, or a
 * prohibited drug from the shared #198 list. A lookup error fails closed.
 */
export async function assertMarketingCopyAllowed(
  db: MedicineReader,
  organizationId: string,
  body: string
): Promise<void> {
  // Exempt only the named non-medicine products, keeping other text checked.
  const genericBody = body.replace(
    /\b(?:medicine\s+box\s+organizer|prescription\s+glasses|nuskhay\s+ki\s+kitaab)\b/giu,
    'front shop accessory'
  );
  // Generic medicine language is prohibited even when no catalog drug is named.
  if (
    /(?<![\p{L}\p{N}])r\s*x(?![\p{L}\p{N}])/u.test(foldDrugText(genericBody)) ||
    body.includes('℞') ||
    bodyNamesProhibitedDrug(genericBody, [
      'Panadol',
      'paracetamol',
      'ibuprofen',
      'aspirin',
      'drug',
      'prescription',
      'nuskha',
      'dawai',
      'dawa',
      'medicine',
      'tablets',
      'pills',
      'syrup',
      'antibiotics',
      'دوائی',
      'دوا',
      'نسخہ',
      'ask your doctor',
      'ڈاکٹر سے پوچھیں',
    ])
  )
    throw new ProhibitedDrugInCopy();
  let rows: unknown;
  try {
    rows = await readMedicines(db, {
      where: {
        organizationId,
      },
      select: {
        productName: true,
        brandName: true,
        aliases: { select: { value: true } },
        strengths: { select: { ingredient: { select: { name: true } } } },
      },
    });
  } catch (error) {
    if (error instanceof ProhibitedDrugInCopy) throw error;
    throw new ProhibitedDrugInCopy();
  }
  // The accessory noun must immediately follow insulin; insulin elsewhere still blocks.
  const checkedBody = body
    .replace(
      /\binsulin\s+(?:pen\s+needles|cooler\s+bags?|syringes|ka\s+(?:pen|cooler))\b/giu,
      'device accessory'
    )
    .replace(/\blithium\s+(?:batter(?:y|ies)|cells?)\b/giu, 'device battery');
  if (bodyNamesProhibitedDrug(checkedBody, [...prohibitedNames(rows), ...PROHIBITED_DRUG_NAMES])) {
    throw new ProhibitedDrugInCopy();
  }
}
