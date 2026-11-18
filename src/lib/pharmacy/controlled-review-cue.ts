/**
 * DEV-854 — legacy controlled-drug review cues.
 *
 * Legacy exports carry a free-text "class" (mostly distributor names, plus a
 * NARCOTICS class) and a misspelled "category". Neither is a regulatory fact,
 * so neither may set a controlled flag. They are only a cue that a registered
 * pharmacist must classify the item before it can be sold. Everything here is a
 * pure function shared by the staging import, the reference workbench preview
 * and the server, so all three agree on which rows are held for review.
 */

/** Written to a staged row's `__review_flags` when any cue below matches. */
export const CONTROLLED_REVIEW_FLAG = 'SUSPECTED_CONTROLLED_PHARMACIST_REVIEW';

export type ControlledReviewCue =
  | 'LEGACY_CLASS_NARCOTICS'
  | 'LEGACY_CLASS_CONTROLLED_TERM'
  | 'LEGACY_CATEGORY_CONTROLLED_TERM'
  | 'NAME_SUGGESTS_CONTROLLED_SUBSTANCE';

export type ControlledReviewInput = {
  legacyClass?: string | null;
  legacyCategory?: string | null;
  productName?: string | null;
  alias?: string | null;
};

/** Lowercase letters only, so "NARCOTICS", "Narcotic Drugs" and "narcotcs" compare alike. */
function letters(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Lowercase words, for whole-word substance matching in product names. */
function words(value: string | null | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

// "narc" covers NARCOTICS, NARCOTIC, NARCOTCS, NARCOTICS DRUGS; "narko" a common misspelling.
const NARCOTICS_STEMS = ['narc', 'narko'];
// Free-text terms that suggest a controlled schedule in a class or category column.
const CONTROLLED_TERMS = [
  'psychotrop',
  'controlled',
  'opioid',
  'opiate',
  'benzodiazepin',
  'sedativ',
  'hypnotic',
];

/**
 * Substances commonly scheduled as narcotic or psychotropic. A match is only a
 * suspicion for a pharmacist to confirm or dismiss; it never sets a flag.
 */
const SUSPECTED_SUBSTANCES = new Set([
  'alprazolam',
  'bromazepam',
  'buprenorphine',
  'chlordiazepoxide',
  'clobazam',
  'clonazepam',
  'codeine',
  'dextropropoxyphene',
  'diazepam',
  'fentanyl',
  'hydrocodone',
  'ketamine',
  'lorazepam',
  'methadone',
  'methylphenidate',
  'midazolam',
  'morphine',
  'nalbuphine',
  'nitrazepam',
  'oxazepam',
  'oxycodone',
  'pentazocine',
  'pethidine',
  'phenobarbital',
  'phenobarbitone',
  'tapentadol',
  'temazepam',
  'tramadol',
  'zolpidem',
]);

/** The reasons a row is held for pharmacist classification; empty when none apply. */
export function controlledReviewCues(input: ControlledReviewInput): ControlledReviewCue[] {
  const cues: ControlledReviewCue[] = [];
  const legacyClass = letters(input.legacyClass);
  const legacyCategory = letters(input.legacyCategory);
  if (NARCOTICS_STEMS.some((stem) => legacyClass.includes(stem))) {
    cues.push('LEGACY_CLASS_NARCOTICS');
  } else if (CONTROLLED_TERMS.some((term) => legacyClass.includes(term))) {
    cues.push('LEGACY_CLASS_CONTROLLED_TERM');
  }
  if ([...NARCOTICS_STEMS, ...CONTROLLED_TERMS].some((term) => legacyCategory.includes(term))) {
    cues.push('LEGACY_CATEGORY_CONTROLLED_TERM');
  }
  if (
    [...words(input.productName), ...words(input.alias)].some((w) => SUSPECTED_SUBSTANCES.has(w))
  ) {
    cues.push('NAME_SUGGESTS_CONTROLLED_SUBSTANCE');
  }
  return cues;
}

const CLASS_HEADERS = ['classname', 'class', 'itemclass', 'productclass', 'drugclass'];
const CATEGORY_HEADERS = ['category', 'categoryname', 'cat', 'itemcategory', 'productcategory'];

/** Finds the legacy class and category cells in a staged row by header name. */
export function legacyGroupingCells(raw: Readonly<Record<string, unknown>>): {
  legacyClass: string | null;
  legacyCategory: string | null;
} {
  const find = (candidates: readonly string[]) => {
    for (const [header, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || header.startsWith('__')) continue;
      if (candidates.includes(letters(header))) return value;
    }
    return null;
  };
  return { legacyClass: find(CLASS_HEADERS), legacyCategory: find(CATEGORY_HEADERS) };
}
