/**
 * Platform default medicine catalogue — "does this pharmacy already hold it?"
 *
 * Pure: no database, no Node APIs. The materialiser and the backfill dry run
 * both decide likely duplicates with exactly this code, so what the dry run
 * lists is what the apply links.
 *
 * A catalogue item is a likely duplicate of a medicine the pharmacy entered by
 * hand (manual entry, the importer wizard, a reference connector) when ALL of:
 *
 *  - NAME. A normalised brand or product name of the item equals a normalised
 *    brand or product name of the medicine. Normalising drops case and every
 *    character that is not an ASCII letter or digit, so `DISPRIN  300MG TAB`
 *    and `Disprin 300mg Tab` agree. The database prefilter uses the same rule
 *    ({@link CATALOGUE_NAME_KEY_SQL_PATTERN}).
 *  - STRENGTH. The item's strength equals the medicine's structured strength
 *    (numbers compared by value, units case-insensitively), or both have none.
 *    A hand-entered medicine often carries its strength only in its name, so a
 *    strength missing on one side also agrees when the other side's strength
 *    is a whole token of the shared name (`300mg` in `disprin300mgtab`, never
 *    `1mg` in `bremax11mgtab`).
 *  - DOSAGE FORM. The item's dosage form equals one of the medicine's
 *    presentation dosage forms, or both have none.
 *  - MANUFACTURER, IF PRESENT. When both sides name a manufacturer they must
 *    agree; when either side has none it is not compared.
 *
 * Every match carries a human-readable reason naming each rule it passed.
 *
 * A linked medicine inherits the item's NARCOTICS review flag
 * ({@link linkedControlledCandidate}), exactly as a catalogue copy does, and is
 * held from sale until it is reviewed ({@link linkedHoldsFromSale}).
 */

export type CatalogueMatchItem = {
  sourceKey: string;
  productName: string;
  brandName: string | null;
  manufacturer: string | null;
  strength: string | null;
  dosageForm: string | null;
};

export type HandEnteredMedicine = {
  id: string;
  productName: string;
  brandName: string | null;
  manufacturer: string | null;
  /** Structured strength components (`MedicineStrengthComponent`). */
  strengths: ReadonlyArray<{ value: { toString(): string } | number | string; unit: string }>;
  /** `dosageForm` of each of the medicine's presentations. */
  dosageForms: ReadonlyArray<string | null>;
};

export type HandEnteredMatch<M extends HandEnteredMedicine = HandEnteredMedicine> = {
  medicine: M;
  reason: string;
};

/**
 * The regular expression the database prefilter strips with, so SQL and
 * {@link catalogueNameKey} normalise identically:
 * `lower(regexp_replace(name, '[^A-Za-z0-9]+', '', 'g'))`.
 */
export const CATALOGUE_NAME_KEY_SQL_PATTERN = '[^A-Za-z0-9]+';

/** Case-, space- and punctuation-insensitive comparison key for a name. */
export function catalogueNameKey(value: string | null | undefined): string {
  return (value ?? '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
}

function canonicalNumbers(value: string): string {
  return value.replace(/\d+(?:\.\d+)?/g, (number) => String(Number(number)));
}

/** `300 MG` → `300mg`; `0.50MG` → `0.5mg`; `500MG/5ML` → `500mg/5ml`. */
export function catalogueStrengthKey(value: string | null | undefined): string {
  return canonicalNumbers((value ?? '').replace(/[^A-Za-z0-9.%/+]+/g, '').toLowerCase());
}

function medicineStrengthKey(medicine: HandEnteredMedicine): string {
  return medicine.strengths
    .map(
      ({ value, unit }) =>
        `${canonicalNumbers(String(value))}${unit.replace(/[^A-Za-z0-9%]+/g, '').toLowerCase()}`
    )
    .sort()
    .join('+');
}

/** Whether `token` appears in `text` without a digit glued to either end of it. */
function containsToken(text: string, token: string): boolean {
  if (!token) return false;
  const digit = /\d/;
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    const before = text[at - 1];
    const after = text[at + token.length];
    if (before && digit.test(before)) continue;
    if (after && digit.test(token[token.length - 1]!) && digit.test(after)) continue;
    return true;
  }
  return false;
}

function names(row: { productName: string; brandName: string | null }) {
  return [
    { field: 'productName', key: catalogueNameKey(row.productName) },
    { field: 'brandName', key: catalogueNameKey(row.brandName) },
  ].filter((entry) => entry.key);
}

/**
 * Why `item` is a likely duplicate of `medicine`, or null when it is not.
 * See the module comment for the rules.
 */
export function handEnteredMatchReason(
  item: CatalogueMatchItem,
  medicine: HandEnteredMedicine
): string | null {
  const medicineNames = names(medicine);
  let shared: { key: string; itemField: string; medicineField: string } | null = null;
  for (const itemName of names(item)) {
    const hit = medicineNames.find((entry) => entry.key === itemName.key);
    if (hit) {
      shared = { key: itemName.key, itemField: itemName.field, medicineField: hit.field };
      break;
    }
  }
  if (!shared) return null;
  const reasons = [
    `name "${shared.key}" (catalogue ${shared.itemField} = medicine ${shared.medicineField})`,
  ];

  const itemStrength = catalogueStrengthKey(item.strength);
  const ownStrength = medicineStrengthKey(medicine);
  if (itemStrength === ownStrength) {
    reasons.push(itemStrength ? `strength ${itemStrength}` : 'no strength on either side');
  } else if (!ownStrength && containsToken(shared.key, catalogueNameKey(itemStrength))) {
    reasons.push(`strength ${itemStrength} (in the medicine's name; no structured strength)`);
  } else if (!itemStrength && containsToken(shared.key, catalogueNameKey(ownStrength))) {
    reasons.push(`strength ${ownStrength} (in the catalogue name; catalogue has none)`);
  } else {
    return null;
  }

  const itemForm = catalogueNameKey(item.dosageForm);
  const forms = medicine.dosageForms.map(catalogueNameKey).filter(Boolean);
  if (!(forms.length ? forms : ['']).includes(itemForm)) return null;
  reasons.push(itemForm ? `dosage form ${itemForm}` : 'no dosage form on either side');

  const itemMaker = catalogueNameKey(item.manufacturer);
  const ownMaker = catalogueNameKey(medicine.manufacturer);
  if (itemMaker && ownMaker) {
    if (itemMaker !== ownMaker) return null;
    reasons.push(`manufacturer ${itemMaker}`);
  } else {
    const missing = itemMaker ? 'the medicine' : ownMaker ? 'the catalogue item' : 'either side';
    reasons.push(`manufacturer not compared (none on ${missing})`);
  }
  return reasons.join('; ');
}

/** Every medicine `item` is a likely duplicate of, in ascending id order. */
export function findHandEnteredMatches<M extends HandEnteredMedicine>(
  item: CatalogueMatchItem,
  medicines: readonly M[]
): HandEnteredMatch<M>[] {
  const matches: HandEnteredMatch<M>[] = [];
  for (const medicine of medicines) {
    const reason = handEnteredMatchReason(item, medicine);
    if (reason) matches.push({ medicine, reason });
  }
  return matches.sort((left, right) =>
    left.medicine.id < right.medicine.id ? -1 : left.medicine.id > right.medicine.id ? 1 : 0
  );
}

/** The distinct, non-empty name keys the database prefilter looks a batch up by. */
export function catalogueNameKeys(items: readonly CatalogueMatchItem[]): string[] {
  return [...new Set(items.flatMap((item) => names(item).map((entry) => entry.key)))];
}

/**
 * The NARCOTICS review flag (`controlledCandidate`) the provenance row linking a
 * hand-entered medicine to `item` carries — the same flag a catalogue copy
 * carries, which holds the medicine for a pharmacist's reviewed `controlled`
 * decision before it can be published saleable. Set when the item was filed
 * under NARCOTICS; a medicine already flagged stays flagged.
 */
export function linkedControlledCandidate(
  item: { controlledCandidate: boolean },
  medicine: { controlledCandidate?: boolean | null }
): boolean {
  return item.controlledCandidate || medicine.controlledCandidate === true;
}

/**
 * Whether linking a hand-entered medicine holds it from sale (`saleable: false`).
 * A catalogue copy starts unsaleable and the publication hold keeps it so until
 * a pharmacist publishes a reviewed `controlled` decision; a hand-entered
 * medicine may already sell, so a flagged link holds it until the same review.
 * Never for a link without the NARCOTICS flag, a medicine that is not saleable
 * (nothing to hold), or one whose reviewed `controlled` decision is already
 * published (it has had that review).
 */
export function linkedHoldsFromSale(
  controlledCandidate: boolean,
  medicine: { saleable: boolean; controlledReviewed: boolean }
): boolean {
  return controlledCandidate && medicine.saleable && !medicine.controlledReviewed;
}
